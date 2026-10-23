import type { LogLevel } from './log.js';
import type { PtyHost, PtyKeep } from './pty-host.js';
import type { TerminalSize } from './terminal-wire.js';
import type { BasedOn } from './template.js';
import type { LintItem } from './template-lint.js';

export type Language = 'pt' | 'en';

/** The UI's colors (#296): system follows the macOS appearance live; light and dark force one. The parser and the form's select read THEMES. */
export type Theme = 'system' | 'light' | 'dark';
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

/** The files tree's icons (#754): an icon theme's own coloured icons (none = carets only), on every row or on folders only, optionally muted.
 * The parser and the form's selects read FILE_ICON_SETS and FILE_ICON_SCOPES. */
export type FileIconSet = 'material' | 'vscode' | 'none';
export const FILE_ICON_SETS: readonly FileIconSet[] = ['material', 'vscode', 'none'];
export type FileIconScope = 'all' | 'folders';
export const FILE_ICON_SCOPES: readonly FileIconScope[] = ['all', 'folders'];
export interface FileIcons { set: FileIconSet; scope: FileIconScope; muted: boolean }
/** What a new form shows and what a file from before the key is migrated to (#754). The parser itself has no default. */
export const FILE_ICONS_DEFAULTS: FileIcons = { set: 'material', scope: 'all', muted: true };

/** Which sidebar state each view keeps on its own (#821): left / right = open flag and width; rightTab = the activity sidebar's tab, kept
 * when a task is picked outside the activities. rightTab counts only while right is on. */
export interface SidebarsPerView { left: boolean; right: boolean; rightTab: boolean }
/** What a new form shows and what a file from before the key is prefilled with (#821). The parser itself has no default. */
export const SIDEBARS_PER_VIEW_DEFAULTS: SidebarsPerView = { left: false, right: false, rightTab: true };

/** What closing the last main window does (#513, was #198's menuBar + stopOnClose): menuBar = the viewer stays in the menu bar and
 * the workers keep running; quit = the Hive stops with its workers (asking first while workers run). */
export const ON_CLOSE = ['menuBar', 'quit'] as const;
export type OnClose = (typeof ON_CLOSE)[number];

/** The transitions that show a macOS notification (#199), each its own switch in Settings › app, in the order notify.ts reports them. */
export const NOTIFICATION_KINDS = ['waiting', 'approval', 'pr', 'failed'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationSettings = Record<NotificationKind, boolean>;

/** What closing an agent's tab does to its run (#614): keep = the run goes on; sleep = it stops, and its session sleeps in the sidebar. */
export const CLOSE_TAB_ACTIONS = ['keep', 'sleep'] as const;
export type CloseTabAction = (typeof CLOSE_TAB_ACTIONS)[number];

export type Status = 'empty' | 'working' | 'waiting' | 'review' | 'approval' | 'backoff';
export type WorkerEventKind = 'starting' | 'manualStart' | 'prompt' | 'tool' | 'waiting' | 'pr' | 'turn' | 'continuing' | 'ask' | 'background' | 'apiError';
/** What the worker last did, as a key the UI turns into text; `detail` is the tool summary (`Bash: pnpm test`), the notification kind, how
 * many of the worker's own background tasks and crons were in flight at its Stop (#367), or the API error class (#805). The worktree setup's
 * step lives on the task (#351). */
export interface WorkerEvent {
  kind: WorkerEventKind;
  detail?: string;
}
/** The wait of a run whose turn ended on an API error (#805): the Hive types `continue` at `until`. */
export interface WorkerBackoff {
  error: string; // the hook's `error` class, as Claude Code sent it
  until: string; // ISO; the server's timer carries this exact string back in retryDue
}
export type Signal = 'green' | 'yellow' | 'red';
export type RuleSignal = Exclude<Signal, 'green'>; // green never restricts anything, so a rule cannot set it
export const RULE_SIGNALS: readonly RuleSignal[] = ['yellow', 'red'];
/** What a signal lets the Hive do with a task already started (#727). STARTED_BEHAVIOURS is most restrictive first: the order isOrdered
 * compares red and yellow by. */
export type StartedBehaviour = 'resumeAndContinue' | 'continueOnly' | 'stay';
export const STARTED_BEHAVIOURS: readonly StartedBehaviour[] = ['stay', 'continueOnly', 'resumeAndContinue'];
/** What a signal lets the fill do with a task not started yet (#32): any, only one of a tree that already started, none. NEW_TASKS is most
 * restrictive first: the order isOrdered compares the signals by. */
export type NewTasks = 'always' | 'tree' | 'never';
export const NEW_TASKS: readonly NewTasks[] = ['never', 'tree', 'always'];
/** One row of the signal table (#727): what that signal lets the Hive do on its own. */
export interface SignalBehaviour { newTasks: NewTasks; started: StartedBehaviour; workerless: boolean }
/** The signal a boot opens on (#727); a saved red always opens red. */
export type SignalOnOpen = 'yellow' | 'last' | 'green';
export const SIGNAL_ON_OPEN: readonly SignalOnOpen[] = ['yellow', 'last', 'green'];
/** hive.config.json's `signals` (#727): green's newTasks (#32; its started and workerless stay fixed, signals.ts), the yellow and red rows and
 * the opening signal. */
export interface SignalSettings { green: Pick<SignalBehaviour, 'newTasks'>; yellow: SignalBehaviour; red: SignalBehaviour; onOpen: SignalOnOpen }
/** What a new form shows, what a file from before the key is prefilled with and what a State holds until the config is copied in (#727). Yellow
 * keeps started trees moving without opening new work (#32). The parser itself has no default. */
export const SIGNALS_DEFAULTS: SignalSettings = {
  green: { newTasks: 'always' },
  yellow: { newTasks: 'tree', started: 'resumeAndContinue', workerless: true },
  red: { newTasks: 'never', started: 'stay', workerless: true },
  onOpen: 'yellow',
};
/** The worker cap of a fresh state (#727): the state is the cap's one source, the flow sidebar's field its only editor. */
export const MAX_CONCURRENT_DEFAULT = 2;
/** The highest worker cap (#727): setMax allocates that many workers, and a cap kept only in state.json would re-crash every boot. */
export const MAX_CONCURRENT_MAX = 64;
/** What a rule reads: the token budget (hour / day) or a plan window the Hive already reads (session = five_hour, week = seven_day,
 * month = thirty_day, #929). */
export type RuleSource = 'hour' | 'day' | 'session' | 'week' | 'month';
export const RULE_SOURCES: readonly RuleSource[] = ['hour', 'day', 'session', 'week', 'month'];
/** The sources that read an agent's plan window (#929); hour and day sum every agent's tokens. */
export type PlanSource = Exclude<RuleSource, 'hour' | 'day'>;
export const PLAN_SOURCES: readonly PlanSource[] = ['session', 'week', 'month'];
export const isPlanSource = (source: RuleSource): source is PlanSource => (PLAN_SOURCES as readonly RuleSource[]).includes(source);

export interface Budget {
  maxTokensPerHour?: number; // absent or 0 = no limit
  maxTokensPerDay?: number;
}

export interface UsageSample {
  at: string; // ISO, when the Stop / SessionEnd arrived
  tokens: number; // delta since the worker's previous turn end
}

/** One rule of the limits table: when `source` is at or above `percent`, cap the workers and/or force a signal. At least one of the two.
 * With `stage` (#475) its maxWorkers caps that stage alone and it carries no signal: the signal is global. */
export interface UsageRule {
  source: RuleSource;
  percent: number; // floor: fires at or above
  maxWorkers?: number;
  signal?: RuleSignal;
  stage?: string; // #475: a name in comb.stages; absent = the rule caps the total
  agent?: AgentId; // #929: whose plan a session / week / month rule reads; absent = the config's defaultAgent
}

/** How long a disable holds (#297): until the source drops below the percent (the default), until a fixed time, or until religar. */
export type DisableUntil = { kind: 'reset' } | { kind: 'at'; at: string } | { kind: 'manual' }; // at: ISO

/** A fired rule the user switched off from the strip (#297): identified by source + percent + agent (#929). */
export interface DisabledRule {
  source: RuleSource;
  percent: number;
  until: DisableUntil;
  agent?: AgentId; // #929: the rule's agent; absent = the default agent, as UsageRule.agent
}

/** A disabled rule as effectiveLimits reports it (#297): the rule and when it is expected back. */
export interface DisabledRuleStatus {
  rule: UsageRule; // the matching row of state.usageRules
  until: DisableUntil['kind'];
  backAt?: string; // ISO; reset: the window's resetsAt (session / week) or the estimate (hour / day); at: its time; manual: absent
  estimate: boolean; // true only for reset on hour / day
}

export interface UsageLimits {
  signal: Signal;
  maxWorkers?: number;
}

/** effectiveLimits' own answer: the merged limits, the floor the fired rules alone impose, and the rules behind each side of it (#87, #142).
 * floor, capRules and maxWorkers read only the rules without a stage; the stage caps have their own two fields (#475). */
export interface EffectiveLimits extends UsageLimits {
  floor: UsageLimits; // applyUsageRules' result: { signal: 'green' } and no maxWorkers when nothing fired
  signalRules: UsageRule[]; // fired rules whose signal === floor.signal (empty when floor.signal is green)
  capRules: UsageRule[]; // fired global rules whose maxWorkers === floor.maxWorkers (empty without a cap)
  disabledRules: DisabledRuleStatus[]; // the rules the user switched off from the strip (#297), in the table's order, with when each is back
  stageCaps: Record<string, number>; // #475: every capped stage's effective cap, the smallest of Stage.maxWorkers and its fired stage rules; no key = no cap
  stageCapRules: Record<string, UsageRule[]>; // #475: per stage, the fired stage rules at its cap; no key when Stage.maxWorkers alone sets it
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

/** Each agent's last plan reading (#929); an agent without one has no key. */
export type PlanReadings = Partial<Record<AgentId, RateLimits>>;
/** One read of every agent with plan limits (#929): the readings it got and each failing agent's reason. */
export interface PlanLimitsReport { readings: { agent: AgentId; rateLimits: RateLimits }[]; failures: { agent: AgentId; reason: string }[] }
/** `agents`: only these (#223, a chip's ↻); absent, every agent with plan limits. */
export type PlanLimitsReader = (agents?: readonly AgentId[]) => Promise<PlanLimitsReport>;

/** GraphQL quota of the account the Hive polls with, as last read after a poll; `at` is when it was read. */
export interface SourceQuota {
  limit: number;
  remaining: number;
  resetsAt: string; // ISO
  at: string; // ISO
}

/** A source's sync (#180): what the Hive last saw of its polling. */
export interface SourceSync {
  polledAt?: string; // ISO, the last successful poll
  quota?: SourceQuota; // drives this source's backoff and its header meter
  error?: string; // the last poll failure; cleared by the next success
}

/** How the Hive itself reaches GitHub: the `gh` CLI the user already logged in, or the Hive's own OAuth token. */
export type GithubAuth = 'cli' | 'api';
export const GITHUB_AUTHS: readonly GithubAuth[] = ['cli', 'api'];

/** One key per provider; each adapter owns its own login. The next sources add siblings (`asana`, `jira`). */
export interface AuthConfig {
  github: GithubAuth;
}

/** One GraphQL call against GitHub. Variables are scalars only; both transports carry them as such (#849: a boolean too). */
export type Gql = (query: string, variables?: Record<string, string | number | boolean>) => Promise<unknown>;

/** What the credential store holds, one key per provider. Never leaves the process except as an Authorization header. */
export interface Credentials {
  github?: { token: string; login: string };
  /** An external MCP server's header value by server name (#333). */
  mcp?: Record<string, { value: string }>;
}

/** What GET /settings/github/auth answers: never the token, only what the screen shows. */
export interface GithubAuthStatus {
  connected: boolean;
  login?: string;
  pending?: { userCode: string; verificationUri: string };
  error?: string;
}

/** The task filter's criteria and operators (#245), in the order the settings form lists them. */
export const FILTER_FIELDS = ['assignee', 'label', 'milestone', 'repository', 'projectField', 'blocked'] as const;
export const FILTER_OPS = ['any', 'none'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** One task-filter rule (#245): OR across `values`, `none` negates; a source's rules AND together, [] = no restriction. */
export type FilterRule =
  | { field: 'assignee' | 'label' | 'milestone' | 'repository'; op: FilterOp; values: string[] } // assignee values may say '@me'
  | { field: 'projectField'; name: string; op: FilterOp; values: string[] } // name: a single-select field of the GitHub Project
  | { field: 'blocked'; op: FilterOp }; // #441: any = blocked, none = not blocked; no values

/** What the settings form offers per criterion: the source's real values (#245). */
export interface FilterOptions {
  assignees: string[]; // '@me' first
  labels: string[];
  milestones: string[];
  repositories: string[]; // owner/name
  projectFields: { name: string; options: string[] }[]; // single-select fields, Status excluded
  linkedRepositories?: string[]; // #846: the GitHub Project's linked repositories (owner/name), what a source's repository for new issues is picked from
}

/** Which GitHub tasks the Hive takes (#245): a list of rules, every one of which must pass; [] = no restriction. */
export type TaskFilter = FilterRule[];
/** How a rule compares an item's field with its own value (#293): both sides trimmed; the i forms compare toLowerCase() of both. */
export type RuleOp = 'equals' | 'iequals' | 'contains' | 'icontains';
/** What a source sets on each task it lists, on entry (#688). The registry's order is the UI's order. */
export const TASK_PROPS = ['workspace', 'auto'] as const;
export type TaskProp = (typeof TASK_PROPS)[number];
/** A task's properties as a source sets them (#688): workspace absent = no workspace. */
export interface TaskProps { workspace?: string; auto: boolean }
/** A rule (#688): when its field matches, it sets the 1+ properties in `set`. */
export interface TaskRule { field: string; op: RuleOp; value: string; set: Partial<TaskProps> }
/** A source's task properties (#688): the defaults and 0 to RULES_MAX rules; per property, the first matching rule that sets it wins. */
export interface SourceTaskProps { defaults: TaskProps; rules: TaskRule[] }
/** What an adapter reads of one source: its type's own fields and its task properties (#179, #688). One type today; the next adapter (Jira)
 * joins as another member under the same `type` key. */
export type SourceFields = {
  type: 'github'; owner: string; number: number; filter: TaskFilter; taskProps: SourceTaskProps;
  repository?: string; // #846: owner/name new issues are created in; absent = the source is no destination
  epics: EpicsMode; epicFollows: EpicFollows; // #30: required whatever the mode
  switchAt: string; // #30: a stage name of comb.stages, checked by the parser
};

/** One external source of the Comb (#180): its fields under the key the columns, the item ids, the state and the UI use. */
export type SourceConfig = SourceFields & {
  name: string; // WORKSPACE_NAME, not a reserved name (isReservedSource: local, hive); unique in the Comb; a rename in Settings carries its tasks (#278)
  qualifyId: boolean; // true: Item.id = `${prefix ?? name}-${adapter id}`
  prefix?: string; // COMB_PREFIX
};

/** What a task filter rule can read of a task (#245, #374): filled by the GitHub adapter from the polled item; absent on local tasks. */
export interface ItemFacets {
  assignees: string[]; // logins
  labels: string[];
  milestone?: string; // title
  repository?: string; // owner/name
  fields: Record<string, string>; // single-select GitHub Project field name → the item's option; Status left out
}

/** One end of a blocker relation (#56): the other item, as the UI shows it. */
export interface BlockerRef {
  id: string; // the display id: `12` in the item's own repository, `owner/repo#12` in another; a hive task's id (`HIVE-3`)
  title: string;
  state: 'open' | 'closed';
}
/** An item's blocker relations (#56), both directions. */
export interface ItemBlockers { blockedBy: BlockerRef[]; blocking: BlockerRef[] }
/** One edit of a relation (#56), as the route takes it: `ref` the other item's display id. */
export interface BlockerChange { action: 'add' | 'remove'; kind: 'blockedBy' | 'blocking'; ref: string }

/** A blocker a task inherits from an ancestor (#424): the blocker's display id, and the ancestor's that holds it. */
export interface InheritedBlocker { id: string; via: string }

/** What a source adapter reads for a task (glossary: item): the raw record; its id is itemId. */
export interface Item {
  itemId: string; // `${source}:${adapter id}` for a source task (#180); `local:<n>` for a local one; the adapter's own key after the source's name
  id: string; // what the user sees and the slug uses: issue number as a string, or the id cell
  title: string;
  body: string;
  url: string;
  blockedBy?: string[]; // ids of blockers still open, per the adapter; absent or empty = free to start
  inheritedBlockedBy?: InheritedBlocker[]; // #424: the ancestors' open blockers, nearest ancestor first, each id once; absent or empty = none. Derived on every poll, never written
  workspaceHint?: string; // the workspace the first matching rule that sets one names (#293, #688)
  autoOnEntry?: boolean; // #688: the auto a source task is born with, resolved by its adapter; absent on a task created in the Hive
  source?: string; // the listing source's name (#180); absent on a local task
  facets?: ItemFacets; // #374: what a stage's view filter reads; replaced on every poll like every other task field
  createdAt?: string; // #742: ISO, the source's own creation time (the GitHub issue's); absent when the source has none. What lead time counts from
  origin?: string; // #756: the itemId of the source item a task created in the Hive was made from (the native view's flow…); never synced either way
  parent?: string; // #28: the parent's itemId, from the sub-issues of the listed items; absent on a task created in the Hive and on an issue with no parent on the Project
  children?: string[]; // #28: the itemIds of the sub-issues on the Project, any column, in sub-issue order; absent or empty = a leaf
  closedChildren?: string[]; // #28: those of `children` closed on GitHub: what counts a child that left the Hive as done
  epic?: { follows: EpicFollows; switchAt: string }; // #31: stamped by the GitHub adapter under epics: show on an issue with sub-issues: it never runs and its stage follows its children; absent otherwise
  blockers?: ItemBlockers; // #56: the relations the UI shows and edits, both directions, sub-issues never; absent = none read. Not the start gate: that is blockedBy
}

export type SessionPolicy = 'new' | 'continue';
export type SpawnRun = 'stage' | 'continue'; // which prompt a spawn writes (#283): the stage's, or Continue's fixed one

/** Why hive_stop closes an issue (#314): GitHub's NOT_PLANNED and DUPLICATE. There is no "completed": that is hive_done's job. */
export type CloseReason = 'wontDo' | 'duplicate';

/** What a stage does to its task on the external source (#286). A stage holds a list per source (#515); no leaving action on start. */
export type SourceAction =
  | { type: 'move'; column: string }
  | { type: 'archive' | 'remove' | 'delete' }
  | { type: 'close'; reason?: CloseReason; duplicateOf?: number }; // reason / duplicateOf: from hive_stop only (#314); a transition writes a bare close

export type MoveAction = Extract<SourceAction, { type: 'move' }>;
export type CloseAction = Extract<SourceAction, { type: 'close' }>; // #314
export type ItemAction = Exclude<SourceAction, MoveAction>;

/** The actions that take the item off the source (#286): the task leaves the Hive once the write succeeds. Never on start, and last in a list (#515). */
export const LEAVING_ACTIONS: readonly SourceAction['type'][] = ['archive', 'remove', 'delete'];
export const isLeaving = (a: SourceAction): boolean => LEAVING_ACTIONS.includes(a.type);

/** The single source of what each source type can do (#286): the config, the adapters and the settings form read it. */
export const SOURCE_ACTIONS: Record<SourceFields['type'], SourceAction['type'][]> = {
  github: ['move', 'archive', 'remove', 'close', 'delete'],
};

/** What a stage does with a stopped task instead of running a prompt (#573: was cleanup): deleteActivity deletes the task's activity; commands
 * runs a list of the workspace's commands in its worktree and ends with a verdict (#755); waitForCi waits for the checks of the task's open PRs
 * and ends with a verdict (#834); skill (#710) runs one of the Hive's skills as its agent's prompt, /hive:<skill>: an agent stage, unlike the others.
 * evaluate (#877) runs reviewers and a judge read-only in the task's worktree and ends with a verdict from the judge's scores against the stage's threshold. */
export type StageAction = 'deleteActivity' | 'commands' | 'waitForCi' | 'skill' | 'evaluate';

/** What a commands stage does with a command that has no line in the task's workspace (#755): fail the stage before anything runs, or skip it.
 * A name the Comb no longer has fails it either way. */
export const ON_MISSING = ['fail', 'skip'] as const;
export type OnMissing = (typeof ON_MISSING)[number];

/** Which checks a wait-for-CI stage counts (#834): its PRs' base branch's required ones (every check when the branch requires none), every
 * check on the last commit, or the ones `checks` names. */
export const CI_CHECKS = ['required', 'all', 'list'] as const;
export type CiChecks = (typeof CI_CHECKS)[number];

/** One stage of the Hive's flow. The array order is the pipeline order, and it decides the fill: a task in a later stage wins a free worker
 * over one in an earlier stage, ties by the Hive's order (drag a task to change it, #316). The external source's columns keep the name "column" (#286). */
export interface Stage {
  name: string;
  prompt?: string; // template ({id} {number} {title} {body} {url} {result.<path>}); absent = no action, the task just sits here
  session?: SessionPolicy; // continue = --resume the task's session; absent = new
  model?: string; // passed as is behind the agent's model flag (#516)
  agent?: AgentId; // #516: the agent this stage runs; absent = Config.defaultAgent; prompt and skill stages only (#710): the parser refuses it next to any other action
  from: Record<string, string[]>; // source name → its columns whose tasks enter here (#180)
  onStart?: Record<string, SourceAction[]>; // #515: source name → what its source does when a run starts, in order; no leaving action
  action?: StageAction; // instead of a prompt: deleteActivity deletes the task's activity: its terminals, its worktree and its local branch; exclusive with prompt
  skill?: string; // #710: with action skill only, required there: a Hive skill's name, run as /hive:<skill>
  specializedAgent?: string; // #710: prompt and skill stages only: hive:<name>, what a manual start's pick overrides
  commands?: string[]; // #755: with action commands only: names in comb.commands, in the order they run; a name the Comb lost fails the stage when it runs
  stopOnFailure?: boolean; // #755: with action commands only: the first non-zero exit ends the stage; false runs them all and joins the failures
  onMissing?: OnMissing; // #755: with action commands only, required there: a command with no line in the task's workspace fails the stage or is skipped
  ciChecks?: CiChecks; // #834: with action waitForCi only, required there: which checks the wait counts
  checks?: string[]; // #834: with ciChecks list only, required there: names or patterns (* = any run of characters), case-insensitive
  rerunOnce?: boolean; // #834: with action waitForCi only, required there: re-run the failed Actions jobs once per head commit before failing
  timeout?: string; // #834: with action waitForCi only: how long the wait may take from the stage's start (TIMEOUT); absent = no limit
  reviewers?: EvaluateRow[]; // #877: with action evaluate only, required there (may be empty): each runs read-only in parallel with its focus
  judge?: EvaluateRow; // #877: with action evaluate only, required there; no focus
  threshold?: number; // #877: with action evaluate only, required there: 0..10, every dimension's score must reach it
  rubric?: string; // #877: with action evaluate only, required there: a template, one dimension per non-blank line
  verdicts?: string[]; // #134: prompt stages only: the verdicts hive_done may give here, each routed by its own transition; commands, waitForCi and evaluate have FIXED_VERDICTS
  after?: string; // delay from the task's entry into the stage before its prompt or action may run: "30m", "12h", "5d"; absent = right away
  approval?: true; // a stage end here waits for the user's approve or feedback (#268); prompt stages only: the parser refuses it next to action
  handoff?: true; // #692: the previous stage's session writes a handoff before the task enters here; the parser refuses it next to action or session continue
  clearSession?: true; // #494: agent stages only (prompt or skill): the stage run's session leaves the task's list when a transition takes the task out
  maxWorkers?: number; // #475: the stage's own worker cap; 0 pauses its automation; absent = none. Starts by hand pass it, as they pass the global cap
}

/** The base a manual start chose for the task's worktree (#131). Absent = the #119 default. */
export interface TaskBase {
  ref: string; // a local branch name (`hive-42-foo`) or a remote one (`origin/feature-x`), as listed by GET /tasks/:id/bases
  tellWorker: boolean; // append the base line to every stage prompt
}

/**
 * A plain branch name, the only shape a chosen base may take (#131): letters, digits, `.`, `_`, `/` and `-`, no leading `-` and no
 * `..`. rev-parse alone would also accept revision syntax (`main~1`, `main^{/text}`), and the ref lands in git's argv and, with
 * tellWorker, in every stage prompt.
 */
export const isBranchName = (ref: string): boolean => /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(ref);

/** A run command's env name (#300): `export NAME=` takes it unquoted, so the parser and the form accept only this shape; values are shellQuoted. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The names the Hive sets in every run's env (#738): ptyEnv's own, and HIVE_SECRET, which it strips. The parser and the form refuse them
 * in a workspace's or a command's env, so a run's launch.env can never replace one and a save that tries names the problem. */
export const RESERVED_ENV_NAMES = ['HIVE_PTY_ID', 'HIVE_PORT', 'HIVE_SECRET_FILE', 'HIVE_SECRET', 'TMPDIR'] as const;

/** One stage and agent's share of a task's usage (#617). stage absent: a free session, or, with no agent either, usage saved before
 * the breakdown. agent absent with a stage: a commands stage, which runs no agent. */
export interface UsagePart {
  stage?: string;
  agent?: AgentId;
  tokens: number;
  ms: number;
  waitingMs: number;
}

/** What every worker run on a task added up to (#248). The running workers' time is added on display (taskTotals). */
export interface TaskUsage {
  tokens: number; // every turn's delta, running runs included: the sum of `parts`
  ms: number; // wall clock of every finished run
  waitingMs: number; // the part of `ms` the worker spent in waiting
  parts: UsagePart[]; // #617: first-appearance order, at most one per (stage, agent)
}

/** Where the task's latest stage run started (#283): Restart brings the worktree back to `commit`, which refs/hive/<slug>/stage-start keeps alive. */
export interface StageStart {
  stage: string; // the stage the run started in: Restart is offered only while the task is still there
  commit: string; // the worktree's HEAD sha then
  after?: string; // the stage that ended at `commit`: the last stage the task ran before this one (#580); absent when none did
}

/** One Claude session the Hive started on the task: what the session popup lists for resume (#164). */
export interface Session {
  id: string; // reaches claude's argv as --resume <id>: kept on load only when isSessionId
  startedAt: string; // ISO
  stages: string[]; // every Hive stage a stage run used the session in, in order, no consecutive repeats (#236); a free run never writes it (#812)
  lastUsedAt: string; // ISO, the last time the Hive put it to work: a spawn, a continuation, a session open or resume (#236, #283)
  tokens?: number; // the last transcript total seen for this session; a worker resuming it starts from here (#248)
  repo?: true; // the worktree it ran in was removed: it opens in the workspace's main repo, its transcript moves there on first open (#208)
  name?: string; // the session's /rename title as its last turn end read it (#489): what its run's tab shows. Display text only
  free?: true; // opened by hand (#812): a free session, a copy or a captured one. Only a feedback run after its hive_done gives it stages
  agent: AgentId; // #925: the agent whose run recorded it; a session saved before reads as claude (savedSession)
  launch?: LaunchPick; // #257: what a free session was opened with, re-sent on every resume; absent = the agent's defaults
}

export type PrState = 'open' | 'merged' | 'closed';

/** A PR the task's worker opened (#207): the link, and its state as the last poll saw it. */
export interface TaskPr {
  url: string; // a GitHub pull request link, the shape hive_pr and the gh pr create detection accept
  state: PrState;
  slice?: PrSlice; // #698: hive_pr's slice; absent on single, on the detection and on old data
  sessionId?: string; // #62: the Claude session of the worker that reported the PR first (hive_pr or the gh pr create detection); absent on old data
  openedAt?: string; mergedAt?: string; closedAt?: string; // #742: ISO, as the PR poll last read them; absent until it does
}

/** A stage ended in an approval stage (#268): waits for approve or feedback. `until` present = a worker holds the Stop until then. */
export interface TaskApproval {
  since: string; // ISO, the Stop (or a free session's hive_done) that ended the stage
  until?: string; // ISO; the held Stop is released at this time
  sessionId?: string; // #812: the free session whose hive_done ended the stage; feedback and the handoff go to it
}

/** The longest feedback the Hive takes (#268), in characters: the route, the loader and the panel's box. */
export const FEEDBACK_MAX = 10_000;

/** The rows of a worktree preparation as the Start dialog shows them (#390): the worktree, its branch, each nested repo (#450), or one setup
 * step after LOAD's expansion. */
export const SETUP_ROW_KINDS = ['worktree', 'branch', 'nested', 'step'] as const;
export type SetupRowKind = (typeof SETUP_ROW_KINDS)[number];
export const SETUP_ROW_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type SetupRowStatus = (typeof SETUP_ROW_STATUSES)[number];
/** One row of a worktree preparation as the Start dialog shows it (#390). */
export interface SetupRow {
  kind: SetupRowKind;
  status: SetupRowStatus;
  label?: string; // step: the RUN's command, else describeStep's text; nested: the repo's path, as nestedRepos lists it
  header?: string; // step: describeStep's text; nested: `nested <path>`; what the run's header line holds after `> `
  branch?: string; base?: string; // branch: what it is made from; nested, once done: the task's branch, and its base unless it was reused
  startedAt?: string; // ISO, while running
  durationMs?: number; // done or failed; absent on a step skipped by a resume, on the branch row, and on a nested repo refused before it started
  code?: string; // failed: a RUN's exit code, 'timeout' or 'stopped'
}

/** A task's worktree setup while it runs (#351), in both the stage spawn and a first /open: the one place the task and the dialog read it. */
export interface TaskSetup {
  consoleId: string; // its run's id in the console's one setup channel (#353, SETUP_CHANNEL): what the ver log buttons open
  step?: string; // the step running, as describeStep writes it; absent before the first one
  rows: SetupRow[]; // #390: the worktree, the branch and each step, as the Start dialog shows them
}
/** A setup's run and its rows (#390): the live setup's, or the last failed one's (Activity.lastSetup). */
export type SetupRows = Pick<TaskSetup, 'consoleId' | 'rows'>;

/** One failed command of a commands stage (#755): its name, its exit code (124 after its timeout) and the tail of its output. */
export interface CommandFailure { name: string; code: number; output: string }
/** A commands stage in flight (#755): the stage, the index of the command running, that command's pty, and the failures so far. Persisted so
 * the boot can stop it; it never survives the boot. */
export interface StageCommands {
  stage: string; at: number; ptyId: string; runId: string; failed: CommandFailure[]; workerId: string; // runId: the first command's ptyId, kept to the last: what groups the execution's console runs; workerId: the worker the run holds (#727)
  started: string[]; // #914: each command's start (ISO) by index; '' for one whose pty never started
  outputAt?: string; // #914: the current command's last output, throttled to 30 s; dropped when the next command starts
  skipped?: number[]; // #914: the indexes onMissing skip passed over, so the running block says pulado
}
/** How a commands stage's failure starts on its activity's error (#755), the failed commands after it: the card shows it in the viewer's language. */
export const CHECKS_FAILED = 'checks failed: ';
/** How a failed start begins on its activity's error (#945), the spawn's raw message after it: the page shows its spawnFailureCode's short
 * message in the viewer's language, the raw text only behind details. State.error keeps the raw message. */
export const SPAWN_FAILED = 'start failed: ';
/** The code POST /tasks/:id/start answers with when git refuses to discard a task's orphan worktree or branch (#861): the dialog heads git's words
 * with its own line. */
export const DISCARD_FAILED = 'discard_failed';
/** One CI check on a PR's last commit as a wait for CI reads it (#834): #758's PrCheck (success, failure or pending; url: its page), with the
 * PR it was read on and, for a check run, the Actions run behind it: what a re-run and the log fetch name. */
export interface CiCheck extends PrCheck { pr: string; runId?: number }
/** One open PR's CI as one read saw it (#834): its last commit and that commit's checks; required: its base branch's required check names,
 * absent when the branch protects none; awaiting: workflows awaiting a maintainer's approval; canPush false: the login may not re-run there (#854). */
export interface CiPrRead {
  url: string; head: string; base?: string; conflicting?: true; // #264: base is the PR's baseRefName; conflicting only on CONFLICTING
  required?: string[]; checks: CiCheck[]; awaiting?: string[]; canPush?: boolean; noCi?: true; // noCi: #11
}
/** A failed Actions run to re-run (#834), by its repository (owner/name) and id. */
export interface CiRerun { repo: string; runId: number }
/** One considered check as the running block shows it (#914): completedAt only once it finished; url only an https link. */
export interface StageCiCheck { name: string; state: PrCheck['state']; url?: string; startedAt?: string; completedAt?: string }

/** A wait-for-CI stage in flight (#834): when it started (the timeout's clock), the head commits whose failures were re-run, the last read's
 * count for the card, and the flags that keep a read from acting twice. Persisted: the wait goes on after a boot. */
export interface StageCi {
  stage: string; since: string; reran: string[];
  rerunAt?: string; // when the last re-run was asked (ISO): a failure on a re-run head completed by then is the old one, still read as pending
  done?: number; total?: number; waitingPr?: true; // the last read, for the card
  collecting?: true; // the failed logs are being fetched; dropped on boot
  fellBack?: true; // required fell back to all and the fact log said so, once
  awaiting?: number; // #854: workflows awaiting a maintainer's approval at the last read, for the card; dropped by a read without any
  noRerun?: true; // #854: a failure rerunOnce could not re-run (no push rights): the wait holds for a new push or a maintainer
  checks?: StageCiCheck[]; // #914: the last read's considered checks, ordered for the running block; not persisted, the next read writes them
}
/** How a wait-for-CI stage's failure starts on its activity's error (#834), the failed checks after it: the card shows it in the viewer's language. */
export const CI_FAILED = 'CI failed: ';

/** An evaluate stage in flight (#877): its stage, its id (what a late answer and the Stop name), the worker it holds, its start and its phase.
 * Persisted so the boot stops it; it never survives the boot. */
export interface StageEvaluate { stage: string; runId: string; workerId: string; startedAt: string; phase: 'reviewing' | 'judging' }
/** One reviewer's finding (#877), with its evidence: a file, the line when it has one. */
export interface ReviewFinding { file: string; line?: number; finding: string }
/** The judge's score for one rubric dimension (#877), 0 to 10, with its evidence. */
export interface JudgeScore { dimension: string; score: number; evidence: string }
/** How a broken evaluation starts on its activity's error (#877): no verdict, no try; the reason follows. */
export const EVALUATION_FAILED = 'evaluation failed: ';
/** How a failed evaluation with no failed transition starts on its activity's error (#877): the failing dimensions follow. */
export const EVALUATION_REJECTED = 'evaluation rejected: ';
/** What fires a transition (#134): the stage ended with no approval, the user approved, the user sent feedback, or the stage gave a verdict. */
export const TRIGGERS = ['done', 'approved', 'feedback', 'verdict'] as const;
export type Trigger = (typeof TRIGGERS)[number];
/** A transition's `to` that takes the task out of the Hive (#134), as the end of the last stage did. No stage may take the name. */
export const END = 'end';
/** The session a transition hands its destination (#134): the run that just ended, the task's last session in that stage, or a new one. */
export type TransitionSession = 'previous' | 'new' | { continueOf: string };

/** One arrow of the flow (#134): where a stage's end sends its task. (from, when, verdict) is unique and is the transition's key. */
export interface Transition {
  from: string;
  to: string; // a stage name or END
  when: Trigger;
  verdict?: string; // with when verdict only
  label?: string; // the arrow's pill; absent = derived from the trigger or the verdict
  prompt?: string; // template: {verdict} {feedback} beside today's placeholders
  session?: TransitionSession; // absent = the destination stage's session
  maxTries?: number; // done / verdict only; absent = no limit
  sources?: Record<string, SourceAction[]>; // what each source does as the task passes (was Stage.onFinish)
}

/** The verdicts a commands or a wait-for-CI stage gives (#134): fixed, editable nowhere. */
export const FIXED_VERDICTS = ['passed', 'failed'] as const;
/** How a stage end no transition matches starts on its activity's error (#134), the exit after it (`approved`, `verdict:failed`): the card
 * shows it in the viewer's language. */
export const NO_TRANSITION = 'no transition: ';
/** How a transition whose tries ran out starts on its activity's error (#134): `verdict:failed · 3`, the exit and the limit. */
export const TRIES_OUT = 'tries out: ';
/** How a task halted because the stage its run started in was deleted, or its stage is unknown, starts on its activity's error (#861), that
 * stage's name after it: the card shows it in the viewer's language. */
export const STAGE_GONE = 'stage gone: ';
/** What a transition tells its destination's next run (#134): the composed, rendered prompt and the session it resumes; none = a new one. */
export interface Handover { prompt: string; sessionId?: string }

/** One automatic try through a transition with maxTries (#915): what the try history reads. */
export interface TryRecord {
  transition: string; // transitionKey
  n: number; // this try's number, 1-based
  max: number; // the transition's maxTries at the time
  cause: string; // the failed command or check names, or the exit name
  error: string; // first non-blank line of the output or the evidence; '' when none
  at: string; // ISO
  stage: string; // the destination stage, or END
  sessionId?: string; // the destination's resumed session, when the handover names one
}

/** A column the Hive wrote to the source and the source has not shown yet (#889): what a stale poll must not undo. */
export interface ColumnWrite {
  column: string; // the column written
  stale: string[]; // the columns a poll may still show from before the write
  at: string; // ISO, when the write was emitted: the mark expires COLUMN_WRITE_TIMEOUT_MS after it
}

/** A source task inside the Hive: it exists while it sits in a stage, running or not. */

export interface Task {
  item: Item;
  stage: string; // the Hive stage the task sits in (#286: the Hive's own columns are stages)
  boardColumn: string; // where the Hive last saw or left it on the source; the poll compares against it
  missing?: true; // gone from the source; waits for close or keep
  orphan?: true; // kept after going missing: runs to the end, no source writes, ignored by the poll
  enteredAt?: string; // ISO, when the task entered its current stage: what `after` counts from. Stamped by the next poll when absent (upgrade)
  leaving?: true; // an archive / remove / delete is in flight on the source (#286): out of the fill, left unmarked by the poll, answered by closeTask or sourceActionFailed; never survives a boot
  pinned?: true; // moved by hand: holds the position it occupies in its stage across polls. Dropped by resetOrder and by a stage change (#123)
  created?: true; // created in the Hive (#132, #573: was local): never written to a source, never marked missing by the poll; leaves only through remove
  auto: boolean; // a worker may pick it up on its own (#164, #573: was manual?: true, inverted); off, the fill never starts it and a delete-activity stage takes it only under nonAutoTasks (#496); every run by hand works on it as on any task
  workspace?: string; // a Comb workspace's name: chosen by hand, or frozen when the worktree was created (#179)
  columnWrite?: ColumnWrite; // set with every setColumn effect, cleared by the poll that confirms, overrides or outlives it (#889)
}

/** The work in progress inside a workspace (glossary: activity): a task's worktree and branch, or the checkout, and its run. Deleting the
 * activity removes it; its ActivityRecord (same id) stays. */
export interface Activity {
  id: string; // randomUUID() for a task's activity; `local:<workspace>` for a workspace's local activity
  kind: 'task' | 'local';
  workspace: string; // frozen at creation
  slug?: string; // task activities: from the first task's slugFor; names the worktree path, the branch template and the prompt file
  worktree?: string; branch?: string; worktreeGone?: true;
  local?: true; // runs in the workspace's checkout (#444), set by a start's popup
  base?: TaskBase; // #131, set by a start's popup
  runPick?: RunPick; // #290: a manual start's picks, written by start and taken off by the occupy of the same reduction
  setup?: TaskSetup; deleting?: true; // never survive a boot
  lastSetup?: SetupRows; // #390: the last setup that failed, its run and rows, for the Start dialog once the mark is gone; dropped by the next setupStarted and a manual start; persisted like error
  commands?: StageCommands; // #755: a commands stage in flight: the task is running; persisted so the boot stops it, never past the boot
  ci?: StageCi; // #834: a wait-for-CI stage in flight: no worker, no process; persisted, so the wait goes on after a boot
  evaluate?: StageEvaluate; // #877: an evaluate stage in flight: the task is running; persisted so the boot stops it
  sync?: ForkSyncResult; // #854: the last automatic fork sync before this activity's worktree, failed or not; persisted while the activity lives
  sessionId?: string; // what a continue resumes
  workerId?: string; stopped?: true; stageStart?: StageStart; error?: string;
  stoppedAt?: string; // ISO, when `stopped` was set (#580): the status box's time. Goes wherever `stopped` goes
  approval?: TaskApproval; handover?: Handover; // #134 (was #268's feedback): what the next spawn tells and the session it resumes, composed at the transition
  handoffPending?: string; // #692, #134: the key of the transition whose destination asked for the handoff: the end after it takes that one
  handoffFeedback?: string; // #134: the user's feedback that transition fires with, so its {feedback} survives the handoff turn; goes with handoffPending
  tries?: Record<string, number>; // #134: transitionKey → the automatic tries the task took through it; dropped by a user's transition and a move by hand
  via?: string; // #134: the key of the transition the task entered its stage through: what the card's tries read; replaced on every transition
  tryLog?: TryRecord[]; // #915: the tries behind tries, oldest first; dropped wherever tries is
  freeSessionStage?: string; // #812: the stage a free run last started in; continue is not offered there until a stage run starts or the task enters a stage again
  checkpoints?: Checkpoint[]; // #619: in capture order; absent when none. Goes with the activity's delete
  stageGone?: string; // #861: the deleted stage the running worker or stage action started in: its end ends no stage and the task halts with STAGE_GONE. Cleared wherever stopped is set or a stage is entered; never persisted (a boot ends the run it marks)
}

/** How a checkpoint ended (#619): its stage's hive_done, a Restart, or a restore that replaced it. */
export type CheckpointEnd = 'done' | 'restart' | 'restore';

/** One checkpoint of a stage (#619): the worktree as it was when the checkpoint ended, kept by refs/hive/<slug>/checkpoint/<n>. */
export interface Checkpoint {
  n: number; // 1-based, per task; also the ref's last segment
  stage: string; // the stage the checkpoint ran in
  start: string; // the stageStart commit the checkpoint started from
  head: string; // HEAD when captured
  commit: string; // the restore point: `head` itself when the worktree was clean
  branch: string; // the branch HEAD was on
  at: string; // ISO, when captured
  ended: CheckpointEnd;
}

/** What an activity produced (glossary: activity record): born with it under the same id, outlives its deletion. */
export interface ActivityRecord {
  id: string;
  taskIds: string[]; // item ids; exactly one on a task's activity in this spec, [] on a local one
  slug?: string; // a task activity's slug, kept past its deletion: where its kept sessions' transcripts sit (#208)
  sessions: Session[]; // oldest first; `repo: true` once the activity is deleted
  result?: Record<string, unknown>; // merged from every hive_done
  prs?: TaskPr[];
  usage?: TaskUsage;
  stageRuns?: Record<string, number>; // #742: stage name → stage runs started there (spawn, restart, continue, feedback); absent = none. facts.jsonl's attempt
}

/** A task as the adapter lists it: which source column it is in, in source order. */
export interface SourceItem {
  item: Item;
  column: string;
}

/** Why a session slept (#672): a manual sleep of one session (a close-tab sleep included), the auto flow ending a stage's run, the idle
 * shutdown, a sleep all. Each has its own notice switch. */
export type SleepCause = 'manual' | 'auto' | 'idle' | 'all';

/** The most sleeping runs the Hive keeps (#672): past it the oldest forgets its transcript, which bounds memory when no tab ever closes. */
export const SLEPT_MAX = 20;

/** A run that ended with its session kept (#672): its tab stays open on its transcript until the tab closes, the session continues, or it
 * falls out of the last SLEPT_MAX. taskId: a task's run; workspace: a local session's. cause: absent when the run ended on its own (a /exit). */
export interface SleptRun {
  ptyId: string; agent: AgentId; kind: 'session' | 'stage'; stage?: string; taskId?: string; workspace?: string; cause?: SleepCause;
  sessionId?: string; // #931: absent only on a session run the Hive put to sleep before its first SessionStart (Codex): it wakes into a new session
  at: number; // epoch ms of the end
}

export interface Worker {
  id: string;
  runId?: string; // uuid per spawn, the run (#570); stale exit/hook signals from a previous run are ignored
  activityId?: string; // #629: the activity the run works in, a task's or a workspace's local one; set on every worker that runs
  copyOf?: { from: string; dir: string }; // a copy's run until its SessionStart (#587): the source id and the transcript dir holding the temporary <from>.jsonl; never survives a boot
  status: Status;
  draining?: boolean;
  tokens?: number; // session total at the last Stop / SessionEnd; the next delta is measured against it. A resumed session starts from its Session.tokens (#248)
  startedAt?: string;
  lastEvent?: WorkerEvent;
  question?: string;
  sessionId?: string; // Claude Code session id from SessionStart; must coincide with Activity.sessionId. First one wins (#24); a /clear's SessionStart replaces it (#655)
  done?: true; // hive_done received in this run: the next Stop ends the stage. Cleared on spawn and on continuation
  verdict?: string; // #134: the verdict this run's hive_done gave; its Stop routes by it. Cleared with done
  freeSession?: true; // the user's own session (#164, #283): no stage and no prompt; the Hive's MCP is on, so hive_done advances the task; activityId set, Activity.workerId not
  waitingSince?: string; // ISO; stamped when the worker enters waiting, kept while it stays there, dropped on any other status (#233)
  waitedMs?: number; // the finished waiting intervals of this run, added as the worker leaves waiting (#248)
  seenAt?: string; // ISO, the last hook of this run: where boot closes it (#248)
  blocked?: true; // #294: hive_stop's block, set with its kill: its exit leaves the activity unstopped, the blockers gate the restart
  ending?: SleepCause; // #672: why the Hive asked this run to end (a sleep, a sleep all, the idle shutdown), set with its kill, read on its end
  forgotten?: true; // #672: its sleeping tab closed before it exited: its end records nothing
  terminalId?: string; // #696: a free session the claude shim captured, whose run lives in this terminal's pty
  resumed?: true; // #347: a capture of a resume: its first SessionStart, while it has no id yet, checks its cwd against the terminal's folder and looks up the session's owner
  backoff?: WorkerBackoff; // #805: set with status backoff while the run waits out an API error
  apiErrors?: number; // #805: consecutive transient failures since the last Stop, 1..BACKOFF_RETRIES; a rate-limit wait adds none
  agent?: AgentId; // #925: what its run runs, set with the run; absent only on a commands stage's worker, which runs no agent
  launch?: LaunchPick; // #257, #290: what this run launches with: a free run's open or resumed session's picks, or a manual stage run's picks
  stage?: string; // #617: the stage this run counts its usage for, set with the run and moved by an in-place continuation; absent on a free session
  foldedMs?: number; // #617: the run's time already folded into the stages an in-place continuation left; runShare counts past it
  foldedWaitingMs?: number; // #617: the waiting inside foldedMs
}

/** A line of the menu bar's list (#192): what GET /ptys returns per live pty (#570), a worker's run or a terminal (#283). */
export interface LivePty {
  id: string; // a worker's runId or a terminal's terminalId: what POST /ptys/:id/stop goes by (#283, #570)
  taskId?: string; // item.itemId: the menu line opens that task's panel; absent: a workspace's terminal (#292) or local session (#587), whose line only shows the source
  status: Exclude<Status, 'empty'> | 'terminal'; // a terminal has no hook to report a status: marked as such
  label: string; // taskLabel(task), as the footer chips show it; a workspace's terminal or local session: the workspace's name (#292)
}

/** A plain terminal the user opened (#283, #570) in an activity (#629): a task's, in its worktree, or a workspace's local one, in its checkout
 * (#292). No worker and no cap; the pool runs it in a pty like any run, so Stop, Quit and its tab reach it. A terminal is not a session: no run.
 * Kept until forgotten (#696): asleep, it holds no pty and wakes in the same id. */
export interface Terminal {
  terminalId: string; // uuid: what the pool, the exit trailer and Stop know it by
  startedAt: string; // ISO
  command?: string; // the Command's name (#300), task terminals only: the pool looks it up when it starts; absent = a plain terminal
  activityId: string;
  cwd: string; // #696: where it wakes: the shell's cwd as it went to sleep, else its start dir
  asleep?: true; // #696: kept with no pty; absent = live
  woken?: true; // #696: it ran and slept before, so a failed spawn sleeps it again; absent, a failed spawn is its first open's and it goes
}

export interface State {
  signal: Signal; // runtime gate for new jobs; lives here, not in the config, so a red set by hand survives a restart
  signals: SignalSettings; // copied from Config.signals wherever the live state is created and by setSignals on a save that changes it (#727); boot reads onOpen from it
  maxConcurrent: number;
  workers: Worker[];
  terminals: Terminal[]; // the terminals of tasks (#283) and workspaces (#292); a plain one is kept asleep across a boot (#696), a command's run never
  stages: Stage[]; // copied from the config's stages on boot and by setStages; the pipeline order (#286)
  transitions: Transition[]; // #134: copied from the config with the stages, on boot and by setStages
  workspaces: string[]; // the Comb's workspace names, from the config on boot and on every save (#179); what resolveWorkspace reads
  sourceWorkspaces: Record<string, string>; // source name → its default workspace (#179, #180), from the config on boot and on every save
  workspaceColors: Record<string, string>; // #78: the Comb's workspace colours by name, from the config like workspaces; never from state.json
  commands: Record<string, string[]>; // workspace name → the names of the run commands enabled in it (#300, #511), from the config on boot and on every save: what the menu and the panel list; never the lines nor the env
  syncs: Record<string, SourceSync>; // each source's sync by name (#180), keys from the config on boot and on every save (setSources); its poll time, quota and last failure
  tasks: Task[]; // every task the Hive holds, in the Hive's order: the anchored tasks (pinned, running, unlisted) keep their index across polls, the rest follow the source
  activities: Activity[]; // #629: every live activity, a task's and each workspace's local one; delete activity removes it, its record stays
  activityRecords: ActivityRecord[]; // #629: what each activity produced, in creation order; pruned once no live activity and none of its tasks needs it
  sourceOrder: string[]; // item ids as the adapter last listed them; what resetOrder sorts a stage by. Never written to the source
  localCount: number; // the last local number handed out (#132); only grows, so a removed task's id is never reused
  usage: UsageSample[]; // last 24 h, oldest first; one sample per worker turn
  budget: Budget; // copied from Config.budget by setBudget
  usageRules: UsageRule[]; // copied from Config.usageRules by setUsageRules
  disabledRules: DisabledRule[]; // fired rules switched off from the strip (#297): reduce drops an expired one, setUsageRules one whose rule is gone
  deleteActivity: DeleteActivityScope; // copied from Config.deleteActivity wherever the live state is created and by setDeleteActivity on a save that changes it (#236, #573)
  shutdownIdleMinutes: number; // copied from Config.shutdownIdleMinutes wherever the live state is created and by setShutdownIdle on a save that changes it (#233)
  approvalMinutes: number; // copied from Config.approvalMinutes wherever the live state is created and by setApprovalMinutes on a save that changes it (#268)
  rateLimitWaitMinutes: number; // copied from Config.rateLimitWaitMinutes wherever the live state is created and by setRateLimitWait on a save that changes it (#805)
  benchmark: BenchmarkState; // #458: the experiments, saved in state.json and loaded through benchmark-guards.ts; initialState gives { experiments: [] }
  defaultAgent?: AgentId; // #925: copied from Config.defaultAgent wherever the live state is created and by setDefaultAgent on a save that changes it; absent only on a state built by hand (a test's): liveDefaultAgent reads DEFAULT_AGENT then
  shutdown?: { armedAt: string }; // shutdown when done (#233): absent = off; set and cleared by setShutdown, cleared with the shutdown effect and by boot
  keepAwake?: true; // keep awake (#226): absent = off. Set and cleared by setKeepAwake, cleared at boot and with the shutdown effect.
  cleanStop?: true; // set by quit (#283): the kills of a Quit are not exits, and the next boot resumes the tasks in flight
  crash?: { at: string; tasks: string[] }; // the item ids a boot after a crash stopped (#283): the source lists them until dismissCrash
  slept?: SleptRun[]; // #672: the runs that ended with their session kept, newest last, at most SLEPT_MAX; never saved (state-store.ts)
  rateLimits?: PlanReadings; // #929: one reading per agent, read by the plan rules and the header; an agent with none has no key
  error?: string;
}

/** What the GitHub adapter does with an issue that has sub-issues (#30): ignore = a regular task; show = listed with its children, stamped
 * `item.epic`, never run, its stage computed from its children's (#31, src/epic-follow.ts); hide = dropped, only its sub-issues are tasks.
 * The parser and the source's select read EPICS_MODES. */
export const EPICS_MODES = ['ignore', 'show', 'hide'] as const;
export type EpicsMode = (typeof EPICS_MODES)[number];
/** Which child an epic's stage follows (#30, computed by #31): the furthest behind, the furthest ahead, or ahead up to switchAt and behind after. */
export const EPIC_FOLLOWS = ['behind', 'ahead', 'aheadThenBehind'] as const;
export type EpicFollows = (typeof EPIC_FOLLOWS)[number];
/** A new source's epics keys (#27, #30). The parser itself has no default. */
export const NEW_SOURCE_EPICS: { epics: EpicsMode; epicFollows: EpicFollows } = { epics: 'show', epicFollows: 'aheadThenBehind' };
/** The stage a new source switches at, else the flow's first (#30). */
export const SWITCH_AT_DEFAULT = 'Build';

/** The coding agents a stage can run (#516): ids only, their per-agent facts live in agents.ts. #101 adds codex here and there. */
export const AGENT_IDS = ['claude', 'codex'] as const; // #927: codex runs flow stages; its free sessions are #931
export type AgentId = (typeof AGENT_IDS)[number];
/** One headless run of an evaluate stage (#877): its agent and launch picks; focus on a reviewer only. */
export interface EvaluateRow { agent: AgentId; model?: string; specializedAgent?: string; focus?: string }
/** What a new form offers as the default agent and what a file from before #516 reads as. */
export const DEFAULT_AGENT: AgentId = 'claude';

// ── Benchmark (#458): the contract types.benchmark of docs/agent/hive/specs/2026-10-21-benchmark-view-decomposition.md, "Data model".
// Experiments live in State so the UI reads them from the one /events stream; the heavy artifacts stay files under the experiment folder.
export type ExperimentStatus = 'draft' | 'running' | 'sleeping' | 'done';
export type BenchStageRole = 'spec' | 'plan' | 'build' | 'pr';
/** What a stage of a run is: the agent, its model and the skill or command the stage prompt calls (`/hive:new-build`, `/hive-build`). */
export interface BenchStagePick { agent: AgentId; model?: string; skill: string; prompt: string } // prompt: the stage's prompt, {id}/{title}/{body} left for the Hive
export interface BenchTask { key: string; title: string; body: string; blockedBy: string[] }
export interface BenchRules { allow: string[]; deny: string[] }
/** The base, and what an arm overrides of it: the same shape, every field optional on the arm. */
export interface ArmSetup {
  stages: Record<BenchStageRole, BenchStagePick>; plugins: string[]; rules: BenchRules; tasks: BenchTask[];
  items: Record<string, string>; // itemId (`origin:name`) → custom version name; an item absent runs its original
  worktree: { setup: string; teardown: string }; // the workspace's Settings syntax (COPY / RUN lines)
}
/** What an arm changes of the base (#462): each stage per role and per field, so overriding build's agent never freezes spec; the rest whole.
 *  A stage's model null is the agent's own default over a base model; absent keeps the base's. */
export type ArmOverrides = Partial<Omit<ArmSetup, 'stages'>> & { stages?: Partial<Record<BenchStageRole, Partial<Omit<BenchStagePick, 'model'>> & { model?: string | null }>> };
export interface Arm { id: string; letter: string; name: string; overrides: ArmOverrides }
export interface BenchScenario { id: string; title: string; text: string }
/** The seed: the problem, the same for every arm. Its hash covers every field; a change forks the experiment (1.2). */
export interface BenchSeed { workspace: string; commit: string; reference: string[]; sample: { command: string; url: string; files: string[] }; scenarios: BenchScenario[] }
export interface BenchPace { pairs: number; until?: string; runTimeoutMs: number; workersPerArm: number; cap: { tokens?: number; planPercent?: number } }
/** One isolation row: the value every arm gets, or a value per arm id when the row varies. */
export interface IsolationRow<T> { all: T; perArm?: Record<string, T> }
export interface BenchIsolation {
  environment: IsolationRow<'local'>; network: IsolationRow<string[]>; permissionMode: IsolationRow<string>;
  allowedTools: IsolationRow<string[]>; deniedTools: IsolationRow<string[]>; limits: IsolationRow<{ turns?: number; ms?: number }>;
  env: IsolationRow<Record<string, string>>; betweenRounds: IsolationRow<'fresh-worktree'>;
}
export interface BenchBlindness { on: boolean; forbiddenWords: string[] }
/** Static collectors, the tester and the judge are #877's EvaluateRow (agent, model?, specializedAgent?, focus?); the tester's focus is unused and
 *  scenarioWalks (>= 1) is how many times it walks the seed's scenarios. The rubric is one criterion per non-blank line, scored 1–5. */
export interface BenchEvaluation { collectors: EvaluateRow[]; dynamic: boolean; tester: EvaluateRow; scenarioWalks: number; judge: EvaluateRow; rubric: string }
export interface Experiment {
  id: string; name: string; status: ExperimentStatus; archived?: true; createdAt: string; createdBy: { kind: 'user' } | { kind: 'mcp'; agent: AgentId; model?: string };
  workspace: string; plugin: { version: string; hash: string }; seedHash: string; tasksHash: string;
  base: ArmSetup; arms: Arm[]; seed: BenchSeed; pace: BenchPace; isolation: BenchIsolation; blindness: BenchBlindness; evaluation: BenchEvaluation;
  rounds: BenchRound[]; sleeps: BenchSleep[]; stopAfterRound?: true;
}
export interface BenchRound { n: number; startedAt?: string; endedAt?: string; evaluatedAt?: string; runs: BenchRun[] }
/** A task's segment in the execution tab's bar (#465): the watcher's state for it, green done, yellow waiting on the user, grey open. */
export type TaskProgressState = 'done' | 'waiting' | 'open';
export type BenchRunStatus = 'queued' | 'running' | 'waiting' | 'sleeping' | 'done' | 'timeout' | 'error' | 'interrupted';
export interface BenchRun {
  token: string; armId: string; round: number; status: BenchRunStatus; reason?: string; home: string; branch: string;
  startedAt?: string; endedAt?: string; sleptMs: number; delivered: number; total: number;
  progress?: TaskProgressState[]; // #465: one per task in seed order, written with delivered / total; absent before the first progress
  metrics?: BenchMetrics; evaluation?: BenchRunEvaluation; interventions: Intervention[]; inMedian?: boolean;
  unpriced?: string[]; // #473: models off the price table, costed 0
}
export interface BenchTaskMetrics { key: string; title: string; tokens: number; ms: number; waitingMs: number; stages: { stage: string; ms: number }[]; restarts: number }
export interface BenchMetrics { tokens: number; costUsd: number; ms: number; waitingMs: number; restarts: { count: number; where: string[] }; diff: { files: number; insertions: number; deletions: number }; tests: { green: number; total: number }; tasks: BenchTaskMetrics[] }
export interface CollectorResult { name: string; status: 'ok' | 'warn' | 'error'; summary: string; findings: ReviewFinding[] }
export interface ScenarioResult { id: string; passed: number; total: number; screenshots: string[] }
export interface BenchRunEvaluation { at: string; collectors: CollectorResult[]; scenarios: ScenarioResult[]; judge: { agent: AgentId; model?: string; rubricHash: string; scores: JudgeScore[] } }
export interface Intervention { at: string; action: string; detail: string; by: 'user' }
export interface BenchSleep { round: number; at: string; wokeAt?: string; reason: string }

export interface BenchmarkState { experiments: Experiment[] }
export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ['draft', 'running', 'sleeping', 'done'];
export const BENCH_RUN_STATUSES: readonly BenchRunStatus[] = ['queued', 'running', 'waiting', 'sleeping', 'done', 'timeout', 'error', 'interrupted'];
/** An experiment id and a run token as 1.2 and 3.1 must generate them: they name folders and, upper-cased, a task prefix. */
export const EXPERIMENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BENCH_TOKEN = /^[a-z0-9]{4,16}$/;

export type ExperimentPatch = Partial<Pick<Experiment, 'name' | 'base' | 'seed' | 'seedHash' | 'tasksHash' | 'pace' | 'isolation' | 'blindness' | 'evaluation'>>;
export type BenchRunPatch = Partial<Pick<BenchRun, 'status' | 'reason' | 'delivered' | 'total' | 'progress' | 'sleptMs' | 'metrics' | 'evaluation' | 'interventions' | 'inMedian' | 'unpriced'>>;
/** An experiment's life (#458): the routes build what needs I/O and check the transitions; benchmark-reducer.ts only applies. */
export type BenchmarkEvent =
  | { type: 'benchmarkCreated'; experiment: Experiment } // empty and duplicate alike
  | { type: 'benchmarkEdited'; id: string; patch: ExperimentPatch }
  | { type: 'benchmarkForked'; from: string; experiment: Experiment } // `from` is left untouched
  | { type: 'benchmarkArchived'; id: string; archived: boolean }
  | { type: 'benchmarkDeleted'; id: string }
  | { type: 'benchmarkArmAdded'; id: string; arm: Arm }
  | { type: 'benchmarkArmEdited'; id: string; armId: string; patch: Partial<Pick<Arm, 'name' | 'overrides'>> }
  | { type: 'benchmarkArmRemoved'; id: string; armId: string }
  | { type: 'benchmarkArmsCopied'; id: string; from: string; what: 'overrides' | 'tasks'; to: string[] }
  | { type: 'benchmarkRunStarted'; id: string; run: BenchRun }
  | { type: 'benchmarkRunChanged'; id: string; token: string; patch: BenchRunPatch }
  | { type: 'benchmarkRunEnded'; id: string; token: string; status: 'done' | 'timeout' | 'error'; at: string; reason?: string }
  | { type: 'benchmarkRoundEnded'; id: string; round: number; at: string }
  | { type: 'benchmarkRoundEvaluated'; id: string; round: number; at: string }
  | { type: 'benchmarkSlept'; id: string; sleep: Omit<BenchSleep, 'wokeAt'> }
  | { type: 'benchmarkWoken'; id: string; at: string }
  | { type: 'benchmarkStopAfterRound'; id: string; on: boolean }
  | { type: 'benchmarkFinished'; id: string };

/** Whether an agent's CLI is on this machine, checked once on boot (#516). */
export interface AgentAvailability {
  agent: AgentId;
  available: boolean;
}

/** What a free session was opened with (#257): absent fields are the agent's defaults. Each value reaches the run's argv as its own word. */
export interface LaunchPick {
  model?: string; // behind --model (Claude) or -m (Codex)
  specializedAgent?: string; // a Hive plugin agent, hive:<name>
  args?: string[]; // after config.agentArgs[agent]
}

/** What a manual start asks its stage run to launch with (#290), checked by the start route. Absent fields are the stage's own: no agent is the
 * stage's agent, no session its session policy, no model what runModel resolves without a pick. */
export interface RunPick {
  agent?: AgentId;
  resume?: string | null; // a session id of the task to resume; null = a new session; absent = the stage's session policy
  launch?: LaunchPick; // model, specialized agent, args (#257)
}

/** One model a list of GET /launch-options offers (#257). hint: the muted right-hand text (e.g. "opus 5.5"). */
export interface LaunchOption { id: string; hint?: string }

/** One agent's picks the new session dialog offers (#257). */
export interface AgentLaunchOptions {
  aliases: LaunchOption[]; // Codex: []
  versions: LaunchOption[];
  specializedAgents: { name: string; description: string }[]; // hive:<name>, sorted by file
  skills: { name: string; description: string }[]; // #710: the folder's skills, bare names (shown hive:<name>), sorted by name
  args: string[]; // config.agentArgs[agent]: the dialog's "added to the global ones" and "runs" lines
}

/** GET /launch-options (#257). */
export type LaunchOptions = Record<AgentId, AgentLaunchOptions>;

/** One file of a task's result the panel links (#258). */
export interface TaskFile {
  key: string; // the result key, e.g. spec
  path: string; // as the result holds it: relative to the worktree (or the workspace once it is gone), ../ or absolute (#697)
  base: 'worktree' | 'workspace' | 'outside'; // which folder holds it; outside: neither, a separate docsRepo or any other path (#697)
}

/** One of an activity's files as the editor pane holds it (#717): GET /activities/:id/file. version: the sha256 (hex) of its bytes. */
export interface FileText { path: string; text: string; version: string }

/** The largest file the editor pane opens or saves (#717), in bytes. */
export const EDITOR_FILE_MAX = 1_048_576;

/** The image files the file tab shows as images (#498): extension (lower case, with the dot) to the type the image route answers with. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
/** Where a failed format run is in the console (#749): its channel's id and the run's, what the editor pane's ver log opens. */
export interface FormatLog { channel: string; run: string }

/** PUT /activities/:id/file's answer (#717, #749): the written version; text when the formatter changed what was sent; formatError and formatLog
 * when it failed and the text went as sent. */
export interface FileSaved { version: string; text?: string; formatError?: string; formatLog?: FormatLog }

/** What a file's changes compare against (#668): HEAD, or the task's base, the merge-base the diff pane's worktree scope diffs from. */
export type ChangesBase = 'head' | 'task';

/** GET /activities/:id/file-base (#668). label: HEAD or the diff pane's base label. oid: the base blob's id, absent when the base does not have
 * the file or there is no base. text: present when the base has the file and the request's oid differs; '' for a file the base does not have;
 * absent with no base at all (outside a repository, a binary, oversized or not-UTF-8 blob). */
export interface FileBase { against: ChangesBase; label: string; oid?: string; text?: string }

/** A file's git mark in the files sidebar (redesign 07): M changed, A new (staged or untracked), D deleted (#903). */
export type GitMark = 'M' | 'A' | 'D';

/** A task's worktree as the files sidebar lists it (redesign 07): every path git does not ignore, relative to the worktree, and the marks;
 * its empty folders (#818), relative; and its root, absolute (#818): copy path, the clipboard and the untitled save need it, and a local
 * activity has no worktree on the page; and what git ignores, with the nested repositories (HIVE-22), outermost. A `D` path is in `marks`
 * only, never in `files`: its folders take the mark (#903). `checkout` (#131) is the root relative to the workspace's main checkout, absent
 * when the root is that checkout. `branch` (#713) is the branch the root has out, absent on a detached HEAD: a local activity has no branch of
 * its own, and the tree's polling follows a checkout switch. */
export interface TaskTree {
  root: string;
  checkout?: string;
  branch?: string;
  files: string[];
  marks: Record<string, GitMark>;
  folders: string[];
  ignored: IgnoredEntries;
}

/** The `tree` event on /events (#502): a leased root changed. `paths` relative to the root, `/`-separated; absent means anything. */
export interface TreeChange { type: 'tree'; activityId: string; paths?: string[] }

/** The worktree's entries git ignores, and its nested repositories (HIVE-22): relative, outermost only. A folder's children are not listed;
 *  GET /activities/:id/tree/folder reads them when it is expanded. */
export interface IgnoredEntries {
  files: string[];
  folders: string[]; // without the trailing /
}

/** A folder's direct children on disk (HIVE-22), names only, `.git` left out. Inside a nested repository (#1), that repository's view of
 *  them: `marks` by name, and the names it ignores. Absent outside a nested repository. */
export interface FolderEntries {
  files: string[];
  folders: string[];
  repo?: { marks: Record<string, GitMark>; ignored: string[] };
}

/** The diffs a task offers (#270, #591): what its current stage changed, everything its worktree changed, its last commit, or a checkpoint's restore point (#619). */
export type DiffScope = 'stage' | 'worktree' | 'commit' | 'checkpoint';

/** One line of a hunk (#270), numbered on each side it exists on. */
export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string; // without the leading ' ', '+' or '-'
  old?: number; // line number on the base side; absent on an added line
  new?: number; // line number on the worktree side; absent on a deleted line
}

export interface DiffHunk {
  header: string; // the `@@ -a,b +c,d @@ …` line as git printed it: what a later hunk revert rebuilds a patch from
  lines: DiffLine[];
}

export interface FileDiff {
  path: string; // the worktree side's path (the old one for a deleted file)
  oldPath?: string; // present on a rename
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary?: true; // no hunks
  hunks: DiffHunk[];
  hash: string; // fileHash (#591): what a reviewed mark compares
}

/** GET /activities/:id/diff (#270). */
export interface TaskDiff {
  scope: DiffScope;
  base: string; // the base commit's short sha, and the ref it came from for the worktree scope: `a1b2c3d (origin/main)`
  files: FileDiff[];
}

/** The longest review comment or reply (#591), in characters after the trim: the routes and hive_reply. */
export const REVIEW_TEXT_MAX = 10_000;
/** A recipient that is not a session yet (#591): nova sessão, opened for the message. */
export const NEW_SESSION = 'new';
/** Lines on one side of a file's diff (#591, #592): what a comment anchors at, in either review pane. */
export interface LineAnchor { path: string; side: 'old' | 'new'; start: number; end: number }
/** Where a comment sits (#591): the new side unless every line was a deleted one; excerpt is those lines' text, what tells an outdated anchor. */
export type ReviewAnchor = LineAnchor & { scope: DiffScope; excerpt: string[] };
/** A rectangle of a design (#111), in CSS pixels of the screen at its viewport. */
export interface DesignRect { x: number; y: number; width: number; height: number }
/** The design pane's viewports (#110), by name (#341): natural is the content's own size, the others DESIGN_VIEWPORT_PX's widths. */
export const DESIGN_VIEWPORTS = ['natural', 'desktop', 'tablet', 'mobile'] as const;
export type DesignViewport = (typeof DESIGN_VIEWPORTS)[number];
/** The fixed viewports' frame widths (#109); natural's comes from the bridge's measure (#341). */
export const DESIGN_VIEWPORT_PX = { desktop: 1280, tablet: 768, mobile: 390 } as const;
/** A viewport a screen declares in its hv-tweaks block (#341): natural is always offered, so it is never declared. */
export type DeclaredViewport = keyof typeof DESIGN_VIEWPORT_PX;
/** What a design comment points at (#111): an element, with its selector and text, or an area. part (#421): the part the element came
 *  from, relative to the activity as the anchor's path; slot: the element holds that slot, which the screen filled with text. */
export type DesignTarget =
  | { kind: 'element'; selector: string; text: string; rect: DesignRect; part?: string; slot?: string }
  | { kind: 'area'; rect: DesignRect };
/** A tweak's value (#241): an enum's option or a text, a number, a boolean. */
export type DesignTweakValue = string | number | boolean;
/** A design comment's place as a request carries it (#111): everything but the pin, which only the server sets; tweaks: the values it was made on (#241). */
export type UnpinnedDesignAnchor = { path: string; viewport: DesignViewport; theme: 'dark' | 'light'; tweaks: Record<string, DesignTweakValue> } & DesignTarget;
/** Where a design comment sits (#111): an element or an area of a .hv.html screen; pin is set by the server. */
export type DesignAnchor = UnpinnedDesignAnchor & { pin: number };
/** What a review conversation anchors at (#111): lines of a diff, or a design. Only a design anchor has a kind. */
export type ThreadAnchor = ReviewAnchor | DesignAnchor;
export const isDesignAnchor = (anchor: ThreadAnchor): anchor is DesignAnchor => 'kind' in anchor;
/** One message of a conversation (#591). to: the sessions a user message reached; pending: the ones a failed delivery still owes (reenviar). */
// mentions: the sessions its chips name, each chip kept in the text as chipText writes it (review-message.ts)
export interface ReviewMessage { id: string; author: 'user' | { session: string }; at: string; text: string; to?: string[]; failed?: true; pending?: string[]; mentions?: string[] }
/** A conversation anchored at lines (#591); participants: the sessions it was delivered to, the only ones hive_reply accepts. */
// received: per session, the id of the last message a delivery to it carried (review-message.ts's missed reads it)
// agentResolved: set by hive_reply resolve: true (#111); the thread stays open until the user confirms
export interface ReviewThread { id: string; anchor: ThreadAnchor; participants: string[]; messages: ReviewMessage[]; resolved?: true; agentResolved?: { session: string; at: string }; received?: Record<string, string> }
/** A comment added to the review, sent with the batch (#591); session: a session id of the task, or NEW_SESSION. */
export interface ReviewDraft { id: string; anchor: ThreadAnchor; session: string; text: string }
/** A file marked reviewed in a scope (#591), with its fileHash then: a different hash now drops it. */
export interface ReviewedMark { scope: DiffScope; path: string; hash: string }
/** A task's review file (#591), <home>/reviews/<itemId>.json: outside State and the reducer. */
export interface ReviewFile { defaultSession?: string; reviewed: ReviewedMark[]; drafts: ReviewDraft[]; threads: ReviewThread[] }
/** How a PR is merged (#592): GitHub's three methods, lowercased. */
export type MergeMethod = 'merge' | 'squash' | 'rebase';
/** GitHub's mergeStateStatus, lowercased and shortened (#592); anything else reads unknown. */
export type PrMergeState = 'clean' | 'unstable' | 'hooks' | 'conflicts' | 'blocked' | 'behind' | 'draft' | 'unknown';
/** One comment of a GitHub review thread (#592); author: the login, `ghost` for a deleted account. */
export interface PrComment { id: string; author: string; at: string; text: string }
/** A GitHub review thread (#592); id: its node id. subject file: a file-level thread, drawn with no line (anchor 0 to 0); more: GitHub holds
 * more than the 100 comments read. */
export interface PrThread { id: string; anchor: LineAnchor; outdated: boolean; resolved: boolean; subject: 'line' | 'file'; more: boolean; comments: PrComment[] }
/** A check on a PR's head commit (#758): a check run or a status context, as success, failure or pending; url: its page on GitHub; at: when
 * it completed (a status context: when it was set). */
export interface PrCheck { name: string; state: 'success' | 'failure' | 'pending'; url?: string; at?: string; startedAt?: string } // startedAt: a CheckRun's startedAt, or a pending StatusContext's createdAt (#914)
/** The head commit's checks (#758): GitHub's rollup state, the latest completion, each check; awaiting: the workflows awaiting a maintainer's
 * approval (#854). */
export interface PrChecks { state: PrCheck['state']; at?: string; items: PrCheck[]; awaiting?: string[] }
/** A submitted review on the PR's timeline (#758), with its body. */
export interface PrReviewEvent { id: string; author: string; at: string; kind: 'approved' | 'changes' | 'commented'; text: string }
/** A general comment on the PR (#758), issue-style; author: the login, `ghost` for a deleted account. */
export interface PrIssueComment { id: string; author: string; at: string; text: string }
/** GitHub's reviewDecision, shortened (#758); a repository that requires no review has none. */
export type PrReviewDecision = 'approved' | 'changes' | 'pending';
/** A pending review request on a PR (#67): a user by login or a team by slug; viewer: the request names the viewer's own login; at: when
 * the latest request for that reviewer was made, as the timeline reads it. */
export interface PrReviewRequest { reviewer: string; team: boolean; viewer: boolean; at?: string }
/** An issue a PR closes on merge (#66), from GitHub's closingIssuesReferences. */
export interface PrClosingIssue { repository: string; number: number; url: string }

/** A PR as its page reads it (#592, #758): the PR as GitHub holds it, its conversations and the page's fields. The diff, the threads, behindBy
 * and the request times are `PrChanges` (#497); reviewRequests carry no `at` here. conflicts: the
 * files a merge of the base would conflict in, only when computed; canEdit: GitHub lets the login edit the title and description; canPush: the
 * login may merge and re-run there (#854); headOwner / baseOwner: the two repositories' owners, which differ on a fork's PR. reviewRequests: who is asked to review, pending only (#67).
 * closes: the issues it closes on merge, in GitHub's order (#66); in a stack only the PR targeting the base carries them. */
export interface PrData {
  url: string; id: string; number: number; title: string; state: PrState; isDraft: boolean; mergeState: PrMergeState; head: string;
  methods: MergeMethod[]; viewer: string;
  body: string; author: string; createdAt: string; updatedAt: string; headRef: string; baseRef: string; commits: number; additions: number; deletions: number;
  decision?: PrReviewDecision; approvals: number; checks?: PrChecks; reviews: PrReviewEvent[]; comments: PrIssueComment[];
  conflicts?: string[]; canEdit: boolean; canPush: boolean; headOwner: string; baseOwner: string; reviewRequests: PrReviewRequest[]; closes: PrClosingIssue[];
}
/** GET …/pulls/:number/changes (#497): what GitHub alone holds of a PR, read at `head`, the head the diff and the threads were read at, which
 * may trail the fields' head. truncated: GitHub holds more than 100 threads; behindBy: how far the base moved past the head, absent when GitHub
 * cannot compare them; reviewRequests: the pending ones, each with the time the latest request was made when the timeline has it. */
export interface PrChanges { head: string; files: FileDiff[]; threads: PrThread[]; truncated: boolean; behindBy?: number; reviewRequests: PrReviewRequest[] }
/** GET …/pulls/:number/checks (#758): what the checks' poll reads, nothing else of the PR. */
export type PrChecksRead = Pick<PrData, 'checks' | 'mergeState' | 'updatedAt'>;
/** What the review popover sends (#758): a comment, an approval or a change request. */
export type PrReviewEventInput = 'comment' | 'approve' | 'request_changes';
/** One row of a repository's PR list (#758); checks: the head commit's rollup; decision: GitHub's reviewDecision. */
export interface PrRow {
  url: string; number: number; title: string; state: PrState; isDraft: boolean; checks?: PrChecks['state'] | 'awaiting'; decision?: PrReviewDecision;
  mergeState: PrMergeState; updatedAt: string;
}
/** GET /repositories/:owner/:name/pulls?state= (#758): one state's rows, newest update first, the three counts; truncated: more than the first 100;
 * canPush: the login may merge there (#854). syncedAt: the repository's last complete issues round (#186), null while never synced. */
export interface RepoPrs { rows: PrRow[]; counts: { open: number; merged: number; closed: number }; truncated: boolean; canPush: boolean; syncedAt: string | null }
/** A comment added to the PR review (#592), published with enviar revisão. */
export interface PrDraft { id: string; anchor: LineAnchor & { excerpt: string[] }; text: string }
/** A PR's review file (#592), <home>/pr-reviews/<encodeURIComponent(url)>.json: outside State and the reducer. The review's summary is sent,
 * never stored (#758). */
export interface PrReviewFile { reviewed: { path: string; hash: string }[]; drafts: PrDraft[] }
/** The longest review summary or general comment of a PR (#592, #758): GitHub's own body limit. Comments and replies take REVIEW_TEXT_MAX. */
export const PR_BODY_MAX = 65_536;

/** One line of a command (#755): the workspace it runs in, by its comb.workspaces name, or null for every workspace with no line of its own. */
export interface CommandImpl {
  workspace: string | null;
  command: string; // a shell line, run with "$SHELL" -c; never logged, never in the state
}

/** A workspace's command (#300, #573: was RunCommand): a named command a task can run in its worktree, one line per workspace (#755); env is
 * exported before it, the user's shell expands it. resolveCommand (run-commands.ts) picks the line a workspace runs. */
export interface Command {
  name: string; // unique in the Comb (#511), trimmed: what the menu shows, the route takes, Terminal.command holds and a commands stage lists
  impls: CommandImpl[]; // #755: at least one; each workspace once; at most one null, the line of the other workspaces
  menu: boolean; // #755: false = stages only, out of the task menu and the detail panel
  env: Record<string, string>; // names match ENV_NAME; values are shellQuoted; never logged; every line's
  timeout?: string; // #511: a TIMEOUT text; absent = no limit. The server stops the run when it runs out
}

/** The delivery modes that cut a task into slice PRs (#698): a branch per slice stacked on the previous one, or slices merged into an
 * integration branch. */
export type SliceDelivery = 'stacked' | 'integration';
export const SLICE_DELIVERIES: readonly SliceDelivery[] = ['stacked', 'integration'];
/** A PR's slice (#698): k, 1-based, its merge position inside its repository; the integration PR is k = the number of slices + 1. */
export interface PrSlice { k: number; type: SliceDelivery }

/** The formatters the Hive supports (#749), in the order a save tries them; src/formatters.ts holds each one's table row. */
export const FORMATTER_IDS = [
  'biome', 'prettier', 'ruff', 'black', 'gofmt', 'rustfmt', 'clang-format', 'shfmt', 'dart', 'swift-format', 'mix', 'terraform', 'stylua', 'zig', 'ktlint', 'taplo',
] as const;
export type FormatterId = (typeof FORMATTER_IDS)[number];
/** How long one formatter run may take on a save (#749) before it is killed and the save goes on unformatted. */
export const FORMAT_TIMEOUT_MS = 10_000;

/** The editor's languages (#780), in the order Settings › editor lists them; src/languages.ts holds each one's row. */
export const LANGUAGE_IDS = [
  'typescript', 'python', 'go', 'rust', 'cpp', 'objective-c', 'lua', 'toml', 'yaml', 'shell', 'web', 'markdown', 'sql', 'swift', 'dart', 'elixir', 'kotlin', 'terraform', 'zig', 'other',
] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];
/** The language servers the Hive installs (#780), and the checkers' own (#782); src/languages.ts holds each one's recipe. */
export const SERVER_IDS = [
  'typescript-language-server', 'pyright', 'gopls', 'rust-analyzer', 'clangd', 'lua-language-server', 'taplo', 'yaml-language-server', 'bash-language-server', 'vscode-langservers-extracted',
  'biome', 'eslint', 'oxlint', 'ruff', 'tflint', 'dart',
] as const;
export type ServerId = (typeof SERVER_IDS)[number];
/** The syntax packages (#780): Open VSX ids of the VS Code extensions whose grammars and language configurations the Hive extracts. */
export const SYNTAX_IDS = [
  'vscode.python', 'vscode.go', 'vscode.rust', 'vscode.cpp', 'vscode.objective-c', 'vscode.lua', 'tamasfe.even-better-toml', 'vscode.shellscript', 'vscode.swift', 'elixir-lsp.elixir-ls', 'hashicorp.terraform', 'ziglang.vscode-zig',
] as const;
export type SyntaxId = (typeof SYNTAX_IDS)[number];
/** Where an editor setting applies (#780): every workspace, the ones added later included, or the named ones (unique, each a workspace's name). */
export type WorkspaceScope = 'all' | string[];
/** How a language server or a syntax package gets on this Mac (#780); system: it ships with its SDK and is only looked up on PATH (#782). */
export type InstallKind = 'npm' | 'github' | 'toolchain' | 'openvsx' | 'system';
/** A server's or a syntax package's install (#780). installed with a latest that differs: an update is available. failed keeps the version it
 * tried, the step it stopped at and the install's output, its error last. builtin: a language whose syntax Monaco ships. */
export type InstallState =
  | { state: 'absent' } | { state: 'installing'; percent?: number } | { state: 'installed'; version: string; latest?: string }
  | { state: 'requires'; tool: string } | { state: 'failed'; version: string; step: string; log: string } | { state: 'builtin' };
/** What the install routes act on (#780): a server or a syntax package. */
export type InstallTarget = { kind: 'server'; id: ServerId } | { kind: 'syntax'; id: SyntaxId };
/** GET /settings/editor/installs (#780): every server and syntax package of the catalog with its state. */
export interface EditorInstalls { servers: Record<ServerId, InstallState>; syntaxes: Record<SyntaxId, InstallState> }
/** The state stream's editorInstall event (#780): one item's new state. */
export type EditorInstallEvent = InstallTarget & { state: InstallState };
/** What POST /settings/editor/installs/:kind/:id asks (#780): recheck looks for a missing tool again. */
export const INSTALL_ACTIONS = ['install', 'update', 'remove', 'cancel', 'recheck'] as const;
export type InstallAction = (typeof INSTALL_ACTIONS)[number];
/** A formatter the user writes (#749, #780): a shell line run with "$SHELL" -c, FILE in its env. It belongs to a language and is tried before
 * the supported ones, in the workspaces its scope names. */
export interface CustomFormatter {
  name: string; // WORKSPACE_NAME's shape, unique in its language, never a FormatterId: a segment of its console channel's id
  command: string; // the text in on stdin, the formatted text out on stdout; never logged
  extensions: string[]; // lowercase, with the dot (.sql); one or more
  workspaces: WorkspaceScope;
}
/** A supported formatter's setting in one language (#780); absent = on, no args, every workspace. args go right after the binary. */
export interface LanguageFormatter { enabled: boolean; args: string[]; workspaces: WorkspaceScope }
/** A checker's setting in one language (#782), a formatter's shape; absent = on, no args, every workspace. args go after the binary's subcommand. */
export interface LanguageChecker { enabled: boolean; args: string[]; workspaces: WorkspaceScope }
/** One language's editor settings (#780), only what differs from the default: its server in every workspace, every formatter and checker on, no custom. */
export interface LanguageConfig {
  server?: { workspaces: WorkspaceScope }; formatters?: Partial<Record<FormatterId, LanguageFormatter>>; custom?: CustomFormatter[];
  checkers?: Partial<Record<CheckerId, LanguageChecker>>; // #782
}

/** The editor pane's one config (#780), replacing #749's per-workspace format. */
export interface EditorConfig { formatOnSave: { enabled: boolean; workspaces: WorkspaceScope }; languages: Partial<Record<LanguageId, LanguageConfig>> }
/** What a new Hive formats (#780): on save in every workspace, every formatter on its default. */
export const EDITOR_DEFAULTS: EditorConfig = { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} };
/** When the template reviewer runs (#328, the menu's choice, 4.3): as the user types, on save, or only when asked. */
export const REVIEW_WHEN = ['type', 'save', 'demand'] as const;
export type ReviewWhen = (typeof REVIEW_WHEN)[number];
/** The template reviewer (#328). agent null: the config's defaultAgent; model null: the CLI's default; version null: the shipped
 * template-reviewer, else the user's version of it by name (checked when a review runs, not on boot). */
export interface ReviewerConfig { on: boolean; when: ReviewWhen; agent: AgentId | null; model: string | null; version: string | null }
/** What a file without `reviewer`, or a field it leaves out, reads as (#328). */
export const REVIEWER_DEFAULTS: ReviewerConfig = { on: true, when: 'save', agent: null, model: null, version: null };

/** The Hive's MCP tools no config can turn off (#333): the stages and the skills depend on them. */
export const LOCKED_TOOLS = ['hive_done', 'hive_ask', 'hive_stop', 'hive_pr', 'hive_reply', 'hive_conventions'] as const;
/** The tools mcp.off may turn off for the whole Hive (#333, screen 11f). */
export const OPTIONAL_TOOLS = ['hive_remember', 'hive_applied', 'hive_create_task', 'hive_task'] as const;
export type OptionalTool = (typeof OPTIONAL_TOOLS)[number];
interface McpServerBase { name: string; workspace: string | null; on: boolean }
export type ExternalMcpServer =
  | (McpServerBase & { command: string; args: string[] })
  | (McpServerBase & { url: string; authHeader?: string });
export interface McpSettings { off: OptionalTool[]; servers: ExternalMcpServer[] }
export const MCP_DEFAULTS: McpSettings = { off: [], servers: [] };
export type McpServerState = 'connected' | 'no_answer' | 'off'; // off: the server's own switch, never probed
/** GET /settings/formatters (#749, #780): the workspaces whose checkout has a supported formatter's binary. */
export interface FormatterState { id: FormatterId; found: string[] }
/** How long a language server process outlives its last client (#780). */
export const LSP_IDLE_MS = 300_000;
/** Why the daemon closed an LSP socket (#780): the process died (with its reason), a request it cannot serve, a workspace outside the
 * server's scope, or a server not installed or missing its runtime (reason `not installed` or `requires <tool>`). */
export const LSP_CLOSE = { crashed: 1011, refused: 4400, outOfScope: 4403, absent: 4404 } as const;
/** The LSP socket's first frame (#780): the folder the server reads as its root (a real path), which the page builds file:// URIs from, and
 * the process's console run, what the bar's ver log opens. */
export interface LspHello { root: string; log: FormatLog }
/** The command-line checkers (#782), in Settings' order; src/checkers.ts holds each one's row. */
export const CLI_CHECKER_IDS = [
  'tsc', 'mypy', 'pylint', 'golangci-lint', 'staticcheck', 'clippy', 'selene', 'luacheck', 'yamllint', 'stylelint', 'htmlhint', 'markdownlint', 'sqlfluff', 'swiftlint',
  'dart-analyze', 'credo', 'ktlint', 'detekt', 'zig-ast-check',
] as const;
export type CliCheckerId = (typeof CLI_CHECKER_IDS)[number];
/** Every checker (#782): the six with their own language server (each a ServerId too), then the command-line ones. */
export const CHECKER_IDS = ['biome', 'eslint', 'oxlint', 'ruff', 'tflint', 'dart', ...CLI_CHECKER_IDS] as const;
export type CheckerId = (typeof CHECKER_IDS)[number];
/** One finding of a command-line checker (#782): 1-based, path relative to the activity's folder. */
export interface CheckDiagnostic { path: string; line: number; column: number; endLine?: number; endColumn?: number; severity: 'error' | 'warning' | 'info'; message: string; code?: string }
/** POST /activities/:id/check/:checker (#782): the run's diagnostics and console run, its failure, a checker off or not found, or a run a newer one
 * replaced (the page ignores it). */
export type CheckAnswer =
  | { state: 'done'; scope: 'file' | 'project'; diagnostics: CheckDiagnostic[]; log: FormatLog }
  | { state: 'failed'; reason: string; log: FormatLog } | { state: 'absent' } | { state: 'superseded' };
/** GET /settings/checkers (#782): the workspaces whose checkout has the checker (a language-server one: the project's copy). */
export interface CheckerState { id: CheckerId; found: string[] }
/** How long a command-line checker may run (#782): clippy and tsc on a large project need far more than a formatter's FORMAT_TIMEOUT_MS. */
export const CHECK_TIMEOUT_MS = 120_000;
/** The most a command-line checker's report may hold (#782); past it the run is killed and fails. */
export const CHECK_OUTPUT_MAX = 16 * 1024 * 1024;

/** Where a fork workspace's workers open their PRs (#854): the original, the fork, or ask the user first. */
export const PR_TARGETS = ['original', 'fork', 'ask'] as const;
export type PrTarget = (typeof PR_TARGETS)[number];
/** How a fork keeps up with its original when PRs may go to the fork (#854): GitHub's sync, a merge in the new worktree, or by hand. */
export const FORK_SYNCS = ['github', 'local', 'manual'] as const;
export type ForkSync = (typeof FORK_SYNCS)[number];
/** A workspace that is a fork (#854): which remote is the original, where the workers' PRs go, and, when they may go to the fork, how it keeps up. */
export type WorkspaceFork = { remote: string; pr: 'original' } | { remote: string; pr: 'fork' | 'ask'; sync: ForkSync };
/** A git remote of a workspace (#854): its name and, when it points at GitHub, its owner/name. What Settings' select and suggestion read. */
export interface GitRemote { name: string; repository?: string }

/** The result of one fork sync (#854): before a worktree (on the activity) or by hand (the route's answer). */
export interface ForkSyncResult {
  result: 'synced' | 'current' | 'diverged' | 'conflict' | 'offline' | 'error';
  mode: 'github' | 'local';
  commits?: number; // synced/current: from the original; diverged: only on the fork
  files?: string[]; // conflict
  reason?: string; // error: the first line of git's or gh's message
  base: string; // `<forkOwner>:<base>`, what the worktree started from
  sha: string; // short sha of that start
  at: string; // ISO
}
/** A sync before its start is known (#854): what syncFork and POST /workspaces/:name/sync answer. */
export type ForkSyncAnswer = Omit<ForkSyncResult, 'sha' | 'at'>;

/** Where a benchmark run's PR is rebased and pushed from (#477): a temporary worktree of the workspace's repository, or its own checkout. */
export const BENCHMARK_PR_IN = ['worktree', 'checkout'] as const;
export type BenchmarkPrIn = (typeof BENCHMARK_PR_IN)[number];
/** The setup form's default for a new workspace (#477): the checkout is never touched unless asked. */
export const BENCHMARK_PR_IN_NEW: BenchmarkPrIn = 'worktree';

/** Where the code lives (#179): a named git repo on this machine. A Comb has one or more; the name is the key tasks and the source use. */
export interface Workspace {
  name: string; // WORKSPACE_NAME: safe in a URL segment and a select value; unique in the Comb
  path: string; // absolute, a git work tree's top level (POST /settings checks it); unique in the Comb
  env: Record<string, string>; // in the env of every run of this workspace (#348, #738): workers, sessions, terminals, run commands, setup and teardown RUN steps; a command's own env overrides a name; names match ENV_NAME and are not in RESERVED_ENV_NAMES; never logged
  memoryCap: number; // #73: required, no default; the sum of this workspace's lesson texts, MEMORY_CAP_MIN..MEMORY_CAP_MAX
  color: string; // #78: required; one of WORKSPACE_PRESET_COLORS or a lowercase #rrggbb
  fork: WorkspaceFork | false | null; // #854: required; null = never decided (Settings may suggest one), false = not a fork, never suggested again
  nestedRepos: string[]; // #653: required; relative paths of nested repos, each a git top level this workspace's git ignores (POST /settings checks it); [] = none
  notNestedRepos: string[]; // #653: required; paths the user said are not nested repos: never suggested again
  benchmarkPrIn: BenchmarkPrIn; // #477: required; where a benchmark run's PR is rebased and pushed from
  baseBranch?: string; // #854: this workspace's base branch, over config.baseBranch; absent = the general default
  setup?: string; // the worktree setup (#299): COPY / RUN / LOAD lines, run once in each new worktree; absent = none
  setupTimeout?: string; // #511: per RUN step, a TIMEOUT text ("5m"); absent = no limit
  teardown?: string; // the worktree teardown (#654): COPY / RUN / LOAD / DEL lines, run in the worktree before the Hive removes it; absent = none
  teardownTimeout?: string; // #654: per RUN step of the teardown, a TIMEOUT text ("2m"); absent = no limit
}

/** The Comb (#132): its stages (the cells), the workspaces the code lives in and its external sources (#180). */
export interface CombConfig {
  prefix: string; // local task ids are <prefix>-<n>
  workspaces: Workspace[]; // one or more, names and paths unique (#179)
  sources: SourceConfig[]; // [] = no external source: nothing is polled from or written to one
  stages: Stage[]; // the pipeline, in order (#286: was columns)
  transitions: Transition[]; // #134: the arrows between the stages; [] = every stage end stops its task
  commands: Command[]; // #511: the Comb's run commands, each enabled in some workspaces; [] = none
  hiveSource: boolean; // #846: the hive source is on; false needs a source, and POST /settings refuses it while a created task exists
  createIn: string; // #846: the default destination of a new task: HIVE_SOURCE or a source with a repository
}

/** The Hive's operations a key can start (#449, #585, #573: was OperationId, which named the operation, not its key);
 * src/shortcut-registry.ts holds each one's defaults per platform, scope and name. The fixed keys are not shortcuts (#481): FIXED_SHORTCUTS there. */
export type OperationId =
  | 'viewFlow' | 'viewActivities' | 'viewPlugins' | 'search' | 'searchOperations' | 'newActivity' | 'runCommand' | 'toggleConsole' | 'problems'
  | 'toggleLeft' | 'toggleRight' | 'shortcutMap' | 'fullScreen' | 'closeWindow'
  | 'newTerminal' | 'newSession' | 'newSessionDialog' | 'openDiff' | 'newFile' | 'close' | 'nextTab' | 'prevTab' | 'splitSame' | 'splitTerminalVertical'
  | 'splitTerminalHorizontal' | 'clear' | 'findInTerminal' | 'nextPane' | 'prevPane' | 'nextActivity' | 'prevActivity' | 'toggleSideTab' | 'sleepSession' | 'sleepAll'
  | 'searchTasks' | 'refreshFlow' | 'goBack' | 'zoomOut' | 'zoomIn' | 'zoomReset' // #911: back from a page; #910: the flow canvas's zoom
  | 'treeNewFile' | 'treeNewFolder' | 'treeRename' | 'treeDelete' | 'treeReveal' | 'treeOpenTerminal' | 'treeCopyPath' | 'treeCopyRelativePath' | 'treeCopyCheckoutPath' // #818, #131
  | 'confirm' | 'feedbackQueue' | 'switchStartMode' | 'searchSettings' | 'searchPlugins' | 'askAgent' | 'viewBenchmark' | 'benchmarkSearch'; // #689, #313, #331, #458
/** Only the user's changes (#449): a normalized Electron accelerator rebinds, null turns off, a missing id is the registry's default. */
export type Shortcuts = Partial<Record<OperationId, string | null>>;

export interface Config {
  auth?: AuthConfig; // required only by a github source (parseConfig); no default: a silent one would hide which transport is live
  comb: CombConfig;
  logLevel: LogLevel; // warn: only refusals and failures (#742); info: what the Hive did; debug: also what it received. Read on boot and on every POST /settings
  branch?: string; // branch name template for a task's worktree ({id}, {title}, {slug}); absent = DEFAULT_BRANCH_TEMPLATE
  language?: Language; // UI language; absent = the system's (never written as undefined: the file stays clean)
  theme: Theme; // required, no default (#296); main.ts reads it raw for the windows' first paint (configuredTheme)
  terminalFont: string; // required, no default (#376): one font family name, trimmed; "" = the system monospace. The UI quotes it (terminalFontStack)
  trustedDomains: string[]; // required, no default (#404): hosts whose terminal links open without asking; a host covers its subdomains. Trimmed, lowercased, no duplicates
  shortcuts: Shortcuts; // required, no default (#449): only the user's changes to the keyboard shortcuts; {} = every default
  consoleLines: number; // required, no default (#353): the most lines a console channel keeps, summed over its runs; integer CONSOLE_LINES_MIN..CONSOLE_LINES_MAX
  /** Branch a new worker's worktree starts from (as origin/<branch>); absent = the remote's default (origin/HEAD), else main. */
  baseBranch?: string;
  agentArgs: Record<AgentId, string[]>; // #924: each agent's own arguments, after the Hive's flags and before the model and the session; required, every agent
  budget: Budget; // copied to State.budget by setBudget on configure / reconfigure
  usageRules: UsageRule[]; // copied to State.usageRules by setUsageRules on configure / reconfigure
  /** What closing the last main window does (#513, was #198's menuBar + stopOnClose): menuBar = the viewer stays in the menu bar and the
   * workers keep running; quit = the Hive stops with its workers (asking first while workers run). */
  onClose: OnClose;
  /** Which transitions show a macOS notification while no main window is focused (#199). Required, no default: a file from before the key
   * boots the settings form prefilled (VIEWER_DEFAULTS). */
  notifications: NotificationSettings;
  /** What closing the tab of a free or a local session does to its run (#614). */
  closeSessionTab: CloseTabAction;
  /** What closing the tab of a stage's session does to its run (#614). */
  closeStageTab: CloseTabAction;
  /** Whether a notice follows the close of a free or a local session's tab (#614), whatever closeSessionTab says. */
  closeSessionTabNotice: boolean;
  /** Whether a notice follows the close of a stage's tab (#614), whatever closeStageTab says. */
  closeStageTabNotice: boolean;
  /** Whether a notice follows a manual sleep of one session, a close-tab sleep included (#672). */
  sleepNotice: boolean;
  /** Whether a notice follows the auto flow ending a stage's run (#672). */
  sleepAutoNotice: boolean;
  /** Whether a notice follows the idle shutdown putting a session to sleep (#672). */
  sleepIdleNotice: boolean;
  /** Whether a notice follows a sleep all (#672). */
  sleepAllNotice: boolean;
  /** What closing a terminal's tab does to its shell (#696): keep = it runs on behind the closed tab; sleep = it sleeps, kept with its output. */
  closeTerminalTab: CloseTabAction;
  /** Whether the keep notice follows the close of a terminal's tab that keeps it running (#696). */
  closeTerminalTabNotice: boolean;
  /** What deleting an activity forgets (#236, #573): the delete-activity stage and the details panel's item alike; copied to State.deleteActivity. */
  deleteActivity: DeleteActivityScope;
  /** How long a worker may wait for the user while shutdown-when-done is armed (#233), in minutes; copied to State.shutdownIdleMinutes. */
  shutdownIdleMinutes: number;
  /** How long a stage awaiting approval keeps its session alive (#268), in minutes; copied to State.approvalMinutes. */
  approvalMinutes: number;
  /** How long a run whose turn hit a plan limit may wait for the window to reset (#805), in minutes; past it the run stops with the error.
   * Copied to State.rateLimitWaitMinutes. */
  rateLimitWaitMinutes: number;
  /** The header draws a meter of each source's GitHub API quota; off = only the backoff warning shows. */
  showGithubQuota: boolean;
  /** The agent a stage runs when it does not pick one (#516). Required, no default: a file from before the key is migrated to claude. */
  defaultAgent: AgentId;
  /** The files tree's icons (#754). Required, no default: a file from before the key is migrated to FILE_ICONS_DEFAULTS. */
  fileIcons: FileIcons;
  /** Which sidebar state each view keeps (#821). Required, no default: a file from before the key boots the settings form prefilled. */
  sidebarsPerView: SidebarsPerView;
  /** What each signal lets the Hive do on its own and the signal a boot opens on (#727). Required, no default: a file from before the key boots
   * the settings form prefilled. Copied to State.signals. */
  signals: SignalSettings;
  /** The editor pane's languages, servers and formatters (#780). Required, no default: a file without it is fixed by hand. */
  editor: EditorConfig;
  /** The template reviewer (#328). Optional in the file: absent, or a field left out, reads as REVIEWER_DEFAULTS; no migration. */
  reviewer: ReviewerConfig;
  /** The Hive's optional tools turned off and the external MCP servers (#333). Required; a first save writes MCP_DEFAULTS. */
  mcp: McpSettings;
}

/** The viewer's settings (#513, #199), was #198's two) and its effective language (#242): the config's, else the system's, never absent. The
 * default is today's behaviour: what a new form shows, what a file from before the key is prefilled with, and what the viewer does while
 * no config parses. The parser itself has no default. */
export type ViewerSettings = Pick<Config, 'onClose' | 'notifications'> & { language: Language };
export const VIEWER_DEFAULTS: Omit<ViewerSettings, 'language'> = { onClose: 'menuBar', notifications: { waiting: true, approval: true, pr: true, failed: true } };

/** What deleting an activity forgets besides its worktree, its local branch and its terminals, which always go (#236, #573). transcripts needs
 * session (a transcript the task still lists is a session the popup could still offer): parseConfig refuses the rest. nonAutoTasks (#496)
 * says which tasks a delete-activity stage takes, not what it removes. */
export interface DeleteActivityScope {
  session: boolean; // the activity's tasks forget their sessions: the next continue starts a new one
  transcripts: boolean; // needs session: each session's <id>.jsonl and <id>/ in the agent's workspace directory go too
  nonAutoTasks: boolean; // delete-activity stages also take a task without auto; the fill still never starts one
}
/** What a new form shows and what a file without the key is prefilled with (#236, #496, #573). The parser itself has no default. */
export const DELETE_ACTIVITY_DEFAULTS: DeleteActivityScope = { session: false, transcripts: false, nonAutoTasks: false };
/** What closing a tab does on a new form (#614, #696), and what a file from before the keys is prefilled with. The parser has no default. */
export const CLOSE_TAB_DEFAULTS: Pick<Config, 'closeSessionTab' | 'closeStageTab' | 'closeTerminalTab' | 'closeSessionTabNotice' | 'closeStageTabNotice' | 'closeTerminalTabNotice'> = {
  closeSessionTab: 'keep', closeStageTab: 'keep', closeTerminalTab: 'sleep', closeSessionTabNotice: true, closeStageTabNotice: true, closeTerminalTabNotice: true,
};

/** The four sleep notices on a new form (#672), and what a file from before the keys is prefilled with. The parser has no default. */
export const SLEEP_NOTICE_DEFAULTS: Pick<Config, 'sleepNotice' | 'sleepAutoNotice' | 'sleepIdleNotice' | 'sleepAllNotice'> = {
  sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true,
};

/** Shutdown when done (#233): the window a new form shows and a file from before the key is prefilled with. The parser itself has no default. */
export const SHUTDOWN_IDLE_DEFAULT = 10;
export const SHUTDOWN_IDLE_MAX = 1440; // a day: the parser's and the form's upper bound, in minutes

/** The approval window (#268): what a new form shows and what a file from before the key is prefilled with. The parser itself has no default. */
export const APPROVAL_MINUTES_DEFAULT = 10;
/** The rate-limit wait (#805): what a new form shows, what a file from before the key is prefilled with and what the State holds until the
 * config is read. The parser itself has no default. */
export const RATE_LIMIT_WAIT_DEFAULT = 300;
export const RATE_LIMIT_WAIT_MAX = 10_080; // a week, in minutes: the parser's and the form's upper bound (#805)
/** The longest a Stop may be held (#268), in minutes: the window's upper bound, Estender's ceiling from the Stop's arrival and, plus the
 * usual 30 s, the Stop hook's own timeout. */
export const APPROVAL_HOLD_MAX_MIN = 120;

/** A console channel's line limit (#353): what a new form shows and what a file from before the key is prefilled with; the parser has no
 * default. The bounds are the parser's and the form's. */
export const CONSOLE_LINES_DEFAULT = 5000;
export const CONSOLE_LINES_MIN = 100;
export const CONSOLE_LINES_MAX = 100_000;

export interface HookPayload {
  hook_event_name: string;
  cwd?: string;
  notification_type?: string;
  message?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  transcript_path?: string; // Claude Code sends it on every hook; the server reads tokens from it on Stop / SessionEnd
  session_id?: string; // Claude Code sends it on every hook; the reducer keeps it from SessionStart
  reason?: string; // SessionEnd only: "clear" is not an exit (#655)
  source?: string; // SessionStart only: "clear" replaces the run's session id (#655)
  // Stop only (#367): the worker's own work in flight that will wake it (Claude Code's background tasks, and its ScheduleWakeup / loop
  // crons). Arrays in Claude Code; unknown here, since the body is not checked on the way in and only the lengths are read.
  background_tasks?: unknown;
  session_crons?: unknown;
  error?: unknown; // StopFailure only (#805): the API error class; anything but a snake_case word reads as unknown (apiErrorOf)
}

export type SessionRef = { activityId: string; sessionId: string }; // #587, #629: a record id: the session may belong to a deleted activity
export type SessionTarget = { activityId: string }; // where a copy goes (#587, #629): a live activity: a copy needs a directory to land in
/** One end of a copy as its dialog shows it (#587): the directory and the branch git has out there (null: detached, or unreadable). */
export interface CopyEnd { path: string; branch: string | null }
/** GET …/sessions/:session/copy (#587): the dialog's summary. uncommitted: `git status --porcelain` lines at the source; tokens: its last total. */
export interface CopySummary { from: CopyEnd; to: CopyEnd; messages: number; tokens: number; uncommitted: number }

/** One node of a decomposition (#865), parsed from decomposition.md. */
export interface DecompositionNode {
  id: string; // dotted, "1.2.3"; the parent is the id minus its last segment
  title: string; // 1–200 characters, as createEvent's title
  body: string; // the free text before the node's first ### subsection
  scope: string; // "### Scope", required on every node
  design?: string; // "### Design", inner nodes only
  openPoints: string[]; // "### Open points" items, leaves only
  criteria: string[]; // "### Acceptance criteria" items, required (≥ 1) on a leaf, absent on an inner node
  delivers: string[]; // contract ids
  consumes: string[]; // contract ids
  blockedBy: string[]; // node ids of the same file
  touches: string[]; // #936: "Touches:" paths, leaves only, relative, a trailing / dropped; what the overlap warnings compare
}

/** The parsed file (#865): the goal's title (the `#` heading), its text, its label (the head's `Label:` line, #936), the root's design, the
 * nodes in file order. `## Suggestions` is not kept. */
export interface Decomposition { title: string; goal: string; label?: string; design?: string; nodes: DecompositionNode[] }

/** A parse or validation problem (#865), shown in the confirm dialog; the line is 1-based. */
export interface DecompositionProblem { line: number; message: string }

/** A GitHub source the confirm dialog offers (#865): its Status options and the suggested one, the first stage's first column of it, else
 * its first option. */
export interface DecompositionSource { name: string; statuses: string[]; column?: string }

/** GET /activities/:id/decomposition (#865): what the confirm dialog shows. issues counts a local goal's root issue; title is absent with
 * problems; repository is absent for a local goal whose workspace has no GitHub origin; warnings are the overlaps (#936), which never block. */
export interface DecompositionPreview {
  title?: string; issues: number; blockers: number; suggestions: number; problems: DecompositionProblem[]; warnings: DecompositionProblem[]; repository?: string;
  delivery?: { repository: string; branch: string; path: string }; // #936: where the file is pushed: its checkout's repository, branch and path in it
  deliveryRefusal?: string; // #936: why it cannot be (default branch, not .md, no checkout): the dialog disables create issues
  sources: DecompositionSource[];
}

export type HiveEvent =
  | { type: 'boot' }
  | { type: 'poll'; source?: string; items: SourceItem[] } // source absent: a Comb with no sources (#132), merge nothing
  | { type: 'itemRead'; source: string; itemId: string; entry?: SourceItem } // #686: one item re-read after a field write; entry absent when it is out of the source's listing
  | { type: 'blockerSet'; itemId: string; change: BlockerChange } // #56: a hive task's relation, written on both tasks; POST …/blockers checked it
  | { type: 'setMax'; max: number }
  | { type: 'setSignal'; signal: Signal }
  | { type: 'setSignals'; signals: SignalSettings } // like setUsageRules: the signal table, from a save that changed it (#727)
  | { type: 'setBudget'; budget: Budget }
  | { type: 'setUsageRules'; usageRules: UsageRule[] }
  | { type: 'disableRule'; source: RuleSource; percent: number; until: DisableUntil; agent?: AgentId } // the strip's desligar (#297): only a rule of the table firing now; agent: #929
  | { type: 'enableRule'; source: RuleSource; percent: number; agent?: AgentId } // the strip's religar (#297)
  | { type: 'setDeleteActivity'; deleteActivity: DeleteActivityScope } // like setBudget: what deleting an activity forgets, from a save that changed it (#236, #573)
  | { type: 'setShutdownIdle'; minutes: number } // like setDeleteActivity: the shutdown window, from a save that changed it (#233)
  | { type: 'setRateLimitWait'; minutes: number } // like setApprovalMinutes: the rate-limit wait's ceiling, from a save that changed it (#805)
  | { type: 'setDefaultAgent'; agent: AgentId } // like setRateLimitWait: the config's default agent, from a save that changed it (#925)
  | { type: 'setApprovalMinutes'; minutes: number } // like setShutdownIdle: the approval window, from a save that changed it (#268)
  | { type: 'setShutdown'; armed: boolean } // the main window's power toggle (#233)
  | { type: 'setKeepAwake'; on: boolean } // the footer's keep-awake toggle, or the daemon clearing it after the holder failed (#226)
  | { type: 'tick' } // the server's poll timer while shutdown-when-done is armed (#233): the reducer's final step reads the clock
  | { type: 'setStages'; stages: Stage[]; transitions: Transition[] } // #134: the transitions travel with the stages
  | { type: 'setWorkspaces'; workspaces: string[]; sourceWorkspaces: Record<string, string>; commands: Record<string, string[]>; workspaceColors: Record<string, string> } // like setStages: what the reducer resolves workspaces against (#179), and each workspace's command names (#300) and colour (#78)
  | { type: 'setWorkspace'; taskId: string; workspace: string } // right-click › Workspace (#179)
  | { type: 'rateLimits'; agent: AgentId; ptyId?: string; rateLimits: RateLimits; replace?: boolean } // agent: whose plan (#929); no ptyId: the Hive's own reading; replace: the header's refresh, taken as read
  | { type: 'sourceQuota'; source: string; quota: SourceQuota }
  | { type: 'pollFailed'; source: string; message: string } // that source's listItems rejected (#180): its tasks stay as they are
  | { type: 'setSources'; sources: string[] } // like setWorkspaces: the Comb's sources, from the config on every save (#180)
  | { type: 'renameSources'; renames: Record<string, string> } // a save that renamed sources (#278): old name → new name, one simultaneous map; dispatched first by reconfigure
  | { type: 'renameStages'; renames: Record<string, string> } // #861: a save that renamed stages: old name → new name, one simultaneous map; dispatched by reconfigure after renameSources, before setStages
  | { type: 'hook'; ptyId: string; payload: HookPayload; branch?: string; tokens?: number; title?: string } // tokens and title: the server's turn-end read (#248, #489)
  | { type: 'exit'; ptyId: string }
  | { type: 'stop'; ptyId: string; close?: CloseAction; cause?: 'manual' | 'all'; block?: true } // the only way a user ends a run (#283): a stage run leaves its task stopped; the worker frees on the exit. close: hive_stop's reason (#314), written to the task's item after the kill. cause: the sleep it is (#672), absent for hive_stop and a command's timeout. block: hive_stop's block (#294): the activity is not stopped, the blockers gate the fill
  | { type: 'forgetSlept'; ptyId: string } // a sleeping run's tab closed (#672): its record and its transcript go
  | { type: 'quit' } // the server's close(), before its kills (#283): their exits are ignored and the next boot resumes the tasks in flight
  | { type: 'dismissCrash' } // the crash popup closed (#283)
  | { type: 'error'; message?: string }
  | { type: 'start'; itemId: string; base?: TaskBase | null; workspace?: string; local?: boolean; runPick?: RunPick } // the human override on a stopped task: past the signal, the cap and the budget; over the cap it opens a draining worker (#116); base = the popup's choice, null = its default (drops a saved one), absent = keep (#131); workspace = the popup's choice for a task with none (#179); local = the popup's switch, absent = keep (#444); runPick = the dialog's run picks, never stored for a later spawn (#290)
  | { type: 'continue'; activityId: string } // Continue (#283, #570): the stage's latest session again, with the continue prompt; past the signal, the cap and the budget
  | { type: 'restarting'; activityId: string } // Restart's git is about to run (#283): the task is marked deleting, so nothing else starts on it meanwhile
  | { type: 'restart'; activityId: string; branch?: string } // Restart (#283): the stage's prompt in a new session once the server reset the worktree; branch = the one it created
  | { type: 'stageStarted'; activityId: string; stage: string; commit: string } // the server read HEAD as a stage run started in that activity (#283, #629)
  | { type: 'checkpointCaptured'; activityId: string; checkpoint: Checkpoint } // #619: the server captured a restore point
  | { type: 'restoring'; itemId: string } // #619: a restore's git is about to run: the task is marked, as `restarting` marks it
  | { type: 'restored'; itemId: string; branch?: string } // #619: the restore's git ended well; `branch` when it checked out a new -r<n>
  | { type: 'restoreFailed'; itemId: string } // #619: the restore's git failed: the mark goes
  | { type: 'clearSessions'; activityId: string; sessionId: string } // one session's limpar in the panel (#304); a record id (#629)
  | { type: 'createTask'; title: string; body: string; stage: string; prefix: string; workspace?: string; auto: boolean; url?: string; origin?: string; pr?: { url: string; recordId: string } } // a task created in the Hive (#132); POST /tasks validated it. auto false: the new activity dialog's (redesign 03), which starts it itself. url and origin: the native view's flow… (#756). pr: a task made from a PR, with the record id the route drew so the reducer stays pure (#67)
  | { type: 'closeTask'; taskId: string } // close on a missing task, remove on a stopped local one (#132): the task and its session go; a missing task's worktree stays (#182), a local task's goes first, in the route (#542)
  | { type: 'keepTask'; taskId: string } // manter on a missing task
  | { type: 'closeMissing'; stage: string } // close all in a stage's missing strip (#279): every closable missing task of the stage goes
  | { type: 'done'; ptyId: string; result?: Record<string, unknown>; verdict?: string; evidence?: string } // hive_done: the command is finished; result is merged into the task (#99); verdict / evidence: how it ended and why (#134)
  | { type: 'pr'; ptyId: string; url: string; slice?: PrSlice } // hive_pr: the PR the worker opened, https only (#99), and its slice (#698)
  | { type: 'prStates'; states: TaskPr[] } // after the poll: the states the PR query read (#207)
  | { type: 'ask'; ptyId: string; question: string } // hive_ask: the worker needs the user; 1 to 2000 characters (#99)
  | { type: 'spawnFailed'; ptyId: string; message: string } // the spawner could not open the session / tab
  | { type: 'createActivity'; taskId: string } // the first /tasks/:id/open is about to make the worktree (#629): the task's activity is born now, so its setup has an id to act on
  | { type: 'setupStarted'; activityId: string; consoleId: string; rows: SetupRow[] } // a worktree setup began, as that run of the console's setup channel (#351): the task's mark and lock; rows: the worktree and branch rows, running from the mark (#390)
  | { type: 'setupStep'; activityId: string; step?: string; rows: SetupRow[] } // its rows changed (#390): the whole list, and the step running as '<INSTRUCTION> <arg>' (#299, #351), absent before the first
  | { type: 'setupEnded'; activityId: string; error?: string } // it ended; error only from the /open path, the spawn's failure goes through spawnFailed (#351)
  | { type: 'activityDeleted'; activityId: string } // the deleteActivity effect ended well: the task advances as after a prompt
  | { type: 'deleteActivityFailed'; activityId: string; message: string } // git refused: the task carries the message until a manual start
  | { type: 'stageCommandEnded'; activityId: string; ptyId: string; code: number; output: string } // #755: that command's pty ended with `code` (124: its timeout ran out); output: its tail, ANSI stripped
  | { type: 'stageCommandStarted'; activityId: string; ptyId: string; at: string; skipped?: true } // #914: the current command's pty started at `at` (ISO), or it was skipped (skipped: true)
  | { type: 'stageCommandOutput'; activityId: string; ptyId: string; at: string } // #914: the current command wrote output at `at` (ISO); at most once every 30 s per pty
  | { type: 'stageCommandsRefused'; activityId: string; ptyId: string; message: string } // #755: the stage cannot run: a name not enabled in the task's workspace, or its worktree failed; nothing more runs
  | { type: 'ciClock'; activityId: string; at: string } // #834: a tick at `at` (ISO) with no read (the query failed or left a PR out): only the timeout is checked
  | { type: 'ciRead'; activityId: string; at: string; prs: CiPrRead[] } // #834: one read of the activity's open PRs' checks at `at` (ISO): the wait goes on, passes, re-runs or fetches the failed logs
  | { type: 'ciFailed'; activityId: string; names: string[]; output: string } // #834: the failed logs are in: the wait ends failed; names: the failed checks', what the error lists
  | { type: 'stopCi'; activityId: string } // #834: the task's Stop or a sleep reached a wait for CI, which holds no pty: the wait ends, stopped, with no verdict
  | { type: 'evaluateJudging'; activityId: string; runId: string } // #877: every reviewer answered; the judge runs
  | { type: 'evaluateEnded'; activityId: string; runId: string; scores: JudgeScore[]; findings: ReviewFinding[] } // #877: the judge answered, one score per dimension
  | { type: 'evaluateBroken'; activityId: string; runId: string; message: string } // #877: a run broke: no verdict, no try
  | { type: 'stopEvaluate'; activityId: string } // #877: the task's Stop or a sleep reached an evaluation, which holds no pty: every run aborts, no verdict
  | { type: 'decompositionIssue'; taskId: string; id: string; number: number } // #865: one step of the decomposition's write; merged into the task's result.decompositionIssues. Keyed by task: one awaiting approval may have no live worker
  | { type: 'forkSynced'; activityId: string; sync: ForkSyncResult } // #854: a fork synced (or failed to) before the activity's worktree was made
  | { type: 'sourceActionFailed'; taskId: string; message: string; leaving: boolean } // the source refused the stage's action (#286): the task keeps the adapter's message; leaving: the refused action was the leaving one (#515)
  | { type: 'worktreeGone'; activityId: string } // the server saw the task's worktree missing from disk: the task is only marked (#208), no path is dropped
  | { type: 'deletingActivity'; activityId: string } // the delete-activity route is about to run git: the task is marked deleting (#182, #573)
  | { type: 'activityRemoved'; activityId: string } // git removed it: the task forgets its worktree, branch and session id, its sessions move to the main repo (#208), and in a delete-activity stage it advances (#210)
  | { type: 'activityKept'; activityId: string } // git refused or failed: only the mark goes
  | { type: 'deletingTask'; taskId: string } // excluir task… is about to remove a local task's worktree (#542): the task is marked deleting, whatever the delete-activity scope
  | { type: 'taskDeleted'; taskId: string } // git removed it: the marked local task leaves the Hive in the same reduction (#542); a failure answers worktreeKept
  | { type: 'setAuto'; taskId: string; auto: boolean } // the auto switch (#164, #573): into (true) or out of (false) the orchestrator's hands
  | { type: 'copySession'; from: SessionRef; to: SessionTarget; name?: string; notice?: string; copied?: string } // #587; name: the dialog's, as the route cleaned it; copied: the transcript dir the route put a temporary <from>.jsonl in
  | { type: 'openLocalSession'; activityId: string; sessionId: string } // continue a local session (#587)
  | { type: 'clearLocalSession'; activityId: string; sessionId: string } // its limpar (#587)
  | { type: 'newLocalSession'; activityId: string; agent?: AgentId; launch?: LaunchPick } // a new session in a workspace's local activity (#590): kept from its start, as a copy into the local is; agent: the local route's kind (#925), absent = the live default; launch: the new session dialog's picks (#257)
  | { type: 'openSession'; activityId: string; continueId?: string; prompt?: string; agent?: AgentId; launch?: LaunchPick } // agent: a new session's, the open route's kind (#925); absent = the live default; a resume runs its session's own. Abrir sessão on any task (#283), or the sidebar's session (#208); continueId = one of continuable(task); a record id (#629): a kept session opens in the task's live activity, born when none; prompt: its first message, rendered by the open route (#758); launch: a new session's picks (#257): the routes refuse it with continueId, and the reducer ignores it then: a resume runs with its record's
  | { type: 'openTerminal'; activityId: string; command?: string; cwd?: string } // a terminal on a task, in its worktree (#283, #570): not a session; command = a workspace's command (#300); cwd = a folder of the worktree the shell route checked (#818)
  | { type: 'openProjectShell'; project: string; cwd: string } // the terminal panel's + (#292): a shell in that project's main checkout, `cwd` (#696)
  | { type: 'sleepTerminal'; terminalId: string; cwd?: string } // #696: the pty is gone or going; cwd as read, absent = keep the held one
  | { type: 'wakeTerminal'; terminalId: string } // #696: effect: spawnTerminal again, in the same id, with the held cwd and scrollback
  | { type: 'forgetTerminal'; terminalId: string } // #696: a sleeping terminal only; effect: remove its files
  | { type: 'captureSession'; terminalId: string; runId: string; agent: AgentId; sessionId?: string; resume?: { sessionId?: string; activityId?: string } } // #696: the shim's register: a free session in that terminal; #932: the agent the shim named, and no id for one that picks its own (Codex); #347: a resume: the held session's id and its record's id (SessionRef's activityId), both, or neither while its first SessionStart has to name it
  | { type: 'worktreeReady'; activityId: string; path: string; branch: string; base: TaskBase | null; local: boolean } // POST /tasks/:id/worktree created it (#164); local = it runs in its workspace's own checkout (#444)
  | { type: 'moveToStage'; taskId: string; stage: string; drop?: { before?: string } } // right-click → move to, or a drag across stages (#164, #366); `drop` pins the task before `before`, or at the end without it
  | { type: 'retry'; taskId: string } // #915: POST /tasks/:id/retry on a task stopped with TRIES_OUT: the spent transition again, its counter back at 0
  | { type: 'dismissError'; taskId: string } // #354: POST /tasks/:id/dismiss-error: the activity's error goes, and its stop too in a stage with an action
  | { type: 'approve'; activityId: string } // Aprovar on a task awaiting approval (#268): the approved transition's sources and the move; a held worker goes on in place
  | { type: 'feedback'; activityId: string; text: string; start: boolean } // start: begin now or queue; ignored on a held worker, which always answers now (#268)
  | { type: 'extendApproval'; activityId: string } // Estender on a held worker (#268)
  | { type: 'approvalExpired'; ptyId: string } // the server's hold timer ran out (#268)
  | { type: 'retryDue'; ptyId: string; until: string } // the server's backoff timer fired for that wait (#805)
  | { type: 'moveTask'; taskId: string; before?: string } // the task goes before `before` (same stage); absent = end of its stage
  | { type: 'resetOrder'; stage: string } // that stage's tasks back to the source's order
  | BenchmarkEvent; // #458: an experiment's life, applied by benchmark-reducer.ts

export interface ProjectSummary {
  number: number;
  title: string;
  url: string;
}

/** How an existing branch relates to the start a new worktree would branch from (#267). */
export type BranchRelation = 'unrelated' | 'stale' | 'own';

/** What GET /tasks/:id/bases answers: the popup's lists for a task with no worktree yet (#131). */
export interface BaseOptions {
  hasWorktree: boolean; // true → the Start dialog asks no base; the lists below are then empty
  defaultRef: string; // `origin/<base>` as #119 would resolve it (config.baseBranch, else origin/HEAD, else main)
  tasks: { ref: string; id: string; title: string }[]; // other tasks' branches, only those with a worktree
  local: string[]; // other local branches, minus the default's and the tasks' branches
  remote: string[]; // `origin/*`, minus `origin/HEAD` and the default
  orphan?: { worktree: boolean; branch: boolean; relation?: BranchRelation; branchName?: string }; // #861; #267: relation and branchName only when the branch exists and its class against defaultRef resolved. #861: only for a task with no activity whose slug git holds a worktree or a branch for: the dialog offers reuse or discard, and the lists are filled for a discard's base
  needsWorkspace?: true; // the task resolves to no workspace: the popup asks for one first, the lists are empty (#179)
}

/** One worktree under .hive/worktrees as GET /worktrees answers it (#181). */
export interface WorktreeRow {
  workspace: string; // which workspace's .hive/worktrees it sits in (#179)
  slug: string;
  path: string;
  branch: string | null; // what git lists checked out there; null = detached
  task?: { id: string; activityId: string; title: string; error?: string; removable: boolean }; // the owning task and its live activity, what its removal posts to (#629); removable = canDeleteActivity(task, workers)
  orphan?: 'noTask' | 'deleteActivityFailed' | 'kept'; // kept (#861): a task activity that outlived its tasks, kept while its worktree exists
  nested: { path: string; uncommitted: number }[]; // #653: the nested worktrees present in this one; [] = none
}

/** Why a path cannot be a workspace's nested repo (#653): its shape, then git's answers, in order. root: the top level, for notTopLevel. */
export type NestedCause = 'badPath' | 'notRepo' | 'notTopLevel' | 'submodule' | 'tracked' | 'notIgnored';
export interface NestedProblem { cause: NestedCause; root?: string }
/** One listed nested repo as GET /settings/nested-repos reads it (#653): its GitHub repository and resolved base, or its problem. */
export interface NestedRepoRead { path: string; repository?: string; base?: string; problem?: NestedProblem }
/** GET /settings/nested-repos (#653): the listed paths, and the ignored repositories the Hive found that are not listed. */
export interface NestedReposAnswer { repos: NestedRepoRead[]; suggested: { path: string; repository?: string }[] }

/** How a copy's first run starts (#587): the source session resumed as a new one (--fork-session) and the notice as its first prompt when asked. */
export interface SessionCopy { from: string; name?: string; notice?: string } // name: the dialog's, the fork's Claude Code title

export type Effect =
  | { type: 'spawn'; worker: Worker; activity: Activity; task: Task; stage: Stage; session: SessionPolicy; run: SpawnRun; prompt?: string; result?: Record<string, unknown> /* #629: resultOf at the reduction: what {result.<path>} renders */ } // session already resolved: continue without an id runs as new; run: the prompt (#283); prompt: a handover's (#134), told instead of the run's own
  | { type: 'setColumn'; itemId: string; column: string }
  | { type: 'sourceAction'; itemId: string; taskId: string; action: ItemAction } // what a stage's onStart / a transition's sources ask of the source beyond a move (#286, #515); a leaving one is answered with closeTask or sourceActionFailed
  | { type: 'kill'; slug: string; ptyId: string }
  | { type: 'continue'; ptyId: string; activity: Activity; task: Task; stage: Stage; prompt?: string; result?: Record<string, unknown> /* #629: resultOf at the reduction: what {result.<path>} renders */ } // answers the worker's Stop with `stage`'s prompt: same process, no spawn; prompt: a handover's or a handoff request (#134, #692), the reason instead of the stage's prompt
  | { type: 'captureCheckpoint'; activity: Activity; task: Task; stage: string; ended: 'done' } // #619: first in its batch, so the capture runs before a continue
  | { type: 'deleteActivity'; activity: Activity; task: Task; scope: DeleteActivityScope } // delete the activity per the scope (#236, #573); the server answers with activityDeleted / deleteActivityFailed
  | { type: 'stageCommand'; activity: Activity; task: Task; stage: Stage; at: number; ptyId: string } // #755: run command `at` of the commands stage in a pty of its own; the server answers stageCommandEnded or stageCommandsRefused
  | { type: 'ciRead'; activityId: string } // #834: read the activity's CI now, at the stage's start; the timer reads it after
  | { type: 'ciRerun'; activityId: string; runs: CiRerun[] } // #834: gh run rerun --failed, each run once
  | { type: 'ciCollect'; activityId: string; failed: CiCheck[] } // #834: fetch the failed checks' logs, then answer ciFailed
  | { type: 'evaluate'; activity: Activity; task: Task; stage: Stage; runId: string; result?: Record<string, unknown> } // #877: run the reviewers then the judge; result: what {result.<path>} renders in the rubric
  | { type: 'abortEvaluate'; runId: string } // #877: Stop, sleep, delete or a vanished stage: abort every run of that evaluation
  | { type: 'spawnSession'; worker: Worker; activity: Activity; task?: Task; sessionId?: string /* #931: absent on a new session of an agent that picks its own id (Codex): the first SessionStart names it */; continues: boolean; copy?: SessionCopy; repo?: true /* #208, #629: the session it continues is a repo one: it runs in the workspace's main repo */; prompt?: string /* #758: its first message */ } // the user's own session (#164, #283): task: on a task's activity; none on a local one (#587, #629); copy: a copy's first run
  | { type: 'dropCopiedTranscript'; dir: string; sessionId: string } // #587: the temporary <sessionId>.jsonl a copy put in `dir`, a transcript dir
  | { type: 'removeTranscripts'; task: Task; activity: Activity; session: Session } // #494: the transcript of the run's session a clearSession stage forgot, removed where `activity` works; emitted only under deleteActivity.transcripts
  | { type: 'forgetScrollback'; ptyId: string } // #672: the pty host drops a sleeping run's kept transcript, or a live run's at its exit
  | { type: 'readCwd'; terminalId: string } // #696: the server reads the shell's cwd, then dispatches sleepTerminal with it
  | { type: 'dropTerminalFiles'; terminalId: string } // #696: a forgotten terminal's scrollback and history, and its ring in the pty host
  | { type: 'killCaptured'; ptyId: string } // #696: Stop on a captured session: pkill on its run's MCP config path; the terminal stays
  | { type: 'spawnTerminal'; terminal: Terminal; activity: Activity; task?: Task } // a terminal the user opened (#283): the pool runs it with no worker; no task: a workspace's local activity (#292, #629)
  | { type: 'shutdown' } // no worker left while armed (#233): the server shuts the OS down
  | { type: 'hold'; ptyId: string; until: string } // keep the Stop's answer until `until`, or until a continue / release (#268)
  | { type: 'release'; ptyId: string } // answer a held Stop with no decision (#268)
  | { type: 'input'; ptyId: string; text: string }; // typed into a live run's pty: a free session's feedback, lead included (#483), or a retry's continue (#805)

export interface SettingsInfo {
  configured: boolean;
  /** The Hive's home (`${XDG_CONFIG_HOME:-~/.config}/agent-hive`, or `HIVE_HOME` itself when set, #202, #310): the launcher's probe compares it; the UI does not read it. */
  home: string;
  /** In setup mode, the saved config (if any) so the form reopens prefilled. */
  config?: Config;
  /** Why the saved config could not boot (source missing, unreadable…); shown in the settings form. */
  error?: string;
  /** Setup mode with nothing saved to prefill from: the folder the Hive was started in, when it is a git repo's top level (#202). */
  proposedWorkspace?: string;
  /** Effective UI language: the config's when set, else the system's. Read by app.ts before any render. */
  language: Language;
  /** The agents this machine has, in AGENT_IDS order (#516): the form disables a missing one. */
  agents: AgentAvailability[];
}

export interface SettingsBody {
  /** The Comb's task id prefix; the form always sends it. */
  prefix: string;
  /** comb.workspaces (#179): every workspace the Comb runs tasks in. The form always sends it; an API caller that omits it keeps the saved ones. */
  workspaces: Workspace[];
  /** comb.commands (#511). The form always sends it, [] included; an API caller that omits it keeps the saved ones. A first setup without it
   * is a parse error naming comb.commands. */
  commands?: Command[];
  /** comb.sources (#180); [] = no external source. The form always sends it; an API caller that omits it keeps the saved ones. */
  sources?: SourceConfig[];
  /** The form always sends it; an API caller that omits it keeps the current one. A first setup without it is a parse error naming auth.github. */
  auth?: AuthConfig;
  /** The form always sends it; an API caller that omits it keeps the current stages (#286: was columns). */
  stages?: Stage[];
  /** comb.transitions (#134). The form always sends it; a caller that sends stages without it gets them from those stages, one that sends neither keeps the saved ones. */
  transitions?: Transition[];
  /** The form always sends it (empty field = key absent); an API caller that omits it keeps the current budget. */
  budget?: Budget;
  /** The form always sends it (empty table = []); an API caller that omits it keeps the current rules. */
  usageRules?: UsageRule[];
  /** The form always sends it (empty field = key absent); an API caller that omits it keeps the current template. */
  branch?: string;
  /** The form always sends it; an API caller that omits it keeps the current one (or the system's on first setup). */
  language?: Language;
  /** The form always sends it (#296). configFrom still reads it over the saved file, so an API caller that omits it keeps the saved one; a
   * first setup without it is a parse error naming theme. */
  theme: Theme;
  /** The form always sends it (#376), "" included. configFrom still reads it over the saved file, so an API caller that omits it keeps the
   * saved one; a first setup without it is a parse error naming terminalFont. */
  terminalFont: string;
  /** The form always sends it (#404), [] included. configFrom still reads it over the saved file, so an API caller that omits it keeps the
   * saved list (POST /trusted-domains sends only this key and the prefix); a first setup without it is a parse error naming trustedDomains. */
  trustedDomains: string[];
  /** The form always sends it (#449), {} included. configFrom still reads it over the saved file, so an API caller that omits it keeps the
   * saved map (POST /trusted-domains sends neither); a first setup without it is a parse error naming shortcuts. */
  shortcuts: Shortcuts;
  /** The form always sends it (#353). configFrom still reads it over the saved file, so an API caller that omits it keeps the saved value; a
   * first setup without it is a parse error naming consoleLines. */
  consoleLines: number;
  /** The form always sends it (empty field = ""); "" clears it back to automatic, an API caller that omits it keeps the current one. */
  baseBranch?: string;
  /** The form always sends it; an API caller that omits it keeps the saved one. A first setup without it is a parse error naming onClose (#513). */
  onClose?: OnClose;
  /** Same rules as onClose (#199). */
  notifications?: NotificationSettings;
  /** The form always sends it; an API caller that omits it keeps the saved one. A first setup without it is a parse error naming deleteActivity (#236, #573). */
  deleteActivity?: DeleteActivityScope;
  /** The form always sends it; an API caller that omits it keeps the saved value. A first setup without it is a parse error naming it (#233). */
  shutdownIdleMinutes?: number;
  /** Same rules as shutdownIdleMinutes (#268). */
  approvalMinutes?: number;
  /** Same rules as shutdownIdleMinutes (#805). */
  rateLimitWaitMinutes?: number;
  /** Same rules as onClose. */
  showGithubQuota?: boolean;
  /** Same rules as onClose (#614). */
  closeSessionTab?: CloseTabAction;
  /** Same rules as onClose (#614). */
  closeStageTab?: CloseTabAction;
  /** Same rules as onClose (#614). The close-tab notice's checkbox sends it alone, with the prefix. */
  closeSessionTabNotice?: boolean;
  /** Same rules as closeSessionTabNotice (#614). */
  closeStageTabNotice?: boolean;
  /** Same rules as closeSessionTabNotice (#672): the sleep notice's checkbox sends one alone, with the prefix. */
  sleepNotice?: boolean;
  sleepAutoNotice?: boolean;
  sleepIdleNotice?: boolean;
  sleepAllNotice?: boolean;
  /** Same rules as onClose (#696). */
  closeTerminalTab?: CloseTabAction;
  /** Same rules as closeSessionTabNotice (#696). */
  closeTerminalTabNotice?: boolean;
  /** Same rules as onClose (#516). */
  defaultAgent?: AgentId;
  /** #924: the form always sends it; an API caller that omits it keeps the saved lists; a first setup without it starts with none. */
  agentArgs?: Record<AgentId, string[]>;
  /** Same rules as onClose (#754). */
  fileIcons?: FileIcons;
  /** Same rules as onClose (#821). */
  sidebarsPerView?: SidebarsPerView;
  /** comb.hiveSource (#846): the form always sends it; an API caller that omits it keeps the saved one. */
  hiveSource?: boolean;
  /** comb.createIn (#846): the form always sends it; an API caller that omits it keeps the saved one. */
  createIn?: string;
  /** Same rules as onClose (#727). */
  signals?: SignalSettings;
  /** Same rules as onClose (#780). */
  editor?: EditorConfig;
  /** The template reviewer (#328): the Settings form never sends it, so a save keeps the saved one; the reviewer menu (4.3) may. */
  reviewer?: ReviewerConfig;
  /** The Hive's MCP settings (#333): the Settings form never sends it, the MCP routes do. */
  mcp?: McpSettings;
  /** Old source name → new source name (#278). The form always sends it ({} when nothing was renamed); an API caller that omits it renames
   * nothing; a first setup ignores it. Never written to hive.config.json. */
  renames?: Record<string, string>;
  /** Saved stage name → new name (#861). The form sends it only when a stage was renamed; an API caller that omits it renames nothing. Never
   * written to hive.config.json. */
  stageRenames?: Record<string, string>;
}

export interface SettingsResult {
  ok: true;
}

/** What POST /tasks/:id/open and POST /activities/:id/sessions/:session/open answer (#249): the run openSession started, once the pool confirmed
 * its pty exists, so the page can attach it with no extra click on terminal. Absent ptyId: no run to attach (a spawn
 * failure, already shown through the error bar, or neither kind of effect fired). */
export interface OpenResult {
  ok: true;
  ptyId?: string;
}

/** What `GET /events` streams: the whole State plus the server-computed effective signal, or a marker while the Hive has no config yet. */
export type EventsPayload = (State & { effective: EffectiveLimits }) | { configured: false };

/** One comment on a task, as the source shows it. */
export interface TaskComment {
  author: string; // login; "ghost" when the account is gone
  createdAt: string; // ISO
  body: string; // markdown, rendered by the panel
  url: string;
}

/** A field of a source's project, as its native view lists it (#756). `progress` is GitHub's sub-issues progress; `other` is a kind the Hive
 * does not know, shown as the text the source answers, if any. `options`: a single-select's options or an iteration field's iterations, in
 * the project's order: what the view groups by. */
export interface ProjectField {
  name: string;
  type: 'singleSelect' | 'text' | 'number' | 'date' | 'iteration' | 'progress' | 'milestone' | 'repository' | 'parentIssue' | 'issueType' | 'other';
  options?: string[];
}

/** The built-in fields a fixed column shows (#756), each at the index of the shown field it precedes in the project; one the project lacks
 * is absent. What lets status, labels and resp. take their project position among the field columns. */
export interface ProjectBuiltins { status?: number; labels?: number; assignees?: number }

/** A pull request linked to a project item, as the source reads it (#756). */
export interface ProjectPr { number: number; url: string; state: PrState; checks?: Signal; draft?: true } // draft: #757, read by the repository list

/** One issue of a source's project, unfiltered (#756). `out` only when the source's filter or `epics: hide` keeps it from the Hive; an
 * uncited column is not `out`, the UI knows it from the stages. Field values are keyed by field name: number for number fields, `done/total`
 * for progress, an ISO date for dates, else text. `body` is what a task created from it starts with. */
export interface ProjectItem {
  itemId: string; // namespaced like Item.itemId
  id: string; // issue number
  title: string;
  body: string;
  url: string;
  status?: string; // the Status option, absent when unset
  labels: string[];
  assignees: string[];
  repository?: string;
  workspaceHint?: string; // from a task-props rule only, as on a listed task (#688)
  fields: Record<string, string | number>;
  pullRequests: ProjectPr[];
  out?: 'filter' | 'epic';
  createdAt?: string; // ISO, the issue's own dates (#756, addendum 2); closedAt only on a closed issue
  updatedAt?: string;
  closedAt?: string;
  blockedBy?: BlockerRef[]; // #61: the issue's blocked-by relations, open and closed; absent = not read
}

/** A source's native view (#756): its Status options in order, each with the stage that cites it, its fields, where its built-in fields
 * sit among them, and its issues. */
export interface ProjectView {
  statuses: { name: string; stage?: string }[]; fields: ProjectField[]; builtins: ProjectBuiltins; items: ProjectItem[]; truncated: boolean;
}

/** A field's value as the write path speaks it (#686): a name, a title, a number, an ISO date (YYYY-MM-DD), logins; null clears it. */
export type FieldValue = string | number | string[] | null;

/** One field of an item as its editors read it (#686): its kind, its current value and, for a choice, what it can be. */
export interface ItemField {
  name: string;
  type: ProjectField['type'] | 'assignees' | 'labels'; // milestone and issueType are already ProjectField kinds; assignees and labels are the issue's own
  value: FieldValue; // unset on the source = null; assignees and labels = [] when none
  options?: string[]; // single-select options, iterations, open milestones, issue types, assignable logins, the repository's labels
  readOnly?: true; // repository, progress, parentIssue, other
}

/** What a field write answers (#686): the item re-read after it. `entry` is absent when the item is out of the source's listing. */
export interface FieldWrite { fields: ItemField[]; row: ProjectItem; entry?: SourceItem }

/** What a relation write answers (#56): the item's relations after it, and the re-read entry when the item is a listed task (as FieldWrite.entry). */
export interface BlockerWrite { blockers: ItemBlockers; entry?: SourceItem }

/** A repository the flow sidebar lists (#757): a workspace's origin or an open PR's repository. */
export interface RepoSummary {
  repository: string; // owner/name
  url: string;
  workspace: string; // the workspace whose colour it takes
  openPrs: number;
  openIssues: number;
  closedIssues: number;
  lastActivity?: string; // ISO: latest of pushedAt, last updated issue, last updated PR
  role?: 'original' | 'fork' | 'nested'; // #854: a fork workspace's pair; #653: a workspace's nested repo, paired with its repository
  pr?: PrTarget; // #854: the pair's workspace's PR target, what the fork's empty states read
  fork?: { parent: string }; // #854: GitHub says it is a fork of `parent` (owner/name)
  pair?: string; // #886: the other repository of a fork workspace's pair (owner/name as listed), what the sidebar pairs by
  canPush: boolean; // #854: the login's viewerPermission is ADMIN, MAINTAIN or WRITE
  issuesEnabled: boolean; // #854: GitHub's hasIssuesEnabled
  syncedAt: string | null; // #181: ISO, the repo scope's last complete round; null: never synced
}

/** One issue of a repository's list (#757). `pullRequests` reuses #756's ProjectPr; `draft` is added there. */
export interface RepoIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  assignees: string[];
  updatedAt: string; // ISO
  pullRequests: ProjectPr[];
}

/** A page of a repository's issues in one state (#757). */
export interface RepoIssues {
  state: 'open' | 'closed'; total: number; issues: RepoIssue[]; truncated: boolean;
  syncedAt: string | null; // #181: the issues scope's last complete round; null: never synced, and no rows
}

/** An issue as its page shows it (#757). `updatedAt` is sent back with a title or description edit to detect a change made meanwhile. */
export interface IssuePage extends RepoIssue {
  repository: string;
  body: string;
  author: string;
  createdAt: string;
  comments: TaskComment[]; // the first 100
  commentCount: number; // GitHub's totalCount
}

export interface ReadOptions { fresh?: boolean } // #282: fresh reads GitHub now, not the read model

/** What every source adapter implements; src/source.ts builds one per comb.sources entry (#180). */
export interface Source {
  resolveFields(): Promise<void>; // every column name the config cites exists on the source
  listItems(): Promise<SourceItem[]>; // tasks in any cited column, in source order
  stored?(): Promise<SourceItem[]>; // #191: the listing the read model holds, read with no network call; [] when there is none
  setColumn(itemId: string, column: string): Promise<void>;
  apply(itemId: string, action: ItemAction): Promise<void>; // what a stage's onStart / a transition's sources ask beyond a move (#286, #515); rejects for an action its type's SOURCE_ACTIONS entry lacks
  settingsOptions(): Promise<string[]>; // status values available, for the settings form
  quota?(): Promise<SourceQuota | undefined>; // the polling account's API quota; a source without one leaves it out
  comments?(itemId: string): Promise<TaskComment[]>; // oldest first, read when the panel opens on a task; a source without comments leaves it out
  fieldsOf?(itemId: string, options?: ReadOptions): Promise<ItemField[]>; // #686: in the project's order, Status included; #282: from the read model unless fresh
  setField?(itemId: string, field: string, value: FieldValue): Promise<FieldWrite>; // #686: writes, then re-reads the item
  relate?(itemId: string, change: BlockerChange): Promise<BlockerWrite>; // #56: writes the relation, then re-reads the item's relations
  findBlockers?(itemId: string, text: string): Promise<BlockerRef[]>; // #57: issues of the item's repository whose title matches, at most 8
  create?(fields: { title: string; body?: string; column: string }): Promise<string>; // #846: a new item in column, resolving to its adapter id (namespaced: its itemId); a type that cannot create leaves it out
  project?(options?: ReadOptions): Promise<ProjectView>; // #756: the source's native view, every issue unfiltered; #282: from the read model unless fresh
}

/** What one source adapter is built from (#180): that source (its epics keys included, #30), the Comb's stages and the transport. */
export type SourceSpec = Pick<Config, 'auth'> & { source: SourceConfig; stages: Stage[]; transitions: Transition[] };

/** `execFile` promisified. The git, gh and pkill calls take one, so tests never run a command. `maxBuffer` reaches execFile as is:
 * the task diff (#270) raises it past the 1 MB default and tells an overflow apart. `input` is what a PR write sends to gh's stdin (#592):
 * only a test's exec reads it, since the real gh runner is ghExec, which pipes it itself. */
export type Exec = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; maxBuffer?: number; input?: string; timeout?: number }) => Promise<{ stdout: string }>; // timeout: #834's gh calls, ms

/** What the server hands a spawner besides the launch: the daemon's pty host (#251) and the absolute path of hive.secret, which reaches the
 *  run's env as HIVE_SECRET_FILE: curl sends the header from that file, so the value never reaches an argv (#467). */
export interface SpawnOptions {
  ptys: PtyHost;
  secretFile: string;
}

/** What the server injects so tests never open a session. `onError` is for kill failures and a run TMPDIR that cannot be removed: a spawn failure is `started` rejecting. */
export interface PtyHandlers {
  onExit(): void; // once, on the run's end or kill
  onError(message: string): void; // shown in the dashboard error bar
}

export interface PtyHandle {
  started: Promise<void>; // resolves when the pty exists; rejects with the spawner's error (`pty: …`)
  kill(): Promise<void>; // resolves when the process no longer exists; one kill per handle
}

/** One word of an agent's argv (#924): a plain word, or one of the Hive's own flags with its value, which ptyCommand renders bare with the
 * value quoted. Here, not in agents/runner.ts, so the page's type check never follows a runner's imports. */
export type LaunchArg = string | readonly [flag: string, value: string];

/** Everything a spawner needs to start one run or terminal in a pty of the daemon's (#251, #647). */
export interface PtyLaunch {
  ptyId: string;
  slug: string; // names the prompt file and the worktree directory
  cwd: string; // the task's worktree: where the worker runs. The Hive created it, so no runner needs a worktree flag of its own
  port: number;
  agent?: { command: string; argv: LaunchArg[] }; // #924: the agent's CLI and the argv its runner rendered (launch or copy); absent for a terminal
  promptPath?: string; // the rendered prompt on disk: the command line reads it with $(cat …); absent = the agent starts with no prompt (#164)
  terminal?: true; // a terminal in the task's worktree (#283, #647): no agent
  run?: { command: string; env: Record<string, string> }; // with terminal: a workspace's run command instead of the interactive shell (#300); the run ends with it (#353); env: the command's own only (#738), names passed ENV_NAME
  env?: Record<string, string>; // the run's own on top of ptyEnv (#696, #738): the workspace's, then a kept terminal's HISTFILE and the shim's PATH
  keep?: PtyKeep; // #696: a kept terminal's ring: written to its log as it ends, the old one replayed on a wake
  size?: TerminalSize; // #808: the grid the page sent with the request that opened the run, the one the pty is born at; absent: the host's fallback
}

export type LaunchPty = (launch: PtyLaunch, handlers: PtyHandlers, options?: SpawnOptions) => PtyHandle;

// A workspace's memory (#797): short lessons the workers save with hive_remember and the user curates in Settings, injected under the protocol
export const MEMORY_KINDS = ['pref', 'fact', 'avoid'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const isMemoryKind = (value: unknown): value is MemoryKind => typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
export type MemoryOrigin = 'user' | 'local' | { task: string; stage?: string }; // local: a local session's (#256); task: the visible id; stage only for a stage run
export interface MemoryUse { at: string; task?: string; stage?: string; why: string } // the latest hive_applied; task absent: a local session's (#256)
export interface MemoryEntry {
  id: string; kind: MemoryKind; text: string; origin: MemoryOrigin;
  at: string; // ISO time of the last write of kind or text
  uses: number; // hive_applied calls naming it; 0 for a new lesson; an edit keeps it
  lastUsed?: MemoryUse;
}
export interface MemoryFile { nextId: number; entries: MemoryEntry[] } // empty: { nextId: 1, entries: [] }
/** GET /workspaces/:name/memory (#797), and every write's answer. used: the sum of the entries' text lengths, cap: the workspace's memoryCap (#73) */
export interface MemoryView { entries: MemoryEntry[]; used: number; cap: number; textMax: number }
export const MEMORY_CAP_MIN = 300; // #73: a workspace's memoryCap holds at least one full lesson (MEMORY_TEXT_MAX)
export const MEMORY_CAP_MAX = 20000; // #73: a full memory stays around 5k tokens per run
export const MEMORY_CAP_DEFAULT = 4000; // #73: what a new workspace row shows; the parser has no default
// #78: the colours Settings offers a workspace, in the picker's order. One lightness and chroma, so no preset stands out on the dark theme
export const WORKSPACE_PRESET_COLORS: readonly string[] = [25, 70, 130, 190, 240, 295, 340].map((h) => `oklch(0.72 0.12 ${h})`);
export const WORKSPACE_HEX_COLOR = /^#[0-9a-f]{6}$/; // #78: a custom colour as the system picker gives it; the parser refuses any other shape
export const MEMORY_TEXT_MAX = 300; // characters per lesson; a candidate setting in docs/agent/settings-candidates.md
export const MEMORY_REFUSALS = ['bad_memory', 'memory_full', 'memory_secret', 'unknown_memory'] as const;
export type MemoryRefusalCode = (typeof MEMORY_REFUSALS)[number];
/** GET /workspaces/:name/memory/stats (#797): the last MEMORY_STATS_DAYS days of facts.jsonl for the workspace. */
export interface MemoryStats {
  runs: number; // run.spawned with this workspace's memory
  cited: number; // distinct ids of current entries named by memory.applied
  tokensPerRun?: number; // mean memory_chars / 4, rounded; absent when runs = 0
  last?: { at: string; task: string; stage?: string; cited: number }; // the latest such run, and the distinct ids its session cited
}
export const MEMORY_STATS_DAYS = 7;

/** The plugins view's items (#315): a skill is a folder, a specialist one file. `specialist` is the glossary's specialized agent; `agent`
 * stays the harness. Skill first: one name per origin, and a skill wins a repository's clash. */
export const ITEM_KINDS = ['skill', 'specialist'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemState = 'original' | 'customized' | 'update available' | 'workspace';

export interface ItemVersion {
  name: string;
  from: string | null; // 'original', a version name, or null (user-created)
  workspaces: string[];
  unknownWorkspaces: string[]; // listed in version.json, absent from the config: kept, never deleted silently
  updateAvailable: boolean;
  hiveVersion?: string;
  editedAt: string; // ISO: the newest mtime among the version's files/ (#320, decision 6); a fresh copy's is its creation
}

/** Where an item is used (#313): a configured stage runs the skill, or another item's main text names it (by its id). */
export type ItemUsage = { kind: 'stage'; stage: string } | { kind: 'caller'; id: string };

export interface CatalogueItem {
  id: string; // `${origin}:${name}`: one name per origin, skill or specialist
  origin: string; // 'hive' or a workspace name
  kind: ItemKind;
  name: string;
  description: string;
  basedOn?: BasedOn[]; // #338: every origin, in header order
  userCreated: boolean;
  state: ItemState; // update available > customized > original; 'workspace' for a repository item with no version
  versions: ItemVersion[];
  onOriginal: string[]; // workspaces that use the original (empty for a user-created item)
  files: string[]; // relative paths of the original, or of the first version for a user-created item
  usage: ItemUsage[]; // #313: stages first, then callers; the catalogue's list computes it, a single item's read (findItem) answers []
  error?: { message: string; line?: number }; // the header did not parse, a version.json did not, or a skill took the name
}

export interface ItemFile { path: string; text: string; savedAt?: string } // savedAt: the file's mtime (ISO), #319; absent for the original's files
export interface ItemRead { item: CatalogueItem; version: string | null; files: ItemFile[] } // version null: the original
/** GET /api/lint-input (#327): what the editor's lint reads beside the open file, the catalogue's variables and the plugin's scripts. */
export interface LintInputRead { catalogue: LintItem[]; scripts: string[] }

/** A conflict's two answers in a version's update (#324): keep the version's text, or take the shipped one. */
export const UPDATE_CHOICES = ['mine', 'hive'] as const;
export type UpdateChoice = (typeof UPDATE_CHOICES)[number];

export interface UpdateChange {
  kind: 'clean';
  file: string;
  heading: string; // nearest heading above the change in the version's text, else the file path
  removed: string[]; // lines of the version's text the update replaces
  added: string[]; // lines it puts in their place
}

export interface UpdateConflict {
  kind: 'conflict';
  id: string; // `${file}#${n}`, n counting from 0 in the merge output; `${file}#file` for a whole-file conflict
  file: string;
  heading: string;
  mine: string[] | null; // null: the side has no such file (deleted)
  hive: string[] | null;
  base: string[];
}

export interface UpdatePreview {
  version: string;
  from?: string; // version.json's hiveVersion
  to?: string; // the shipped plugin's version
  token: string; // sha256 of the three inputs; apply must send it back
  changes: (UpdateChange | UpdateConflict)[]; // ordered by file, then by position
}
