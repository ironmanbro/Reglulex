import "../helpers/env";
import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "../../src/lib/auth";
import { hashPassword, verifyPassword } from "../../src/lib/password";
import { rateLimit } from "../../src/lib/rate-limit";

describe("admin auth", () => {
  it("hashes and verifies passwords with scrypt", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong password!!", h)).toBe(false);
    expect(await verifyPassword("x", undefined)).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow();
  });
  it("signs sessions and rejects tampering and expiry", async () => {
    const t = await signSession("admin");
    expect((await verifySession(t))?.u).toBe("admin");
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "root", exp: 9999999999 })).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`)).toBeNull();
    expect(await verifySession(`${body}.AAAA`)).toBeNull();
    expect(await verifySession(t, Date.now() + 13 * 3600_000)).toBeNull();
    expect(await verifySession(undefined)).toBeNull();
  });
  it("refuses to sign without a strong secret", async () => {
    const old = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "short";
    await expect(signSession("admin")).rejects.toThrow();
    expect(await verifySession("a.b")).toBeNull();
    process.env.SESSION_SECRET = old;
  });
  it("rate-limits", () => {
    const k = `t${Math.random()}`;
    for (let i = 0; i < 5; i++) expect(rateLimit(k, 5, 1000).ok).toBe(true);
    expect(rateLimit(k, 5, 1000).ok).toBe(false);
  });
});
