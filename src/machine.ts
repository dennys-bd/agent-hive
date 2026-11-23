// The machine (#158, node 7.1 of #157): where a task's disk, processes and ptys are. The host's own is the local machine (machine-local.ts);
// node 8 adds an actor's, reached over the link. Types only, but MachineError, toMachineError and pathsOf: a remote machine's failure arrives as data and is
// rebuilt as one, so a caller reads the same fields whichever machine failed. The fs and child_process types are imported as types only, and
// node:path for pathsOf, which is why this file is on biome.jsonc's host-only list.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BigIntStats, CopyOptions, Dirent, MakeDirectoryOptions, Mode, RmOptions, Stats } from 'node:fs';
import path from 'node:path';
import type { AgentRun } from './agents/runner.js';
import type { PtyHost, PtyKeep } from './pty-host.js';
import type { TerminalSize } from './terminal-wire.js';
import type { Activity, AgentAvailability, AgentId, MachineId, PtyHandle, PtyHandlers } from './types.js';

/** Today's Exec options, plus cwd (every git call passes -C today, so it is new and optional) and an abort. */
export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  input?: string;
  timeout?: number; // ms
  cwd?: string;
  signal?: AbortSignal;
}

/** Rejects with a MachineError. Assignable to Exec, so a sibling can pass machine.exec where an Exec is taken before it changes a signature. */
export type MachineExec = (file: string, args: string[], opts?: ExecOptions) => Promise<{ stdout: string }>;

export interface MachineErrorFields { code?: string | number; stderr?: string; stdout?: string; killed?: boolean; reason?: string }

/** A machine call's failure, with the fields wordsOf (fork.ts), CONFIG_LOCK and refuseUnmerged (worktree.ts) read off execFile's error today.
 * code: an errno string or an exit code. */
export class MachineError extends Error {
  static readonly TOO_LARGE = 'too_large'; // fs.readFile over its maxBytes
  static readonly NOT_FILE = 'not_file'; // fs.readFile of a FIFO, a device or a folder: its size says nothing, so the cap could not hold
  static readonly BAD_NAME = 'bad_name'; // pty.spawn with a ptyId or prompt name that is not one plain file name
  static readonly BAD_PATH = 'bad_path'; // #939: a WSL UNC path of another distro, not a WSL path at all, or a .. out of the distro's root
  static readonly UNAVAILABLE = 'machine_unavailable'; // #931: the registry has no machine for the id; reason says why
  readonly code: string | number | undefined;
  readonly stderr: string;
  readonly stdout: string;
  readonly killed: boolean;
  readonly reason: string | undefined;
  constructor(message: string, fields: MachineErrorFields = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MachineError';
    this.code = fields.code;
    this.stderr = fields.stderr ?? '';
    this.stdout = fields.stdout ?? '';
    this.killed = fields.killed ?? false;
    this.reason = fields.reason;
  }
}

/** What the code does with a task's disk today, each as node:fs/promises takes and answers it, but readFile (a required cap) and writeAtomic. */
export interface MachineFs {
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  // bigint: an NTFS or ReFS file id passes 2^53, and as a number two files can round to one inode (sameFile, #908)
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  access(path: string, mode?: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true; recursive?: boolean }): Promise<Dirent[]>; // recursive: the COPY step's file count (#159)
  // maxBytes required: no caller reads a worktree file through a machine without a bound. Over it: MachineError TOO_LARGE, nothing read
  readFile(path: string, options: { maxBytes: number; encoding: BufferEncoding }): Promise<string>;
  readFile(path: string, options: { maxBytes: number }): Promise<Buffer>;
  // A regular file's lines, CR LF as one break (#161). Refused before any read as readFile is: not_file, too_large, on the first next()
  readLines(path: string, options: { maxBytes: number }): AsyncIterable<string>;
  writeFile(path: string, data: string | Uint8Array, options?: { flag?: string; mode?: Mode }): Promise<void>;
  writeAtomic(path: string, text: string): Promise<Buffer>; // a temp file beside it with its mode, renamed over it; the bytes written
  mkdir(path: string, options?: MakeDirectoryOptions): Promise<string | undefined>;
  mkdtemp(prefix: string): Promise<string>; // prefix under info().tmpdir: the temp dir and the repository on one disk
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(from: string, to: string, options?: CopyOptions): Promise<void>;
  copyFile(from: string, to: string, mode?: number): Promise<void>;
  link(existing: string, created: string): Promise<void>;
  chmod(path: string, mode: Mode): Promise<void>;
  unlink(path: string): Promise<void>;
  appendFile(path: string, data: string | Uint8Array, options?: { mode?: Mode }): Promise<void>;
}

/** A pty on the machine: spawn takes a RunSpec, which the machine materializes; the rest is the daemon's PtyHost surface, unchanged. */
export interface MachinePty extends Pick<PtyHost, 'write' | 'resize' | 'subscribe' | 'kill' | 'pid' | 'has' | 'adopt' | 'forget'> {
  spawn(spec: RunSpec, handlers: PtyHandlers): PtyHandle; // a write that fails rejects started, as a pty that cannot spawn does
}

/** The machine's own facts (#158), read once. agents: what boot detected, until 7.4 detects per machine. */
export interface MachineInfo {
  platform: NodeJS.Platform;
  arch: string;
  homedir: string;
  tmpdir: string;
  path: string;
  shell: string; // posixShell().shell
  claudeConfigDir?: string;
  codexHome?: string; // CODEX_HOME, as claudeConfigDir is CLAUDE_CONFIG_DIR (#161)
  copilotHome?: string; // COPILOT_HOME (#878)
  agents: AgentAvailability[];
}

/** A long-lived child with its three pipes (#161): a language server. Node 8.2's remote machine answers not_supported. */
export type MachineChild = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'pid' | 'kill' | 'on' | 'once'>;
export interface ProcessOptions { cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean } // the .cmd runner's line (#632)

/** One detached process (#158): runCapped's and runShell's run, for the formatters, the checkers and a setup's RUN. */
export interface RunProcess {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string; // written and stdin ended; absent: stdin closed, so a prompt fails at once
  timeoutMs?: number; // absent: no limit
  signal?: AbortSignal;
  maxBytes?: number; // per stream; EDITOR_FILE_MAX by default
  tailOnly?: true; // keep no stream's bytes, only the tail and onOutput: a caller that reads neither stream holds no memory (#159)
  onOutput?: (text: string) => void; // every decoded chunk of either stream, live; it must not throw: it runs in the stream's data event
  windowsVerbatimArguments?: boolean; // the .cmd runner's line (#632)
}

/** Never a rejection: failure says why a run did not end with 0. code: the exit code, a signal, timeout / stopped / too_large, or an errno. */
export interface RunResult { code: number | string; stdout: Buffer; stderr: string; tail: string; failure?: string }

const TAIL_LINES = 20; // worktree-steps.ts' tail, what a task's error shows of a RUN
const TAIL_CHARS = 8192; // output with no newlines (a progress bar) is bounded too

// A run's tail as its chunks arrive, and the one its RunResult carries: here, not in machine-run.ts, so the mux's client (#937) keeps an
// aborted run's tail as runDetached does without importing node:child_process. +1: the last piece is the line still being written
export const keepTail = (text: string): string => text.slice(-TAIL_CHARS).split('\n').slice(-(TAIL_LINES + 1)).join('\n');
export const tailOf = (text: string): string => text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');

/** An agent run's inputs: AgentRun without what the machine fills from its own disk and daemon, its plugin folders included (#947). */
export type RunInputs = Omit<AgentRun, 'ptyId' | 'cwd' | 'port' | 'hooksPath' | 'mcpPath' | 'protocolPath' | 'protocolText' | 'pluginDir' | 'lspPluginDir'>;

/** A pty launch with no host path in it (#158): the files' contents instead, which the machine writes on its own disk. */
export interface RunSpec {
  ptyId: string;
  slug: string;
  workspace: string; // the workspace's name: the machine resolves its plugin folders and anything else of the workspace on its own disk (#947)
  cwd: string;
  terminal?: true;
  run?: { command: string; env: Record<string, string> };
  env?: Record<string, string>;
  keep?: PtyKeep;
  size?: TerminalSize;
  prompt?: { text: string; name: string }; // name: the file's base name, the slug for a stage run, the pty id for a session's first prompt
  protocol?: string; // the protocol's text: written to <ptyId>.protocol.md and passed as protocolPath and protocolText
  agent?: { id: AgentId; run: RunInputs; copy?: { from: string; name?: string } }; // absent: a terminal
  lent?: Record<string, string>; // merged into the env last; never written to a file or a log
}

const text = (value: unknown): string => (typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '');

/** execFile's rejection (or a test fake's) as a MachineError, field for field, the original as its cause. */
export function toMachineError(err: unknown): MachineError {
  if (err instanceof MachineError) return err;
  const fields: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
  const { code } = fields;
  return new MachineError(err instanceof Error ? err.message : String(err), {
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    stderr: text(fields.stderr), stdout: text(fields.stdout), killed: fields.killed === true,
  }, { cause: err });
}

/** A watch's handle (#935): close() is idempotent, and after it neither callback fires. */
export interface MachineWatcher { close(): void }

export interface Machine {
  id: MachineId;
  fs: MachineFs;
  exec: MachineExec;
  run(p: RunProcess): Promise<RunResult>;
  process(command: string, args: string[], options: ProcessOptions): MachineChild; // #161
  pty: MachinePty;
  info(): MachineInfo;
  readonly paths: path.PlatformPath; // #927: every path on this machine's disk is joined and compared with it, never with the host's node:path
  /** Watches path on this machine's disk (#935). Never throws: a failure, at the start or later, reaches onError once, after which
   *  nothing fires; nothing fires after close(). filename is relative to path, in the machine's separators, null when the OS named none. */
  watch(path: string, options: { recursive: boolean }, onEvent: (filename: string | null) => void, onError: (err: MachineError) => void): MachineWatcher;
}

/** The path flavour of a machine's platform (#927): a distro's disk needs / even when the Hive runs on Windows. */
export const pathsOf = (platform: NodeJS.Platform): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix);

/** Every machine the Hive knows (#158). `for` answers `local` for no machine or `'local'`; for a `wsl:` id, the distro's machine when the registry can build one; for anything else, a machine that refuses every call (#931, machines.ts). */
export interface Machines {
  local: Machine;
  for(activity: Pick<Activity, 'machine'>): Machine;
}

/** What the server hands each registrar and the spawner (#158): the machine an activity's disk is on. */
export type MachineFor = (activity: Pick<Activity, 'machine'>) => Machine;
