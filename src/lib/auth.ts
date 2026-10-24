// Admin authentication. Password: scrypt hash in ADMIN_PASSWORD_HASH (never the plain
// password). Session: HMAC-SHA256-signed cookie verified with Web Crypto, so the same
// code runs in middleware and in server actions.

export const SESSION_COOKIE = "firl_admin";
export const SESSION_TTL_SECONDS = 12 * 3600;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function secret(): string | null {
  const s = process.env.SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

export interface Session {
  u: string;
  exp: number;
}

export async function signSession(username: string, now = Date.now()): Promise<string> {
  const s = secret();
  if (!s) throw new Error("SESSION_SECRET must be set (at least 32 characters)");
  const payload: Session = { u: username, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(s), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(token: string | undefined | null, now = Date.now()): Promise<Session | null> {
  const s = secret();
  if (!s || !token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(s), fromB64url(sig) as BufferSource, enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    if (typeof payload.u !== "string" || typeof payload.exp !== "number" || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}
