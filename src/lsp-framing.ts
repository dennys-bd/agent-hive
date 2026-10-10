// LSP's base protocol over a server's stdio (#780): a Content-Length header in bytes, a blank line, the JSON body.

const HEADER_END = '\r\n\r\n';
const HEADER_MAX = 8 * 1024;
const BODY_MAX = 64 * 1024 * 1024;
const LENGTH = /^content-length: *(\d+)$/im;

/** One message as a frame for a server's stdin. */
export function frame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_END}`, 'ascii'), body]);
}

/** A stdout reader: chunks in, whole messages out; a frame it cannot read is reported and dropped, the next one still read. A header or a
 * body past its cap is fatal (a stream that lost its framing, or a runaway server): onFatal runs once and the rest of the stream is ignored. */
export function createDecoder(onMessage: (message: unknown) => void, onError: (reason: string) => void, onFatal: (reason: string) => void = onError): (chunk: Buffer) => void {
  let chunks: Buffer[] = [];
  let size = 0;
  let need = 0; // bytes the open frame still needs: a body arriving in many chunks is joined once, not once per chunk
  let isDead = false;
  const fatal = (reason: string): void => { isDead = true; chunks = []; onFatal(reason); };
  return (chunk) => {
    if (isDead) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size < need) return;
    let pending = Buffer.concat(chunks);
    for (;;) {
      const end = pending.indexOf(HEADER_END);
      if (end < 0) {
        if (pending.length > HEADER_MAX) return fatal('a frame header past its cap');
        break;
      }
      const match = LENGTH.exec(pending.subarray(0, end).toString('ascii'));
      const start = end + HEADER_END.length;
      if (!match) {
        pending = pending.subarray(start);
        onError('a frame without Content-Length');
        continue;
      }
      const length = Number(match[1]);
      if (length > BODY_MAX) return fatal('a frame body past its cap');
      if (pending.length < start + length) {
        need = start + length;
        break;
      }
      const body = pending.subarray(start, start + length).toString('utf8');
      pending = pending.subarray(start + length);
      need = 0;
      try {
        onMessage(JSON.parse(body));
      } catch {
        onError('a frame that is not JSON');
      }
    }
    chunks = [pending];
    size = pending.length;
  };
}
