// What both ends of the machine channel agree on (#937): the method list and each method's params, the shapes a Stats, a Dirent and a
// MachineError cross as, and the splitter readLines rebuilds its lines with. Pure, so the helper (#941) and the host share it. Free of
// node: like the rest of src/remote/, so the fs types are read off MachineFs, and bytes become a Buffer through the global one.
import { MachineError, type MachineErrorFields, type MachineFs, toMachineError } from '../machine.js';
import { isRecord, isString, RemoteError } from './frames.js';

// An overloaded member's ReturnType is its last overload's
export type Stats = Awaited<ReturnType<MachineFs['stat']>>;
export type BigIntStats = Awaited<ReturnType<MachineFs['lstat']>>; // lstat(path, { bigint: true })
export type Dirent = Awaited<ReturnType<MachineFs['readdir']>>[number]; // readdir(path, { withFileTypes: true })

export type Check = (value: unknown) => boolean;
const isNumber: Check = (value) => typeof value === 'number';
const isOptional = (check: Check): Check => (value) => value === undefined || check(value);
const isOptions = isOptional(isRecord);
const isData: Check = (value) => isString(value) || value instanceof Uint8Array;
const isMode: Check = (value) => isNumber(value) || isString(value);
const isStrings: Check = (value) => Array.isArray(value) && value.every(isString);
// maxBytes required: a readFile with no cap would read the whole file (MachineFs.readFile's contract)
const isCap: Check = (value) => isRecord(value) && isNumber(value.maxBytes) && isOptional(isString)(value.encoding);
const isRun: Check = (value) => isRecord(value) && isString(value.command) && isStrings(value.args) && isString(value.cwd) && isRecord(value.env);
const isWatch: Check = (value) => isRecord(value) && typeof value.recursive === 'boolean';

/** Every MachineFs member that crosses, as `fs.<member>`; readLines crosses as readFile (#937). */
export type FsMethod = Exclude<keyof MachineFs, 'readLines'>;
/** Each method's arguments in order, as the server checks them: one left out is undefined, which only an optional check takes. A Record,
 *  so a member MachineFs gains fails tsc here until it crosses. */
export const FS_PARAMS: Record<FsMethod, readonly Check[]> = {
  stat: [isString], lstat: [isString, isOptions], realpath: [isString], access: [isString, isOptional(isNumber)],
  readdir: [isString, isOptions], readFile: [isString, isCap], writeFile: [isString, isData, isOptions], writeAtomic: [isString, isString],
  mkdir: [isString, isOptions], mkdtemp: [isString], rename: [isString, isString], rm: [isString, isOptions],
  cp: [isString, isString, isOptions], copyFile: [isString, isString, isOptional(isNumber)], link: [isString, isString],
  chmod: [isString, isMode], unlink: [isString], appendFile: [isString, isData, isOptions],
};
export const FS_METHODS = Object.keys(FS_PARAMS) as FsMethod[];
export const CALL_PARAMS: Record<'exec' | 'run' | 'watch', readonly Check[]> = { exec: [isString, isStrings, isOptions], run: [isRun], watch: [isString, isWatch] };
export type MachineMethod = `fs.${FsMethod}` | keyof typeof CALL_PARAMS;

export const fitsParams = (params: unknown, checks: readonly Check[]): params is unknown[] =>
  Array.isArray(params) && params.length <= checks.length && checks.every((check, i) => check(params[i]));

export const ABORT_ERR = 'ABORT_ERR'; // execFile's code for a call its signal aborted: callers read the local machine's today
const LINK_CLOSED = 'link_closed'; // the mux's code, and the reason a closed link's MachineError carries

/** A machine call's failure as the server answers it (#937): the MachineError's code as a string, its fields as data. */
export function remoteErrorOf(err: unknown): RemoteError {
  const { message, code, stderr, stdout, killed, reason } = toMachineError(err);
  const data: MachineErrorFields = { code, stderr, stdout, killed, reason };
  return new RemoteError(code === undefined ? 'internal' : String(code), message, data);
}

const textOf = (value: unknown): string | undefined => (isString(value) ? value : undefined);

/** A mux rejection as the MachineError the local machine would have thrown (#937): an exit code is a number again. */
export function machineErrorOf(err: unknown): MachineError {
  if (!(err instanceof RemoteError)) return toMachineError(err);
  if (err.code === LINK_CLOSED) return new MachineError(err.message, { code: MachineError.UNAVAILABLE, reason: LINK_CLOSED }, { cause: err });
  if (err.code === 'cancelled') return new MachineError(err.message, { code: ABORT_ERR }, { cause: err });
  const data: Record<string, unknown> = isRecord(err.data) ? err.data : {};
  const raw = data.code;
  const code = isString(raw) || typeof raw === 'number' ? raw : err.code;
  return new MachineError(err.message, { code, stderr: textOf(data.stderr), stdout: textOf(data.stdout), killed: data.killed === true, reason: textOf(data.reason) }, { cause: err });
}

/** An answer that is not its method's. The peer is the Hive's own helper, but what it sends is still checked at the boundary. */
export const badAnswer = (what: string): MachineError => new MachineError(`the machine answered no ${what}`, { code: 'bad_frame' });

const STAT_FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'] as const;
type StatField = (typeof STAT_FIELDS)[number];
type Typed = Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink'>;

const kindOf = (entry: Typed): string => (entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other');
const NO = (): boolean => false;
// The other is* (a FIFO, a socket, a device) answer false: kind names none of them
const typed = (kind: unknown) => ({
  isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink',
  isBlockDevice: NO, isCharacterDevice: NO, isFIFO: NO, isSocket: NO,
});

/** A Stats or BigIntStats as it crosses (#937): its numbers (a bigint one's as decimal strings, which JSON cannot carry as BigInt) and its kind. */
export function encodeStats(stats: Stats | BigIntStats): Record<string, unknown> {
  const fields = STAT_FIELDS.map((field) => {
    const value = stats[field];
    return [field, typeof value === 'bigint' ? value.toString() : value];
  });
  return { kind: kindOf(stats), ...Object.fromEntries(fields) };
}

/** encodeStats' answer rebuilt: the fields, the four Dates and the is* (#937). isBigint is the caller's own { bigint: true }. */
export function statsOf(wire: unknown, isBigint: false): Stats;
export function statsOf(wire: unknown, isBigint: true): BigIntStats;
export function statsOf(wire: unknown, isBigint: boolean): Stats | BigIntStats {
  if (!isRecord(wire)) throw badAnswer('stat');
  const raw: Record<string, unknown> = wire;
  // BigInt() of what is no decimal string throws, and the client rejects with that throw as a MachineError
  const value = (field: StatField): number | bigint => (isBigint ? BigInt(String(raw[field])) : Number(raw[field]));
  const date = (field: StatField): Date => new Date(Number(raw[field]));
  const fields = Object.fromEntries(STAT_FIELDS.map((field) => [field, value(field)]));
  return { ...fields, atime: date('atimeMs'), mtime: date('mtimeMs'), ctime: date('ctimeMs'), birthtime: date('birthtimeMs'), ...typed(raw.kind) } as unknown as Stats;
}

export const encodeDirent = (entry: Dirent): Record<string, unknown> => ({ name: entry.name, parentPath: entry.parentPath, kind: kindOf(entry) });

export function direntsOf(wire: unknown): Dirent[] {
  if (!Array.isArray(wire)) throw badAnswer('entry list');
  return wire.map((entry: unknown) => {
    if (!isRecord(entry) || !isString(entry.name) || !isString(entry.parentPath)) throw badAnswer('entry');
    return { name: entry.name, parentPath: entry.parentPath, ...typed(entry.kind) } as unknown as Dirent;
  });
}

export function asString(wire: unknown): string {
  if (!isString(wire)) throw badAnswer('string');
  return wire;
}

// a view, not a copy: the mux hands each attachment over as a Uint8Array that owns its buffer
export function asBuffer(wire: unknown): Buffer {
  if (!(wire instanceof Uint8Array)) throw badAnswer('bytes');
  return Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength);
}

export function asStrings(wire: unknown): string[] {
  if (!Array.isArray(wire) || !wire.every(isString)) throw badAnswer('name list');
  return wire;
}

/** readLines' lines from readFile's text (#937): CR LF, a lone CR and LF are one break each, as readline's with crlfDelay: Infinity in
 *  machine-local-fs.ts; a final break ends the last line and starts none. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}
