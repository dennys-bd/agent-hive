// The local machine's disk (#158, split out by #161): node:fs/promises as MachineFs, with readFile's cap, writeAtomic and readLines, and the watch (#935). A file
// of its own so a host-only reader (codex-limits.ts: the account's plan limits) takes the host's disk without importing machine-local.ts,
// whose pty half reaches agents/registry.ts and back: that cycle would read localFs before it is defined.
import { randomBytes } from 'node:crypto';
import { createReadStream, type FSWatcher, watch as fsWatch } from 'node:fs';
import { access, appendFile, chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Machine, MachineError, type MachineFs, toMachineError } from './machine.js';
import { replaceFile } from './replace-file.js';

const MODE_BITS = 0o7777;

const tooLarge = (maxBytes: number): MachineError => new MachineError(`file over ${maxBytes} bytes`, { code: MachineError.TOO_LARGE });

// Only a regular file's size means anything (a FIFO or a device would hold the read forever), so it is checked before the cap
async function checkFile(path: string, maxBytes: number): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new MachineError(`not a regular file: ${path}`, { code: MachineError.NOT_FILE });
  if (info.size > maxBytes) throw tooLarge(maxBytes);
}

// The cap is checked on the stat, so an oversized file is never read; and again on the bytes, for a file that grew in between
function readCapped(path: string, options: { maxBytes: number; encoding: BufferEncoding }): Promise<string>;
function readCapped(path: string, options: { maxBytes: number }): Promise<Buffer>;
async function readCapped(path: string, { maxBytes, encoding }: { maxBytes: number; encoding?: BufferEncoding }): Promise<string | Buffer> {
  await checkFile(path, maxBytes);
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw tooLarge(maxBytes);
  return encoding === undefined ? bytes : bytes.toString(encoding);
}

// A stream through readline, so a transcript costs one line of memory, as eachLine's did. A generator: a refusal rejects the first next(),
// and a loop's break (return()) runs the finally, which closes the stream.
// ponytail: the cap holds on the stat only; a file that grows past it while it is read is read to its end. Count the stream's bytes if a
// remote machine ever needs the hard bound
async function* readLines(path: string, { maxBytes }: { maxBytes: number }): AsyncGenerator<string> {
  await checkFile(path, maxBytes);
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    yield* lines;
  } finally {
    lines.close();
    input.destroy();
  }
}

// Lifted from server-editor.ts' writeAtomic, which 7.3 deletes when it switches to this one: the text in a temp file beside the original,
// with the original's mode, renamed over it, so a reader never sees half a file; a failure leaves no temp file
async function writeAtomic(file: string, contents: string): Promise<Buffer> {
  const bytes = Buffer.from(contents, 'utf8');
  const mode = (await stat(file)).mode & MODE_BITS;
  const temp = join(dirname(file), `.${basename(file)}.hive-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); // private until the chmod gives it the original's mode
    await chmod(temp, mode); // writeFile's mode goes through the umask; chmod sets the original's exactly
    await replaceFile(temp, file);
    return bytes;
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export const localFs: MachineFs = {
  stat, lstat, realpath, access, readdir, readFile: readCapped, readLines, writeFile, writeAtomic, mkdir, mkdtemp, rename, rm, cp, copyFile, link, chmod, unlink, appendFile,
};

/** The local machine's watch (#935): node's fs.watch behind Machine.watch's contract. persistent: false, as #502's was: a watch is never
 *  what keeps the daemon alive. */
export const localWatch: Machine['watch'] = (path, { recursive }, onEvent, onError) => {
  let isClosed = false;
  let watcher: FSWatcher | undefined;
  const fail = (err: unknown): void => {
    if (isClosed) return; // at most once, and never after close()
    isClosed = true;
    watcher?.close();
    onError(toMachineError(err));
  };
  try {
    watcher = fsWatch(path, { recursive, persistent: false, encoding: 'utf8' }, (_eventType, filename) => {
      if (!isClosed) onEvent(filename);
    });
    watcher.on('error', fail);
  } catch (err) {
    queueMicrotask(() => fail(err)); // ENOSPC, ENOENT: after watch returned, as a remote watch's start-up failure arrives
  }
  return { close: () => { isClosed = true; watcher?.close(); } };
};
