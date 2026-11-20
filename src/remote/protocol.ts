export const REMOTE_PROTOCOL_VERSION = 1;
export const CHANNEL = { control: 0, machine: 1, relay: 2 } as const;
export const FIRST_STREAM_CHANNEL = 3;
export const REMOTE_ERROR_CODES = ['link_closed', 'version_mismatch', 'unknown_method', 'cancelled', 'bad_frame', 'internal', 'not_supported'] as const;
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

export type HelloFrame = { ch: 0; t: 'hello'; version: number; info: unknown };
export type ByeFrame = { ch: 0; t: 'bye'; code?: string; message?: string };
export type StreamFrame = { ch: 0; t: 'open' | 'end'; stream: number };
export type RequestFrame = { ch: number; t: 'req'; id: number; method: string; params: unknown; bin?: number };
export type EventFrame = { ch: number; t: 'event'; id: number; data: unknown; bin?: number };
export type CancelFrame = { ch: number; t: 'cancel'; id: number };
export type ResponseFrame =
  | { ch: number; t: 'res'; id: number; ok: true; result: unknown; bin?: number }
  | { ch: number; t: 'res'; id: number; ok: false; code: string; message: string; data?: unknown; bin?: number };
export type TextFrame = HelloFrame | ByeFrame | StreamFrame | RequestFrame | EventFrame | CancelFrame | ResponseFrame;
export type BinaryFrame = { ch: number; bytes: Uint8Array };

// The mux of #138 section 5, on no transport (#936): frames out through `send`, frames in through `receive`. Pure and free of node: so the
// distro's helper (4.3) and #162's browser link share it; bytes are Uint8Array, never Buffer.
const CHANNEL_BYTES = 4;
type Fields = Record<string, unknown>;
const isRecord = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isString = (v: unknown): v is string => typeof v === 'string';
const isOpt = (v: unknown, check: (x: unknown) => boolean): boolean => v === undefined || check(v);
const isStream = (v: unknown): boolean => isUint(v) && v >= FIRST_STREAM_CHANNEL;

// what each `t` must carry; which channel a call may use is the mux's check
const SHAPES: Record<TextFrame['t'], (f: Fields) => boolean> = {
  hello: (f) => f.ch === CHANNEL.control && typeof f.version === 'number',
  bye: (f) => f.ch === CHANNEL.control && isOpt(f.code, isString) && isOpt(f.message, isString),
  open: (f) => f.ch === CHANNEL.control && isStream(f.stream),
  end: (f) => f.ch === CHANNEL.control && isStream(f.stream),
  req: (f) => isUint(f.id) && isString(f.method) && isOpt(f.bin, isUint),
  event: (f) => isUint(f.id) && isOpt(f.bin, isUint),
  cancel: (f) => isUint(f.id),
  res: (f) => isUint(f.id) && isOpt(f.bin, isUint) && (f.ok === true || (f.ok === false && isString(f.code) && isString(f.message))),
};

export function encode(frame: TextFrame | BinaryFrame): string | Uint8Array {
  if (!('bytes' in frame)) return JSON.stringify(frame);
  const out = new Uint8Array(CHANNEL_BYTES + frame.bytes.length);
  new DataView(out.buffer).setUint32(0, frame.ch);
  out.set(frame.bytes, CHANNEL_BYTES);
  return out;
}

export function decode(data: string | Uint8Array): TextFrame | BinaryFrame | { error: string } {
  if (typeof data !== 'string') {
    if (data.length < CHANNEL_BYTES) return { error: `a binary frame of ${data.length} bytes has no channel` };
    return { ch: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0), bytes: data.subarray(CHANNEL_BYTES) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { error: 'a text frame that is not JSON' };
  }
  // Object.hasOwn: a `t` of "toString" names no shape
  if (!isRecord(parsed) || !isUint(parsed.ch) || !isString(parsed.t) || !Object.hasOwn(SHAPES, parsed.t)) return { error: 'a text frame of no known type' };
  if (!SHAPES[parsed.t as TextFrame['t']](parsed)) return { error: `a malformed ${parsed.t} frame` };
  return parsed as TextFrame;
}

export class RemoteError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.data = data;
  }
}
