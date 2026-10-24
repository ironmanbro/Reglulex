import { randomBytes } from "node:crypto";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Stable, opaque, URL-safe document id: d_ + 12 base36 chars (~62 bits). */
export function newDocumentId(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += alphabet[b % 36];
  return `d_${out}`;
}
