import "../helpers/env";
import { describe, expect, it } from "vitest";
import { Fetcher, FetchError, hostAllowed, isPrivateAddress } from "../../src/lib/http/fetcher";
import { isDisallowedByRobots, parseRobots } from "../../src/lib/http/robots";
import { FixtureNet } from "../helpers/fixtures";

function make(net: FixtureNet, extra: Partial<ConstructorParameters<typeof Fetcher>[0]> = {}) {
  return new Fetcher({ transport: net.transport, allowedHosts: () => ["sebi.gov.in"], resolveHost: async () => ["203.0.113.5"], minIntervalMs: 0, respectRobots: false, sleep: async () => {}, ...extra });
}

describe("fetcher safety", () => {
  it("allows only approved hosts and their subdomains", () => {
    expect(hostAllowed("www.sebi.gov.in", ["sebi.gov.in"])).toBe(true);
    expect(hostAllowed("evilsebi.gov.in", ["sebi.gov.in"])).toBe(false);
    expect(hostAllowed("sebi.gov.in.evil.com", ["sebi.gov.in"])).toBe(false);
  });
  it("identifies private address ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress("203.0.113.5")).toBe(false);
  });
  it("rejects disallowed hosts, IP literals and private resolutions", async () => {
    const net = new FixtureNet();
    await expect(make(net).fetch("https://example.com/x")).rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(make(net).fetch("http://169.254.169.254/latest")).rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(make(net, { resolveHost: async () => ["10.0.0.5"] }).fetch("https://www.sebi.gov.in/")).rejects.toMatchObject({ code: "private_address" });
    expect(net.requests).toHaveLength(0);
  });
  it("re-validates every redirect hop", async () => {
    const net = new FixtureNet().set("https://www.sebi.gov.in/r", { status: 302, body: "", headers: { location: "https://attacker.example/steal" } });
    await expect(make(net).fetch("https://www.sebi.gov.in/r")).rejects.toMatchObject({ code: "host_not_allowed" });
  });
  it("retries transient failures, then succeeds", async () => {
    let n = 0;
    const net = new FixtureNet().set("https://www.sebi.gov.in/flaky", () => (++n < 3 ? { status: 503, body: "" } : { body: "ok" }));
    const res = await make(net).fetch("https://www.sebi.gov.in/flaky");
    expect(res.body.toString()).toBe("ok");
    expect(n).toBe(3);
  });
  it("does not retry permanent failures", async () => {
    const net = new FixtureNet();
    await expect(make(net).fetch("https://www.sebi.gov.in/missing")).rejects.toBeInstanceOf(FetchError);
    expect(net.requests).toHaveLength(1);
  });
  it("enforces the size cap", async () => {
    const net = new FixtureNet().set("https://www.sebi.gov.in/big", { body: Buffer.alloc(5000) });
    await expect(make(net).fetch("https://www.sebi.gov.in/big", { maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
  });
  it("respects robots.txt", async () => {
    const net = new FixtureNet()
      .set("https://www.sebi.gov.in/robots.txt", { body: "User-agent: *\nDisallow: /private/\n", contentType: "text/plain" })
      .set("https://www.sebi.gov.in/private/x", { body: "secret" });
    await expect(make(net, { respectRobots: true }).fetch("https://www.sebi.gov.in/private/x")).rejects.toMatchObject({ code: "robots_disallowed" });
  });
  it("supports conditional requests (304)", async () => {
    const net = new FixtureNet().set("https://www.sebi.gov.in/c", { status: 304, body: "" });
    const res = await make(net).fetch("https://www.sebi.gov.in/c", { etag: '"x"' });
    expect(res.notModified).toBe(true);
  });
});

describe("robots parser", () => {
  const rules = parseRobots("User-agent: FIRegLibraryBot\nDisallow: /a\nAllow: /a/ok\n\nUser-agent: *\nDisallow: /\n");
  it("uses the most specific group and longest match", () => {
    expect(isDisallowedByRobots(rules, "FIRegLibraryBot/0.1", "/a/x")).toBe(true);
    expect(isDisallowedByRobots(rules, "FIRegLibraryBot/0.1", "/a/ok/1")).toBe(false);
    expect(isDisallowedByRobots(rules, "FIRegLibraryBot/0.1", "/b")).toBe(false);
    expect(isDisallowedByRobots(rules, "OtherBot", "/b")).toBe(true);
  });
});
