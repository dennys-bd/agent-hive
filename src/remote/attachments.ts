// The bytes inside a request, an event or an answer (#936): out as { $bin: i } plus that many binary frames, back as the Uint8Array. No
// base64, so a 1 MiB readFile crosses as 1 MiB. Apart from protocol.ts for its length; free of node: as it is.
type Plain = Record<string, unknown>;

// only what JSON.parse builds and callers write by hand: a Date or a class instance keeps its own toJSON
const isPlain = (value: unknown): value is Plain => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// reserved, not escaped (the spec's `$bin` row): no machine method's argument or answer has this shape
const isAttachment = (value: Plain): value is { $bin: number } => {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '$bin' && typeof value.$bin === 'number';
};

export function pack(value: unknown): { value: unknown; bins: Uint8Array[] } {
  const bins: Uint8Array[] = [];
  const walk = (v: unknown): unknown => {
    if (v instanceof Uint8Array) {
      bins.push(v);
      return { $bin: bins.length - 1 };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlain(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, walk(x)]));
  };
  return { value: walk(value), bins };
}

export function unpack(value: unknown, bins: readonly Uint8Array[]): { value: unknown } | { error: string } {
  let missing: number | undefined;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlain(v)) return v;
    if (!isAttachment(v)) return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, walk(x)]));
    const bytes = bins[v.$bin];
    if (bytes === undefined) missing = v.$bin;
    return bytes;
  };
  const out = walk(value);
  return missing === undefined ? { value: out } : { error: `attachment ${missing} is not among the frame's ${bins.length}` };
}
