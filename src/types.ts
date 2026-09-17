import type { LogLevel } from './log.js';

export type Status = 'vazio' | 'trabalhando' | 'esperando_voce' | 'aguardando_review';
export type StatusKey = 'queue' | 'working' | 'review';
export type Signal = 'green' | 'yellow' | 'red';

export interface Budget {
  maxTokensPerHour?: number; // absent or 0 = no limit
  maxTokensPerDay?: number;
}

export interface UsageSample {
  at: string; // ISO, when the Stop / SessionEnd arrived
  tokens: number; // delta since the worker's previous turn end
}

/** One row of the usage table: at `percent` of the budget used, cap the workers and/or force a signal. */
export interface UsageRule {
  percent: number;
  maxWorkers?: number;
  signal?: Signal;
}

export interface UsageLimits {
  signal: Signal;
  maxWorkers?: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt: string; // ISO
}

/** Plan limits as last seen in a worker's status line; `at` is when the reading arrived, not a live value. */
export interface RateLimits {
  at: string; // ISO
  windows: Record<string, RateLimitWindow>; // keyed as Claude Code sends them: five_hour, seven_day, …
}

/** Reads the plan limits of the Claude Code account; rejects when it cannot (no token, network, 401). */
export type PlanLimitsReader = () => Promise<RateLimits | undefined>;

/** GraphQL quota of the account the Hive polls with, as last read after a poll; `at` is when it was read. */
export interface BoardQuota {
  limit: number;
  remaining: number;
  resetsAt: string; // ISO
  at: string; // ISO
}

export type BoardConfig =
  | { type: 'github'; owner: string; number: number }
  | { type: 'markdown'; path: string };

export interface Task {
  itemId: string; // adapter's own key: project item id (GitHub) or the id cell (markdown)
  id: string; // what the user sees and the slug uses: issue number as a string, or the id cell
  title: string;
  body: string;
  url: string;
  blockedBy?: string[]; // ids of blockers still open, per the adapter; absent or empty = free to start
}

export interface Slot {
  id: string;
  workerId?: string; // uuid per spawn; stale exit/hook signals from a previous occupant are ignored
  status: Status;
  draining?: boolean;
  paused?: boolean; // stopped at a Stop hook under a red signal; cleared when the signal leaves red or the worker acts again
  tokens?: number; // session total at the last Stop / SessionEnd; the next delta is measured against it
  task?: Task;
  slug?: string;
  worktree?: string;
  branch?: string;
  startedAt?: string;
  lastEvent?: string;
  prUrl?: string;
  question?: string;
  transcriptPath?: string; // from SessionStart; where GET /slots/:id/output reads the excerpt
}

export interface State {
  signal: Signal; // runtime gate for new jobs; lives here, not in the config, so a red set by hand survives a restart
  maxConcurrent: number;
  slots: Slot[];
  queue: Task[];
  usage: UsageSample[]; // last 24 h, oldest first; one sample per worker turn
  budget: Budget; // copied from Config.budget by setBudget
  usageRules: UsageRule[]; // copied from Config.usageRules by setUsageRules
  rateLimits?: RateLimits; // display only; absent until a worker's status line reports it
  boardQuota?: BoardQuota; // last quota read after a poll; drives the timer backoff and the header meter, never a job
  lastPolledAt?: string;
  error?: string;
}

/** Where a worker runs: a detached tmux session of the Hive with the terminal opened on demand, or an iTerm2 tab the Hive opens and watches. */
export type WorkersMode = 'embedded' | 'iterm';

/** What the GitHub adapter does with an issue that has sub-issues: drop it (only the sub-issues are tasks) or queue it like any other. */
export type EpicsMode = 'ignore' | 'queue';

export interface Config {
  board: BoardConfig;
  workers: WorkersMode;
  epics: EpicsMode; // GitHub only; the markdown adapter has no epics and ignores it
  logLevel: LogLevel; // info: what the Hive did; debug: also what it received. Read on boot and on every POST /setup
  status: Record<StatusKey, string>;
  maxConcurrent: number;
  port: number;
  claudeArgs: string[];
  promptTemplate: string;
  budget: Budget; // copied to State.budget by setBudget on configure / reconfigure
  usageRules: UsageRule[]; // copied to State.usageRules by setUsageRules on configure / reconfigure
}

export interface HookPayload {
  hook_event_name: string;
  cwd?: string;
  notification_type?: string;
  message?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  transcript_path?: string; // Claude Code sends it on every hook; the server reads tokens from it on Stop / SessionEnd, the reducer keeps it from SessionStart
}

export type HiveEvent =
  | { type: 'boot' }
  | { type: 'poll'; tasks: Task[] }
  | { type: 'setMax'; max: number }
  | { type: 'setSignal'; signal: Signal }
  | { type: 'setBudget'; budget: Budget }
  | { type: 'setUsageRules'; usageRules: UsageRule[] }
  | { type: 'rateLimits'; workerId: string; rateLimits: RateLimits }
  | { type: 'boardQuota'; quota: BoardQuota }
  | { type: 'hook'; workerId: string; payload: HookPayload; branch?: string; tokens?: number }
  | { type: 'exit'; workerId: string }
  | { type: 'kill'; slotId: string }
  | { type: 'error'; message?: string };

export interface ProjectSummary {
  number: number;
  title: string;
  url: string;
}

export type Effect =
  | { type: 'spawn'; slot: Slot }
  | { type: 'setStatus'; itemId: string; key: StatusKey }
  | { type: 'kill'; slug: string; workerId: string };

export interface SetupInfo {
  configured: boolean;
  repo: string;
  /** In setup mode, the saved config (if any) so the form reopens prefilled. */
  config?: Config;
  /** Why the saved config could not boot (board missing, unreadable…); shown in the setup form. */
  error?: string;
}

export interface SetupBody {
  board: BoardConfig;
  status: Record<StatusKey, string>;
  /** Optional; the form never sends it. Seeds the first boot; after that the header (POST /config) owns it. */
  maxConcurrent?: number;
  /** Optional; blank or missing keeps the current template (or the default on first setup). */
  promptTemplate?: string;
  /** The form always sends it (empty field = key absent); an API caller that omits it keeps the current budget. */
  budget?: Budget;
  /** The form always sends it (empty table = []); an API caller that omits it keeps the current rules. */
  usageRules?: UsageRule[];
  /** Optional; missing keeps the current mode (or `embedded` on first setup). */
  workers?: WorkersMode;
  /** Optional; missing keeps the current mode (or `ignore` on first setup). */
  epics?: EpicsMode;
}

export interface SetupResult {
  ok: true;
  restartForPort?: number;
}

/** What `GET /events` streams: the whole State, or a marker while the Hive has no config yet. */
export type EventsPayload = State | { configured: false };

/** What every board adapter implements; `src/board.ts` picks one by `config.board.type`. */
export interface Board {
  resolveFields(): Promise<void>; // validates the config against the source (options / table exist)
  listQueue(): Promise<Task[]>; // tasks in status.queue, in source order
  setStatus(itemId: string, key: StatusKey): Promise<void>;
  setupOptions(): Promise<string[]>; // status values available, for the setup form
  quota?(): Promise<BoardQuota | undefined>; // the polling account's API quota; a board without one (markdown) leaves it out
}

/** `execFile` promisified. Every spawner and the terminal opener take one, so tests never run a command. */
export type Exec = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

/** What the server injects so tests never open a session. */
export interface WorkerHandlers {
  onExit(): void; // once, on session end, kill or spawn failure
  onError(message: string): void; // spawner failures (tmux / iTerm missing or refused): shown in the dashboard error bar
}

export interface WorkerHandle {
  kill(): void; // tmux kill-session, or pkill by slug for a tab
  focus(): Promise<void>; // opens (or brings to the front) the worker's terminal
}

/** Everything a spawner needs to start one worker; each mode turns it into a session or a tab its own way. */
export interface WorkerLaunch {
  mode: WorkersMode;
  workerId: string;
  slug: string;
  repo: string;
  port: number;
  hooksPath: string;
  promptPath: string; // the rendered prompt on disk: the command line reads it with $(cat …)
  claudeArgs: string[];
}

export type SpawnWorker = (launch: WorkerLaunch, handlers: WorkerHandlers) => WorkerHandle;
