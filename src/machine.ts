// The machine (#158, node 7.1 of #157): where a task's disk, processes and ptys are. The host's own is the local machine (machine-local.ts);
// node 8 adds an actor's, reached over the link. Types only, but MachineError: a remote machine's failure arrives as data and is rebuilt as
// one, so a caller reads the same fields whichever machine failed. The fs and child_process types are imported as types only, which is why this file is on
// biome.jsonc's host-only list.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CopyOptions, Dirent, MakeDirectoryOptions, Mode, RmOptions, Stats } from 'node:fs';
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

export interface MachineErrorFields { code?: string | number; stderr?: string; stdout?: string; killed?: boolean }

/** A machine call's failure, with the fields wordsOf (fork.ts), CONFIG_LOCK and refuseUnmerged (worktree.ts) read off execFile's error today.
 * code: an errno string or an exit code. */
export class MachineError extends Error {
  static readonly TOO_LARGE = 'too_large'; // fs.readFile over its maxBytes
  static readonly NOT_FILE = 'not_file'; // fs.readFile of a FIFO, a device or a folder: its size says nothing, so the cap could not hold
  static readonly BAD_NAME = 'bad_name'; // pty.spawn with a ptyId or prompt name that is not one plain file name
  readonly code: string | number | undefined;
  readonly stderr: string;
  readonly stdout: string;
  readonly killed: boolean;
  constructor(message: string, fields: MachineErrorFields = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MachineError';
    this.code = fields.code;
    this.stderr = fields.stderr ?? '';
    this.stdout = fields.stdout ?? '';
    this.killed = fields.killed ?? false;
  }
}

/** What the code does with a task's disk today, each as node:fs/promises takes and answers it, but readFile (a required cap) and writeAtomic. */
export interface MachineFs {
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  access(path: string, mode?: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
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
  onOutput?: (text: string) => void; // every decoded chunk of either stream, live; it must not throw: it runs in the stream's data event
  windowsVerbatimArguments?: boolean; // the .cmd runner's line (#632)
}

/** Never a rejection: failure says why a run did not end with 0. code: the exit code, a signal, timeout / stopped / too_large, or an errno. */
export interface RunResult { code: number | string; stdout: Buffer; stderr: string; tail: string; failure?: string }

/** An agent run's inputs: AgentRun without what the machine fills from its own disk and daemon. */
export type RunInputs = Omit<AgentRun, 'ptyId' | 'cwd' | 'port' | 'hooksPath' | 'mcpPath' | 'protocolPath' | 'protocolText'>;

/** A pty launch with no host path in it (#158): the files' contents instead, which the machine writes on its own disk. */
export interface RunSpec {
  ptyId: string;
  slug: string;
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

export interface Machine {
  id: MachineId;
  fs: MachineFs;
  exec: MachineExec;
  run(p: RunProcess): Promise<RunResult>;
  process(command: string, args: string[], options: ProcessOptions): MachineChild; // #161
  pty: MachinePty;
  info(): MachineInfo;
}

/** Every machine the Hive knows (#158). Until node 8, for answers local for every activity, an unknown id included. */
export interface Machines {
  local: Machine;
  for(activity: Pick<Activity, 'machine'>): Machine;
}

/** What the server hands each registrar and the spawner (#158): the machine an activity's disk is on. */
export type MachineFor = (activity: Pick<Activity, 'machine'>) => Machine;
