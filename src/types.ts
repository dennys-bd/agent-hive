import type { LogLevel } from './log.js';

export type Language = 'pt' | 'en';

export type Status = 'empty' | 'working' | 'waiting' | 'review';
export type SlotEventKind = 'starting' | 'manualStart' | 'prompt' | 'tool' | 'waiting' | 'pr' | 'turn';
/** What the slot last did, as a key the UI turns into text; `detail` is the tool summary (`Bash: pnpm test`) or the notification kind. */
export interface SlotEvent {
  kind: SlotEventKind;
  detail?: string;
}
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

export type SessionPolicy = 'new' | 'continue';

/** One stage of the Hive's own board; the array order is the pipeline order. */
export interface Column {
  name: string;
  prompt?: string; // template ({id} {number} {title} {body} {url}); absent = no action, the card just sits here
  session?: SessionPolicy; // continue = --resume the card's session; absent = new
  model?: string; // --model
  weight: number; // higher wins a free slot; ties by board order
  from: string[]; // board columns whose cards enter here (new cards, or a human move)
  onStart?: string; // board column the card is moved to when the command starts
  onFinish?: string; // idem when the command ends
}

/** A board task inside the Hive: it exists while it sits in a column, running or not. */
export interface Card {
  task: Task;
  column: string;
  boardColumn: string; // where the Hive last saw or left it on the board; the poll compares against it
  slug: string;
  worktree?: string;
  branch?: string;
  sessionId?: string; // set by the reducer at spawn (new) or kept (continue); what --resume takes
  prUrl?: string;
  slotId?: string; // present while the command runs
  missing?: true; // gone from the board; waits for close or keep
  orphan?: true; // kept after going missing: runs to the end, no board writes, ignored by the poll
}

/** A task as the adapter lists it: which board column it is in, in board order. */
export interface BoardCard {
  task: Task;
  column: string;
}

export interface Slot {
  id: string;
  workerId?: string; // uuid per spawn; stale exit/hook signals from a previous occupant are ignored
  cardId?: string; // the task.itemId of the card running here
  status: Status;
  draining?: boolean;
  tokens?: number; // session total at the last Stop / SessionEnd; the next delta is measured against it
  startedAt?: string;
  lastEvent?: SlotEvent;
  question?: string;
  transcriptPath?: string; // from SessionStart; where GET /slots/:id/output reads the excerpt
  sessionId?: string; // Claude Code session id from SessionStart; must coincide with Card.sessionId. First one wins (#24)
}

export interface State {
  signal: Signal; // runtime gate for new jobs; lives here, not in the config, so a red set by hand survives a restart
  maxConcurrent: number;
  slots: Slot[];
  columns: Column[]; // copied from Config.columns; the pipeline order
  cards: Card[]; // every task the Hive holds, in board order
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
  language?: Language; // UI language; absent = the system's (never written as undefined: the file stays clean)
  columns: Column[]; // the Hive's board, in pipeline order
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
  session_id?: string; // Claude Code sends it on every hook; the reducer keeps it from SessionStart
}

export type HiveEvent =
  | { type: 'boot' }
  | { type: 'poll'; cards: BoardCard[] }
  | { type: 'setMax'; max: number }
  | { type: 'setSignal'; signal: Signal }
  | { type: 'setBudget'; budget: Budget }
  | { type: 'setUsageRules'; usageRules: UsageRule[] }
  | { type: 'setColumns'; columns: Column[] }
  | { type: 'rateLimits'; workerId?: string; rateLimits: RateLimits } // no workerId: the Hive's own reading
  | { type: 'boardQuota'; quota: BoardQuota }
  | { type: 'hook'; workerId: string; payload: HookPayload; branch?: string; tokens?: number }
  | { type: 'exit'; workerId: string }
  | { type: 'kill'; slotId: string }
  | { type: 'error'; message?: string }
  | { type: 'start'; itemId: string; raiseMax?: boolean } // the human override on a stopped card: past the signal, the cap and the budget
  | { type: 'closeCard'; cardId: string } // fechar on a missing card
  | { type: 'keepCard'; cardId: string }; // manter on a missing card

export interface ProjectSummary {
  number: number;
  title: string;
  url: string;
}

export type Effect =
  | { type: 'spawn'; slot: Slot; card: Card; column: Column; session: SessionPolicy } // session already resolved: continue without an id runs as new
  | { type: 'setColumn'; itemId: string; column: string }
  | { type: 'kill'; slug: string; workerId: string };

export interface SetupInfo {
  configured: boolean;
  repo: string;
  /** In setup mode, the saved config (if any) so the form reopens prefilled. */
  config?: Config;
  /** Why the saved config could not boot (board missing, unreadable…); shown in the setup form. */
  error?: string;
  /** Effective UI language: the config's when set, else the system's. Read by app.ts before any render. */
  language: Language;
}

export interface SetupBody {
  board: BoardConfig;
  /** The form always sends it; an API caller that omits it keeps the current columns (or the legacy proposal). */
  columns?: Column[];
  /** @deprecated superseded by `columns`; kept until Task 7 so an old API caller does not break mid-migration. */
  status?: Record<StatusKey, string>;
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
  /** The form always sends it; an API caller that omits it keeps the current one (or the system's on first setup). */
  language?: Language;
}

export interface SetupResult {
  ok: true;
  restartForPort?: number;
}

/** What `GET /events` streams: the whole State, or a marker while the Hive has no config yet. */
export type EventsPayload = State | { configured: false };

/** What every board adapter implements; `src/board.ts` picks one by `config.board.type`. */
export interface Board {
  resolveFields(): Promise<void>; // every column name the config cites exists on the board
  listCards(): Promise<BoardCard[]>; // tasks in any cited column, in board order
  setColumn(itemId: string, column: string): Promise<void>;
  setupOptions(): Promise<string[]>; // status values available, for the setup form
  quota?(): Promise<BoardQuota | undefined>; // the polling account's API quota; a board without one (markdown) leaves it out
}

/** What a board adapter is built from; the rest of the config is not its business. */
export type BoardSpec = Pick<Config, 'board' | 'columns' | 'epics'>;

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
  args: string[]; // the claude argv after --settings: worktree, claudeArgs, model, session (workerArgs)
}

export type SpawnWorker = (launch: WorkerLaunch, handlers: WorkerHandlers) => WorkerHandle;
