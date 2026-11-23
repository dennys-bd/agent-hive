// Shared by both ends of the hooks and MCP relay (#940): which headers belong to one hop and what a header map must look like to cross.
import { isRecord, isString } from '../remote/frames.js';

export type RelayHeaders = Record<string, string | string[]>;

// RFC 9110 hop-by-hop headers: each hop of the relay opens its own connection, so none of them may be carried across
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// header names arrive lower-cased from node:http; `drop` lets a caller take more names out (cookie, host, content-length)
export function relayableHeaders(headers: Record<string, string | string[] | undefined>, drop: readonly string[] = []): RelayHeaders {
  const out: RelayHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !drop.includes(name)) out[name] = value;
  }
  return out;
}

export const isRelayHeaders = (v: unknown): v is RelayHeaders =>
  isRecord(v) && Object.values(v).every((value) => isString(value) || (Array.isArray(value) && value.every(isString)));

// Both ends check it, so a path that reaches the Hive's own API through a dot segment, an encoded separator or a doubled slash is refused twice
export const isRelayPath = (path: string): boolean => /^\/hooks\//.test(path) && !/\.\.|%2e|%2f|%5c|\\|\/\//i.test(path);
