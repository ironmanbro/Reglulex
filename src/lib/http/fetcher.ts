import { lookup } from "node:dns/promises";
import net from "node:net";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { env } from "../env";
import { log } from "../log";
import { isDisallowedByRobots, parseRobots, type RobotsRules } from "./robots";

export class FetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "host_not_allowed"
      | "private_address"
      | "bad_url"
      | "robots_disallowed"
      | "timeout"
      | "network"
      | "http_status"
      | "too_large"
      | "too_many_redirects",
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export interface FetchResult {
  requestedUrl: string;
  url: string; // final URL after redirects
  status: number;
  notModified: boolean;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface FetchOptions {
  method?: "GET" | "POST";
  form?: Record<string, string>;
  headers?: Record<string, string>;
  etag?: string | null;
  lastModified?: string | null;
  maxBytes?: number;
  /** Treat these HTTP statuses as a normal (non-throwing) result. */
  acceptStatuses?: number[];
}

/** Minimal transport contract so tests can substitute recorded fixtures for the network. */
export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }>;

export interface FetcherDeps {
  transport?: Transport;
  allowedHosts: () => Promise<string[]> | string[];
  resolveHost?: (host: string) => Promise<string[]>;
  minIntervalMs?: number;
  respectRobots?: boolean;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dispatcher: Dispatcher | undefined;
function defaultDispatcher(): Dispatcher {
  if (!dispatcher) {
    const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
    dispatcher = proxied ? new EnvHttpProxyAgent() : new Agent({ connect: { timeout: 20_000 } });
  }
  return dispatcher;
}

const defaultTransport: Transport = async (url, init) => {
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: "manual",
    dispatcher: defaultDispatcher(),
  });
  return { status: res.status, headers: res.headers as unknown as Headers, body: res.body as ReadableStream<Uint8Array> | null };
};

async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((a) => {
    const d = a.toLowerCase().replace(/^\*\./, "");
    return h === d || h.endsWith("." + d);
  });
}

/**
 * Outbound HTTP client for crawling. Enforces: host allowlist, no private addresses,
 * robots.txt, per-host politeness delay, timeouts, size cap, bounded retries with
 * exponential backoff, and manual redirect handling that re-validates every hop.
 */
export class Fetcher {
  private nextSlot = new Map<string, number>();
  private robots = new Map<string, { rules: RobotsRules | null; fetchedAt: number }>();
  private readonly transport: Transport;
  private readonly resolveHost: (h: string) => Promise<string[]>;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly stats = { requests: 0, retries: 0, bytes: 0 };

  constructor(private readonly deps: FetcherDeps) {
    this.transport = deps.transport ?? defaultTransport;
    this.resolveHost = deps.resolveHost ?? defaultResolve;
    this.sleep = deps.sleep ?? realSleep;
  }

  private get userAgent() {
    return env().CRAWLER_USER_AGENT;
  }

  async validateUrl(raw: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new FetchError(`Invalid URL: ${raw}`, "bad_url", false);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new FetchError(`Unsupported scheme: ${u.protocol}`, "bad_url", false);
    if (u.username || u.password) throw new FetchError("Credentials in URL are not allowed", "bad_url", false);
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) throw new FetchError("IP-literal hosts are not allowed", "host_not_allowed", false);
    const allowed = await this.deps.allowedHosts();
    if (!hostAllowed(u.hostname, allowed)) throw new FetchError(`Host not in allowlist: ${u.hostname}`, "host_not_allowed", false);
    // When an egress proxy is configured, DNS is resolved by the proxy; the allowlist above still applies.
    const proxied = !this.deps.transport && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
    if (!proxied) {
      let addrs: string[] = [];
      try {
        addrs = await this.resolveHost(u.hostname);
      } catch (err) {
        throw new FetchError(`DNS lookup failed for ${u.hostname}: ${(err as Error).message}`, "network", true);
      }
      if (addrs.some(isPrivateAddress)) throw new FetchError(`Host resolves to a private address: ${u.hostname}`, "private_address", false);
    }
    return u;
  }

  private async politeWait(host: string) {
    const interval = this.deps.minIntervalMs ?? env().CRAWLER_MIN_INTERVAL_MS;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + interval);
    if (slot > now) await this.sleep(slot - now);
  }

  private async checkRobots(u: URL) {
    const respect = this.deps.respectRobots ?? env().CRAWLER_RESPECT_ROBOTS === "true";
    if (!respect || u.pathname === "/robots.txt") return;
    const key = u.origin;
    let entry = this.robots.get(key);
    if (!entry || Date.now() - entry.fetchedAt > 6 * 3600_000) {
      let rules: RobotsRules | null = null;
      try {
        const res = await this.fetchOnce(new URL("/robots.txt", u.origin).toString(), { acceptStatuses: [404, 403, 410, 401] }, 512 * 1024);
        if (res.status === 200) rules = parseRobots(res.body.toString("utf8"));
      } catch (err) {
        // Unreachable robots.txt: proceed (standard crawler behaviour) but record it.
        log.warn("robots.txt unavailable", { origin: u.origin, error: (err as Error).message });
      }
      entry = { rules, fetchedAt: Date.now() };
      this.robots.set(key, entry);
    }
    if (entry.rules && isDisallowedByRobots(entry.rules, this.userAgent, u.pathname + u.search)) {
      throw new FetchError(`Disallowed by robots.txt: ${u.toString()}`, "robots_disallowed", false);
    }
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const maxAttempts = this.deps.maxAttempts ?? 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const u = await this.validateUrl(url);
        await this.checkRobots(u);
        return await this.fetchOnce(url, opts, opts.maxBytes ?? env().CRAWLER_MAX_BYTES);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof FetchError ? err.retryable : true;
        if (!retryable || attempt === maxAttempts) break;
        this.stats.retries++;
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        log.debug("fetch retry", { url, attempt, wait, error: (err as Error).message });
        await this.sleep(wait);
      }
    }
    throw lastErr;
  }

  private async fetchOnce(url: string, opts: FetchOptions, maxBytes: number): Promise<FetchResult> {
    let current = url;
    let method = opts.method ?? "GET";
    let body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
    for (let hop = 0; hop < 6; hop++) {
      const u = await this.validateUrl(current);
      await this.politeWait(u.host);
      const headers: Record<string, string> = {
        "user-agent": this.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8",
        "accept-language": "en-IN,en;q=0.9",
        ...opts.headers,
      };
      if (body) headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      if (hop === 0 && opts.etag) headers["if-none-match"] = opts.etag;
      if (hop === 0 && opts.lastModified) headers["if-modified-since"] = opts.lastModified;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env().CRAWLER_TIMEOUT_MS);
      let res: Awaited<ReturnType<Transport>>;
      this.stats.requests++;
      try {
        res = await this.transport(current, { method, headers, body, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        const aborted = controller.signal.aborted;
        throw new FetchError(
          aborted ? `Timed out fetching ${current}` : `Network error fetching ${current}: ${(err as Error).message}${causeOf(err)}`,
          aborted ? "timeout" : "network",
          true,
        );
      }

      try {
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get("location");
          await res.body?.cancel().catch(() => {});
          if (!loc) throw new FetchError(`Redirect without location from ${current}`, "http_status", false, res.status);
          current = new URL(loc, current).toString();
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
          }
          continue;
        }
        const hdrs: Record<string, string> = {};
        res.headers.forEach((v, k) => (hdrs[k] = v));
        if (res.status === 304) {
          await res.body?.cancel().catch(() => {});
          return { requestedUrl: url, url: current, status: 304, notModified: true, contentType: hdrs["content-type"] ?? "", headers: hdrs, body: Buffer.alloc(0) };
        }
        if (res.status >= 400 && !(opts.acceptStatuses ?? []).includes(res.status)) {
          await res.body?.cancel().catch(() => {});
          const retryable = res.status === 429 || res.status >= 500;
          throw new FetchError(`HTTP ${res.status} for ${current}`, "http_status", retryable, res.status);
        }
        const declared = Number(hdrs["content-length"] ?? "0");
        if (declared > maxBytes) {
          await res.body?.cancel().catch(() => {});
          throw new FetchError(`Response too large (${declared} bytes) for ${current}`, "too_large", false);
        }
        const buf = await readCapped(res.body, maxBytes, current);
        this.stats.bytes += buf.length;
        return { requestedUrl: url, url: current, status: res.status, notModified: false, contentType: hdrs["content-type"] ?? "", headers: hdrs, body: buf };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new FetchError(`Too many redirects starting at ${url}`, "too_many_redirects", false);
  }
}

function causeOf(err: unknown): string {
  const c = (err as { cause?: { code?: string; message?: string } })?.cause;
  return c ? ` (${c.code ?? ""} ${c.message ?? ""})` : "";
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, url: string): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new FetchError(`Response exceeded ${max} bytes for ${url}`, "too_large", false);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
