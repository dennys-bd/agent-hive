// The mux over a byte stream (#936): [4-byte big-endian length][1-byte kind][body], the length counting kind and body. Over the wsl.exe pipe
// (4.3, 5.3) one frame arrives in any number of chunks. Free of node: so the distro's helper and a browser can share it.
export const MAX_STDIO_FRAME_BYTES = 64 * 1024 * 1024;

const LENGTH_BYTES = 4;
const HEADER_BYTES = LENGTH_BYTES + 1;
const KIND_TEXT = 0;
const KIND_BINARY = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true }); // a BOM is the text's own character, not the decoder's to eat

export function encodeStdioFrame(data: string | Uint8Array): Uint8Array {
  const body = typeof data === 'string' ? encoder.encode(data) : data;
  // the sender's bug, thrown here: the peer's decoder would refuse it and stop the whole link
  if (body.length + 1 > MAX_STDIO_FRAME_BYTES) throw new RangeError(`a frame body of ${body.length} bytes is over the cap of ${MAX_STDIO_FRAME_BYTES}`);
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length + 1);
  frame[LENGTH_BYTES] = typeof data === 'string' ? KIND_TEXT : KIND_BINARY;
  frame.set(body, HEADER_BYTES);
  return frame;
}

function headerProblem(length: number, kind: number, maxFrameBytes: number): string | undefined {
  if (length > maxFrameBytes) return `a frame of ${length} bytes is over the cap of ${maxFrameBytes}`;
  if (length === 0) return 'a frame with no kind byte';
  if (kind !== KIND_TEXT && kind !== KIND_BINARY) return `a frame of unknown kind ${kind}`;
  return undefined;
}

// The bytes pushed and not framed yet. A frame is copied out once, when its last byte is in, so a chunk split at every offset costs one copy
function createChunks() {
  const queue: Uint8Array[] = [];
  let size = 0;
  const drop = (n: number): void => {
    size -= n;
    let left = n;
    while (left > 0) {
      const head = queue[0];
      if (head.length > left) {
        queue[0] = head.subarray(left);
        return;
      }
      queue.shift();
      left -= head.length;
    }
  };
  const read = (n: number, consume: boolean): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0, at = 0; at < n; i += 1) {
      const part = queue[i].subarray(0, n - at);
      out.set(part, at);
      at += part.length;
    }
    if (consume) drop(n);
    return out;
  };
  return {
    add: (chunk: Uint8Array): void => {
      queue.push(chunk);
      size += chunk.length;
    },
    size: (): number => size,
    peek: (n: number): Uint8Array => read(n, false),
    take: (n: number): Uint8Array => read(n, true),
    clear: (): void => {
      queue.length = 0;
      size = 0;
    },
  };
}

export function createStdioDecoder(
  onFrame: (data: string | Uint8Array) => void,
  onError: (message: string) => void,
  opts: { maxFrameBytes?: number } = {},
): { push(chunk: Uint8Array): void } {
  const maxFrameBytes = opts.maxFrameBytes ?? MAX_STDIO_FRAME_BYTES;
  const chunks = createChunks();
  let stopped = false;
  const readOne = (): boolean => {
    if (chunks.size() < HEADER_BYTES) return false;
    const header = chunks.peek(HEADER_BYTES);
    const length = new DataView(header.buffer).getUint32(0);
    const kind = header[LENGTH_BYTES];
    const problem = headerProblem(length, kind, maxFrameBytes);
    if (problem !== undefined) {
      // after a corrupt header the next frame's start cannot be found again: stop, and let the transport's owner end the link
      stopped = true;
      chunks.clear();
      onError(problem);
      return false;
    }
    if (chunks.size() < LENGTH_BYTES + length) return false;
    const body = chunks.take(LENGTH_BYTES + length).subarray(HEADER_BYTES);
    // a consumer's throw must not drop the frames after it in this chunk
    try {
      onFrame(kind === KIND_TEXT ? decoder.decode(body) : body);
    } catch (err) {
      try {
        onError(`the frame consumer threw: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // the last callback to fail has nowhere to report to
      }
    }
    return true;
  };
  return {
    push(chunk) {
      if (stopped || chunk.length === 0) return;
      chunks.add(chunk);
      for (let more = readOne(); more && !stopped; more = readOne());
    },
  };
}
