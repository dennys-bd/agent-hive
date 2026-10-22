// Canonical JSON (#459, moved by #462): one text per value on every machine, keys sorted by code point, so its hash is stable. Free of
// node: imports, so the dashboard hashes an arm's tasks exactly as hash.ts hashes the base's.
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => byCodePoint(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const HEX = 16;
const BYTE_DIGITS = 2;

/** sha256 of a text, hex, through Web Crypto: the browser and Node 24 both hold it, node:crypto only the server. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(HEX).padStart(BYTE_DIGITS, '0')).join('');
}
