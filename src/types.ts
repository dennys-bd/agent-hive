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
  itermSessionId?: string;
  startedAt?: string;
  lastEvent?: string;
  prUrl?: string;
  question?: string;
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
  lastPolledAt?: string;
  error?: string;
}

export interface Config {
  board: BoardConfig;
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
  transcript_path?: string; // Claude Code sends it on every hook; the server reads it only on Stop / SessionEnd
}

export type HiveEvent =
  | { type: 'boot'; aliveSlugs: string[] }
  | { type: 'poll'; tasks: Task[] }
  | { type: 'setMax'; max: number }
  | { type: 'setSignal'; signal: Signal }
  | { type: 'setBudget'; budget: Budget }
  | { type: 'setUsageRules'; usageRules: UsageRule[] }
  | { type: 'rateLimits'; workerId: string; rateLimits: RateLimits }
  | { type: 'hook'; workerId: string; payload: HookPayload; branch?: string; tokens?: number }
  | { type: 'exit'; workerId: string }
  | { type: 'kill'; slotId: string }
  | { type: 'spawned'; workerId: string; itermSessionId: string }
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
  maxConcurrent: number;
  /** Optional; blank or missing keeps the current template (or the default on first setup). */
  promptTemplate?: string;
  /** The form always sends it (empty field = key absent); an API caller that omits it keeps the current budget. */
  budget?: Budget;
  /** The form always sends it (empty table = []); an API caller that omits it keeps the current rules. */
  usageRules?: UsageRule[];
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
}
