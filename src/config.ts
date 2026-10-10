import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { LOG_LEVELS, type LogLevel } from './log.js';
import { LANGUAGES } from './language.js';
import { branchProblem, COMB_PREFIX, DURATION, onSource, WORKSPACE_NAME, RESERVED_SOURCE, HIVE_SOURCE, isReservedSource, type BranchProblem, type WorkspaceNames, resolveWorkspace } from './tasks.js';
import { createInProblem, type CreateInProblem } from './create-in.js';
import { REPOSITORY } from './task-refs.js';
import { parseSourceTaskProps } from './task-props.js';
import { migrateConfig } from './config-migrate.js';
import { parseTransitions, parseVerdicts } from './config-transitions.js';
import { parseConventions } from './conventions.js';
import { parseFork } from './fork.js';
import { commandsIn, parseEnv, parseCommands, parseStageCi, parseStageCommands, parseTimeout } from './run-commands.js';
import { parseShortcuts } from './shortcuts.js';
import { isTrustedHost } from './trusted-hosts.js';
import { parseEditorConfig } from './editor-config.js';
import { parseSignals } from './signals-config.js';
import { AGENT_IDS, END, APPROVAL_HOLD_MAX_MIN, RATE_LIMIT_WAIT_MAX, SOURCE_ACTIONS, CLOSE_TAB_ACTIONS, CONSOLE_LINES_MAX, CONSOLE_LINES_MIN, FILE_ICON_SCOPES, FILE_ICON_SETS, FILTER_FIELDS, FILTER_OPS, GITHUB_AUTHS, isLeaving, NOTIFICATION_KINDS, ON_CLOSE, RULE_SIGNALS, RULE_SOURCES, SHUTDOWN_IDLE_MAX, THEMES, type AgentId, type AuthConfig, type SourceAction, type SourceConfig, type SourceFields, type Budget, type Task, type TaskFilter, type DeleteActivityScope, type CloseTabAction, type Stage, type StageAction, type CombConfig, type Config, type EpicsMode, type FileIcons, type FileIconScope, type FileIconSet, type SidebarsPerView, type SignalSettings, type FilterRule, type GithubAuth, type Language, type NotificationSettings, type OnClose, type Workspace, type EditorConfig, type RuleSignal, type RuleSource, type SessionPolicy, type State, type Theme, type UsageRule } from './types.js';

export const CONFIG_FILE = 'hive.config.json';

export const SOURCE_TYPES: readonly SourceConfig['type'][] = ['github'];
export const EPICS_MODES: readonly EpicsMode[] = ['ignore', 'queue'];
export const SESSION_POLICIES: readonly SessionPolicy[] = ['new', 'continue'];
export const DEFAULT_CONFIG: Omit<Config, 'comb' | 'auth' | 'onClose' | 'notifications' | 'deleteActivity' | 'shutdownIdleMinutes' | 'approvalMinutes' | 'rateLimitWaitMinutes' | 'showGithubQuota' | 'closeSessionTab' | 'closeStageTab' | 'closeSessionTabNotice' | 'closeStageTabNotice' | 'sleepNotice' | 'sleepAutoNotice' | 'sleepIdleNotice' | 'sleepAllNotice' | 'closeTerminalTab' | 'closeTerminalTabNotice' | 'defaultAgent' | 'theme' | 'terminalFont' | 'trustedDomains' | 'consoleLines' | 'shortcuts' | 'fileIcons' | 'sidebarsPerView' | 'signals' | 'editor'> = {
  epics: 'ignore',
  logLevel: 'info',
  claudeArgs: [],
  budget: {},
  usageRules: [],
};

const BUDGET_KEYS = ['maxTokensPerHour', 'maxTokensPerDay'] as const;
const PERCENT_MAX = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty string`);
  return value;
}

// Anything git could read as an option (a leading `-`) or as a revision expression is refused here, at the boundary: the value
// reaches `git fetch` as an argv element, and `--upload-pack=<cmd>` runs <cmd> when origin resolves to a local path. The shape is
// deliberately narrower than git's own check-ref-format — a branch to build on is a plain name, not `main~1` or `a..b`.
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function requireBranch(value: unknown, field: string): string {
  const name = requireString(value, field);
  if (!BRANCH_NAME.test(name) || name.includes('..')) throw new Error(`${CONFIG_FILE}: "${field}" must be a branch name`);
  return name;
}

export function requireInt(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-negative integer`);
  return value as number;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${CONFIG_FILE}: "${field}" must be true or false`);
  return value;
}

const optional = <T>(value: unknown, fallback: T, check: (v: unknown) => T): T => (value === undefined ? fallback : check(value));

// Entries are trimmed; a blank one is refused rather than read as "any".
function requireStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string' && x.trim() !== '')) {
    throw new Error(`${CONFIG_FILE}: "${field}" must be an array of strings`);
  }
  return value.map((x: string) => x.trim());
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${allowed.join(', ')}`);
  return value as T;
}

// #245: a criterion, an operator and the values it ORs. A rule with no values means nothing, so it is refused rather than read as "any";
// `name` names a projectField rule's single-select field and appears on no other rule. A blocked rule (#441) is yes/no: a value key on it,
// even [], would read as meaning something, so it is refused.
function parseRule(raw: unknown, field: string): FilterRule {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const criterion = requireOneOf(raw.field, FILTER_FIELDS, `${field}.field`);
  const op = requireOneOf(raw.op, FILTER_OPS, `${field}.op`);
  if (criterion === 'blocked' && raw.values !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.values" is not allowed on a blocked rule`);
  if (criterion !== 'projectField' && raw.name !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.name" is only allowed on a projectField rule`);
  if (criterion === 'blocked') return { field: criterion, op };
  const values = requireStringList(raw.values, `${field}.values`);
  if (values.length === 0) throw new Error(`${CONFIG_FILE}: "${field}.values" must be a non-empty array of strings`);
  if (criterion === 'projectField') {
    return { field: criterion, name: requireString(typeof raw.name === 'string' ? raw.name.trim() : raw.name, `${field}.name`), op, values };
  }
  return { field: criterion, op, values };
}

// Required, no compat default (#245): the old { assignees, labels, milestones } object is named in the message, so the one hand-written file
// says what changed.
function parseFilter(raw: unknown, field: string): TaskFilter {
  if (!Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an array of rules (the assignees/labels/milestones object is gone, see #245)`);
  return raw.map((rule, i) => parseRule(rule, `${field}[${i}]`));
}

function requireRepository(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) throw new Error(`${CONFIG_FILE}: "${field}" must be a repository as owner/name`);
  return value;
}

// `field` is how the source appears in error messages: "comb.sources[i]" in the file, "source" for a spec the settings form sends. `workspaces` are
// the Comb's names, which the source's task properties must name (#293, #688); they are read after the type's own fields, so those are named first.
export function parseSource(raw: unknown, field: string, workspaces: readonly string[]): SourceFields {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  switch (raw.type) {
    case 'github':
      return {
        type: 'github', owner: requireString(raw.owner, `${field}.owner`), number: requireInt(raw.number, `${field}.number`),
        filter: parseFilter(raw.filter, `${field}.filter`), // after owner and number: a source missing those still names them first
        taskProps: parseSourceTaskProps(raw.taskProps, `${field}.taskProps`, workspaces),
        ...(raw.repository === undefined ? {} : { repository: requireRepository(raw.repository, `${field}.repository`) }),
      };
    default:
      throw new Error(`${CONFIG_FILE}: "${field}.type" must be one of: ${SOURCE_TYPES.join(', ')}`);
  }
}

// One message for the three ways this goes wrong (key missing, github missing, unknown value): hive.config.json is gitignored,
// so no migration can write it and the message has to state the fix outright.
export function parseAuth(raw: unknown): AuthConfig {
  const github = isRecord(raw) ? raw.github : undefined;
  if (!GITHUB_AUTHS.includes(github as GithubAuth)) throw new Error(`${CONFIG_FILE}: "auth.github" is required and must be one of: ${GITHUB_AUTHS.join(', ')}`);
  return { github: github as GithubAuth };
}

// Absent keys stay absent (never become 0) so a hive.config.json without limits stays clean.
function parseBudget(raw: unknown): Budget {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "budget" must be an object`);
  return Object.fromEntries(
    BUDGET_KEYS.flatMap((key) => (raw[key] === undefined ? [] : [[key, requireInt(raw[key], `budget.${key}`)]])),
  ) as Budget;
}

function requireSource(value: unknown, field: string): RuleSource {
  if (!RULE_SOURCES.includes(value as RuleSource)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${RULE_SOURCES.join(', ')}`);
  return value as RuleSource;
}

// Green never restricts anything, so a rule cannot set it: yellow or red only.
function requireSignal(value: unknown, field: string): RuleSignal {
  if (!RULE_SIGNALS.includes(value as RuleSignal)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${RULE_SIGNALS.join(', ')}`);
  return value as RuleSignal;
}

function requireLanguage(value: unknown): Language {
  if (!LANGUAGES.includes(value as Language)) throw new Error(`${CONFIG_FILE}: "language" must be one of: ${LANGUAGES.join(', ')}`);
  return value as Language;
}

// `source` first: a rule without it is the one thing an older-looking file could carry, and the message says what to add. A stage rule
// (#475) only caps that stage's workers: the signal stops every start, so it never goes with a stage. The name is checked against
// comb.stages in parseConfig, where both are known.
function parseUsageRule(raw: unknown, field: string): UsageRule {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const source = requireSource(raw.source, `${field}.source`);
  const percent = requireInt(raw.percent, `${field}.percent`);
  if (percent > PERCENT_MAX) throw new Error(`${CONFIG_FILE}: "${field}.percent" must be an integer from 0 to ${PERCENT_MAX}`);
  const maxWorkers = raw.maxWorkers === undefined ? undefined : requireInt(raw.maxWorkers, `${field}.maxWorkers`);
  const signal = raw.signal === undefined ? undefined : requireSignal(raw.signal, `${field}.signal`);
  const stage = raw.stage === undefined ? undefined : requireString(raw.stage, `${field}.stage`);
  if (maxWorkers === undefined && signal === undefined) throw new Error(`${CONFIG_FILE}: "${field}" must set "maxWorkers" or "signal"`);
  if (stage !== undefined && signal !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.signal" cannot be combined with "stage": a stage rule only caps its workers`);
  return { source, percent, ...(maxWorkers === undefined ? {} : { maxWorkers }), ...(signal === undefined ? {} : { signal }), ...(stage === undefined ? {} : { stage }) };
}

function parseUsageRules(raw: unknown): UsageRule[] {
  if (!Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: "usageRules" must be an array`);
  return raw.map((rule, i) => parseUsageRule(rule, `usageRules[${i}]`));
}

// A stage rule names a stage of the Comb (#475): a typo would silently cap nothing.
function requireRuleStages(rules: UsageRule[], stages: Stage[]): UsageRule[] {
  const i = rules.findIndex((rule) => rule.stage !== undefined && !stages.some((s) => s.name === rule.stage));
  if (i !== -1) throw new Error(`${CONFIG_FILE}: "usageRules[${i}].stage" must name a stage`);
  return rules;
}

const optionalString = (value: unknown, field: string): { [k: string]: string } | Record<string, never> =>
  value === undefined ? {} : { [field.split('.').pop() as string]: requireString(value, field) };

const stringList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: "${field}" must be an array of strings`);
  return value as string[];
};

/** A Comb source as a stage's maps see it (#180, #286): its name keys the maps, its type says which actions it takes. */
type SourceRef = Pick<SourceConfig, 'name' | 'type'>;

const SOURCE_ACTION_TYPES: readonly SourceAction['type'][] = ['move', 'archive', 'remove', 'close', 'delete'];
const ACTION_SHAPE = '{ "type": "move", "column": "<source column>" } or { "type": "archive" | "remove" | "close" | "delete" }';

// An onStart / onFinish entry (#286): an object naming its action, a move naming its source column too, and only an action the source's type
// supports (SOURCE_ACTIONS). A plain string is the shape from before #286: no migration, the message shows the new one.
function requireSourceAction(raw: unknown, field: string, source: SourceRef): SourceAction {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object: ${ACTION_SHAPE} (#286)`);
  const type = raw.type as SourceAction['type'];
  if (!SOURCE_ACTION_TYPES.includes(type)) throw new Error(`${CONFIG_FILE}: "${field}.type" must be one of: ${SOURCE_ACTION_TYPES.join(', ')}`);
  const supported = SOURCE_ACTIONS[source.type];
  if (!supported.includes(type)) throw new Error(`${CONFIG_FILE}: "${field}.type" "${type}" is not supported by source ${source.name} (${source.type}): ${supported.join(', ')}`);
  return type === 'move' ? { type, column: requireString(raw.column, `${field}.column`) } : { type };
}

// #515: onStart / onFinish hold a list per source, run in order. One of each type; a leaving action takes the task off its source, so it is
// last, and never on start, where the worker still runs on the task.
function actionListProblem(actions: SourceAction[], onStart: boolean): { index: number; reason: string } | undefined {
  for (const [i, a] of actions.entries()) {
    if (actions.findIndex((b) => b.type === a.type) !== i) return { index: i, reason: `"${a.type}" is already in the list` };
    if (isLeaving(a) && onStart) return { index: i, reason: `"${a.type}" cannot run on start: it would take the task off its source while its worker runs` };
    if (isLeaving(a) && i !== actions.length - 1) return { index: i, reason: `"${a.type}" takes the task off its source, so it must be the last action` };
  }
  return undefined;
}

const requireActionList = (onStart: boolean) => (raw: unknown, field: string, source: SourceRef): SourceAction[] => {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty array of actions: [${ACTION_SHAPE}, …] (#515)`);
  const actions = raw.map((a, i) => requireSourceAction(a, `${field}[${i}]`, source));
  const problem = actionListProblem(actions, onStart);
  if (problem) throw new Error(`${CONFIG_FILE}: "${field}[${problem.index}].type" ${problem.reason}`);
  return actions;
};

// from: source name → its columns; onStart: source name → its action list (#180, #286, #515). A key naming no source is refused: a typo would never match.
function parseSourceMap<T>(raw: unknown, field: string, sources: SourceRef[], value: (v: unknown, f: string, source: SourceRef) => T): Record<string, T> {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object keyed by source name`);
  return Object.fromEntries(Object.entries(raw).map(([key, v]) => {
    const source = sources.find((b) => b.name === key);
    if (!source) throw new Error(`${CONFIG_FILE}: "${field}.${key}" names no source`);
    return [key, value(v, `${field}.${key}`, source)];
  }));
}

function parseStage(raw: unknown, field: string, sources: SourceRef[]): Stage {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const from = parseSourceMap(raw.from, `${field}.from`, sources, stringList);
  const onStart = raw.onStart === undefined ? {} : { onStart: parseSourceMap(raw.onStart, `${field}.onStart`, sources, requireActionList(true)) };
  const session = raw.session === undefined ? {} : { session: requireSessionPolicy(raw.session, `${field}.session`) };
  const maxWorkers = raw.maxWorkers === undefined ? {} : { maxWorkers: requireInt(raw.maxWorkers, `${field}.maxWorkers`) }; // #475: absent = no stage cap, 0 pauses it
  const action = raw.action === undefined ? {} : { action: requireAction(raw.action, `${field}.action`) };
  if (raw.action !== undefined && raw.prompt !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.action" cannot be combined with "prompt"`);
  if (raw.approval !== undefined && raw.action !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.approval" cannot be combined with "action"`); // #268
  if (raw.agent !== undefined && raw.action !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.agent" cannot be combined with "action"`); // #516
  if (raw.handoff !== undefined && raw.action !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.handoff" cannot be combined with "action"`); // #692
  if (raw.handoff !== undefined && raw.session === 'continue') throw new Error(`${CONFIG_FILE}: "${field}.handoff" cannot be combined with "session": "continue"`); // #692: that session already holds the work
  if (raw.handoff !== undefined && raw.prompt === undefined) throw new Error(`${CONFIG_FILE}: "${field}.handoff" cannot be used without "prompt"`); // #692: a gate never spawns, so no session reads the handoff
  const agent = raw.agent === undefined ? {} : { agent: requireAgent(raw.agent, `${field}.agent`) }; // absent = the default agent
  const after = raw.after === undefined ? {} : { after: requireDuration(raw.after, `${field}.after`) };
  const commands = parseStageCommands(raw, field); // #755: after the action and the combinations every action refuses
  const ci = parseStageCi(raw, field); // #834: after the commands keys, so a commands key next to waitForCi names its own action
  const verdicts = parseVerdicts(raw, field); // #134: after the action keys, so an action stage's own refusal names its action first
  return {
    name: requireString(raw.name, `${field}.name`), from,
    ...optionalString(raw.prompt, `${field}.prompt`), ...session, ...maxWorkers, ...optionalString(raw.model, `${field}.model`), ...agent,
    ...onStart, ...action, ...commands, ...ci, ...verdicts, ...after, ...(raw.approval !== undefined && requireBoolean(raw.approval, `${field}.approval`) ? { approval: true as const } : {}),
    ...(raw.handoff !== undefined && requireBoolean(raw.handoff, `${field}.handoff`) ? { handoff: true as const } : {}),
  };
}

function requireSessionPolicy(value: unknown, field: string): SessionPolicy {
  if (!SESSION_POLICIES.includes(value as SessionPolicy)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${SESSION_POLICIES.join(', ')}`);
  return value as SessionPolicy;
}

// #573, #755, #834: the stage actions; a file still saying cleanup is refused with the new names, no legacy path
const STAGE_ACTIONS: readonly StageAction[] = ['deleteActivity', 'commands', 'waitForCi'];

function requireAction(value: unknown, field: string): StageAction {
  if (!STAGE_ACTIONS.includes(value as StageAction)) throw new Error(`${CONFIG_FILE}: "${field}" must be "deleteActivity", "commands" or "waitForCi"`);
  return value as StageAction;
}

function requireDuration(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DURATION.test(value)) throw new Error(`${CONFIG_FILE}: "${field}" must be a duration like "30m", "12h" or "5d"`);
  return value;
}

// Required, non-empty, unique names. Every source needs at least one entry point: a source nothing can enter from is a config mistake, not a
// quiet Hive. Without sources no stage names one (parseSourceMap refuses the key): tasks enter by hand (#132).
function parseStages(raw: unknown, sources: SourceRef[]): Stage[] {
  if (raw === undefined) throw new Error(`${CONFIG_FILE}: "comb.stages" is required`);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${CONFIG_FILE}: "comb.stages" must be a non-empty array`);
  const stages = raw.map((stage, i) => parseStage(stage, `comb.stages[${i}]`, sources));
  stages.forEach((stage, i) => {
    if (stages.findIndex((s) => s.name === stage.name) !== i) throw new Error(`${CONFIG_FILE}: "comb.stages[${i}].name" must be unique`);
  });
  const end = stages.findIndex((s) => s.name === END); // #134: a transition's "end" must never name a stage
  if (end !== -1) throw new Error(`${CONFIG_FILE}: "comb.stages[${end}].name" cannot be "end": it names the end of the flow`);
  const silent = sources.find((b) => !stages.some((s) => (onSource(s.from, b.name)?.length ?? 0) > 0))?.name;
  if (silent !== undefined) throw new Error(`${CONFIG_FILE}: "comb.stages" must have at least one stage with "from.${silent}"`);
  return stages;
}

function requirePrefix(value: unknown, field = 'comb.prefix'): string {
  if (typeof value !== 'string' || !COMB_PREFIX.test(value)) {
    throw new Error(`${CONFIG_FILE}: "${field}" must be a letter followed by up to 9 letters or digits`);
  }
  return value;
}

// What a workspace's and a source's name accept (#179, #180): WORKSPACE_NAME.
function requireName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !WORKSPACE_NAME.test(value)) {
    throw new Error(`${CONFIG_FILE}: "${field}" must be a letter or digit followed by up to 39 letters, digits, ".", "_" or "-"`);
  }
  return value;
}

function parseWorkspace(raw: unknown, field: string): Workspace {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const name = requireName(raw.name, `${field}.name`);
  if (typeof raw.path !== 'string' || !isAbsolute(raw.path)) throw new Error(`${CONFIG_FILE}: "${field}.path" must be an absolute path`);
  if (raw.format !== undefined) throw new Error(`${CONFIG_FILE}: "${field}.format" moved to "editor" (#780): one config for every workspace`);
  const baseBranch = raw.baseBranch === undefined || raw.baseBranch === '' ? {} : { baseBranch: requireBranch(raw.baseBranch, `${field}.baseBranch`) }; // #854: '' from the form drops it
  return { name, path: raw.path, env: parseEnv(raw.env, `${field}.env`), fork: parseFork(raw.fork, `${field}.fork`), ...baseBranch, ...parseWorkspaceSetup(raw, field), ...workspaceConventions(raw.conventions, name) }; // env required (#348), fork required (#854); commands live in comb.commands (#511)
}

// A workspace's worktree scripts, the setup (#299) and the teardown (#654): each text is kept as it is (POST /settings parses it, so a bad line
// never stops a boot) and each timeout per RUN step is checked here (#511: a timeout text). A timeout without its text is accepted and unused.
// Absent stays absent: no key is ever written as undefined.
function parseWorkspaceSetup(raw: Record<string, unknown>, field: string): Pick<Workspace, 'setup' | 'setupTimeout' | 'teardown' | 'teardownTimeout'> {
  const text = (key: 'setup' | 'teardown'): string | undefined => {
    const value = raw[key];
    if (value !== undefined && typeof value !== 'string') throw new Error(`${CONFIG_FILE}: "${field}.${key}" must be a string`);
    return value;
  };
  const timeout = (key: 'setupTimeout' | 'teardownTimeout'): string | undefined =>
    (raw[key] === undefined ? undefined : parseTimeout(raw[key], `${field}.${key}`));
  const [setup, setupTimeout, teardown, teardownTimeout] = [text('setup'), timeout('setupTimeout'), text('teardown'), timeout('teardownTimeout')];
  return {
    ...(setup === undefined ? {} : { setup }), ...(setupTimeout === undefined ? {} : { setupTimeout }),
    ...(teardown === undefined ? {} : { teardown }), ...(teardownTimeout === undefined ? {} : { teardownTimeout }),
  };
}

// #692: absent and {} both mean none set in the Hive, so the file never keeps an empty object; a problem names the workspace and the key.
function workspaceConventions(raw: unknown, workspace: string): Pick<Workspace, 'conventions'> {
  const conventions = parseConventions(raw);
  if (typeof conventions === 'string') throw new Error(`${CONFIG_FILE}: workspace ${workspace}: ${conventions}`);
  return Object.keys(conventions).length === 0 ? {} : { conventions };
}

// One or more (#179), names and paths unique: a task, the source's default and a worktree route name a workspace, and two entries on one repo
// would share one .hive/. POST /settings checks each path is a repo's top level (#202).
function parseWorkspaces(raw: unknown): Workspace[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${CONFIG_FILE}: "comb.workspaces" must be a non-empty array`);
  const workspaces = raw.map((workspace, i) => parseWorkspace(workspace, `comb.workspaces[${i}]`));
  workspaces.forEach(({ name, path }, i) => {
    if (workspaces.findIndex((p) => p.name === name) !== i) throw new Error(`${CONFIG_FILE}: "comb.workspaces[${i}].name" must be unique`);
    if (workspaces.findIndex((p) => p.path === path) !== i) throw new Error(`${CONFIG_FILE}: "comb.workspaces[${i}].path" must be unique`);
  });
  return workspaces;
}

// One comb.sources entry (#180): its key, how its ids show, then the source fields, whose workspace setting names the Comb's workspaces (#293).
function parseSourceEntry(raw: unknown, field: string, workspaces: Workspace[]): SourceConfig {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const name = requireName(raw.name, `${field}.name`);
  if (isReservedSource(name)) throw new Error(`${CONFIG_FILE}: "${field}.name" cannot be "${RESERVED_SOURCE}" or "${HIVE_SOURCE}"`);
  if (typeof raw.qualifyId !== 'boolean') throw new Error(`${CONFIG_FILE}: "${field}.qualifyId" must be a boolean`);
  const prefix = raw.prefix === undefined ? {} : { prefix: requirePrefix(raw.prefix, `${field}.prefix`) };
  return { ...parseSource(raw, field, workspaces.map((p) => p.name)), name, qualifyId: raw.qualifyId, ...prefix };
}

// Required, possibly empty (#180): [] is the Comb without a source (#132). Names unique: columns, item ids and the state key on them.
function parseSources(raw: unknown, workspaces: Workspace[]): SourceConfig[] {
  if (!Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: "comb.sources" must be an array`);
  const sources = raw.map((source, i) => parseSourceEntry(source, `comb.sources[${i}]`, workspaces));
  sources.forEach(({ name }, i) => {
    if (sources.findIndex((b) => b.name === name) !== i) throw new Error(`${CONFIG_FILE}: "comb.sources[${i}].name" must be unique`);
  });
  return sources;
}

// The Comb (#132): prefix, workspaces, the sources (whose defaults must be workspaces, #179, #180), then the stages, judged against the sources.
function parseComb(raw: unknown): CombConfig {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "comb" is required`);
  if (raw.board !== undefined) throw new Error(`${CONFIG_FILE}: "comb.board" moved to "comb.sources"`); // #180: no compat path
  if (raw.columns !== undefined) throw new Error(`${CONFIG_FILE}: "comb.columns" was renamed to "comb.stages" (#286)`); // no compat path either
  if (raw.projects !== undefined) throw new Error(`${CONFIG_FILE}: "comb.projects" was renamed to "comb.workspaces" (#571)`); // nor here
  if (raw.boards !== undefined) throw new Error(`${CONFIG_FILE}: "comb.boards" was renamed to "comb.sources" (#571)`);
  const prefix = requirePrefix(raw.prefix);
  const workspaces = parseWorkspaces(raw.workspaces);
  const sources = parseSources(raw.sources, workspaces);
  const commands = parseCommands(raw.commands, 'comb.commands', workspaces.map((p) => p.name)); // #511, #755: each command's lines name its workspaces
  const stages = parseStages(raw.stages, sources);
  // #134: a transition's sources are read as onStart is, with a leaving action allowed last
  const transitions = parseTransitions(raw.transitions, stages, (value, field) => parseSourceMap(value, field, sources, requireActionList(false)));
  return { prefix, workspaces, sources, stages, transitions, commands, ...parseCreateIn(raw, sources) };
}

// #846: worded for the file; the form shows the same rules through t()
const CREATE_IN_ERROR: Record<CreateInProblem, string> = {
  'settings.error.hiveSource.noSource': '"comb.hiveSource" can be false only with at least one source',
  'settings.error.createIn.hiveOff': '"comb.createIn" is "hive" but "comb.hiveSource" is false',
  'settings.error.createIn.unknown': '"comb.createIn" must be "hive" or a source\'s name',
  'settings.error.createIn.noRepository': '"comb.createIn" names a source without "repository"',
};

// Required, no default (#846): an old file gets both from config-migrate.ts. After the stages, so any other fault of the Comb is named first.
function parseCreateIn(raw: Record<string, unknown>, sources: SourceConfig[]): Pick<CombConfig, 'hiveSource' | 'createIn'> {
  const hiveSource = requireBoolean(raw.hiveSource, 'comb.hiveSource');
  const createIn = requireString(raw.createIn, 'comb.createIn');
  const problem = createInProblem({ hiveSource, createIn, sources });
  if (problem) throw new Error(`${CONFIG_FILE}: ${CREATE_IN_ERROR[problem]}`);
  return { hiveSource, createIn };
}

// Top-level keys the Comb took over (#132). No compat path: the message says where the key went.
const MOVED_INTO_COMB = ['board', 'columns'] as const;

// branchProblem answers in the form's keys; the config file is not translated, so each key gets the sentence that names the field.
const BRANCH_ERROR: Record<BranchProblem, string> = {
  'settings.error.branch.unique': 'must contain {id} or {slug}, or two tasks share a branch',
  'settings.error.branch.invalid': 'must render a valid git branch name',
};

// Absent or empty stays absent: hive.config.json keeps no key for "the default", exactly like language and the budget limits.
function parseBranch(raw: Record<string, unknown>): { branch?: string } {
  if (raw.branch === undefined || raw.branch === '') return {};
  const template = requireString(raw.branch, 'branch');
  const problem = branchProblem(template);
  if (problem) throw new Error(`${CONFIG_FILE}: "branch" ${BRANCH_ERROR[problem]}`);
  return { branch: template };
}

// Required, each switch too, no default (#236, #496, #573). transcripts without session is refused here, not only in the form: a transcript
// the task still lists is a session the popup could still offer. The worktree and the branch always go, so a switch for either is refused.
function parseDeleteActivity(raw: unknown): DeleteActivityScope {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "deleteActivity" must be an object with session, transcripts, nonAutoTasks`);
  if (raw.worktree !== undefined || raw.branch !== undefined) throw new Error(`${CONFIG_FILE}: deleteActivity always removes the worktree and the branch`);
  const scope: DeleteActivityScope = {
    session: requireBoolean(raw.session, 'deleteActivity.session'), transcripts: requireBoolean(raw.transcripts, 'deleteActivity.transcripts'),
    nonAutoTasks: requireBoolean(raw.nonAutoTasks, 'deleteActivity.nonAutoTasks'),
  };
  if (scope.transcripts && !scope.session) throw new Error(`${CONFIG_FILE}: "deleteActivity.transcripts" needs "deleteActivity.session"`);
  return scope;
}

// Required, no default: a whole number from `min` to `max`. The shutdown window (#233) and the approval window (#268) in minutes, the console's
// lines per channel (#353); hive.ts prefills a file without them.
function requireIntFrom(raw: unknown, field: string, min: number, max: number): number {
  if (Number.isInteger(raw) && (raw as number) >= min && (raw as number) <= max) return raw as number;
  throw new Error(`${CONFIG_FILE}: "${field}" must be an integer from ${min} to ${max}`);
}

// One message for missing and unknown (#516): Config.defaultAgent and a stage's own agent.
function requireAgent(value: unknown, field: string): AgentId {
  if (!AGENT_IDS.includes(value as AgentId)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${AGENT_IDS.join(', ')}`);
  return value as AgentId;
}

// Required, no default (#296): one message for missing and unknown.
function requireTheme(value: unknown): Theme {
  if (!THEMES.includes(value as Theme)) throw new Error(`${CONFIG_FILE}: "theme" must be one of: ${THEMES.join(', ')}`);
  return value as Theme;
}

// Required, no default (#754): one message per field, for missing and unknown alike, as requireTheme has. A file from before the key is
// migrated (config-migrate.ts), so only a hand edit or an API caller meets these.
function requireFileIcons(raw: unknown): FileIcons {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "fileIcons" must be an object with set, scope, muted`);
  if (!FILE_ICON_SETS.includes(raw.set as FileIconSet)) throw new Error(`${CONFIG_FILE}: "fileIcons.set" must be one of: ${FILE_ICON_SETS.join(', ')}`);
  if (!FILE_ICON_SCOPES.includes(raw.scope as FileIconScope)) throw new Error(`${CONFIG_FILE}: "fileIcons.scope" must be one of: ${FILE_ICON_SCOPES.join(', ')}`);
  return { set: raw.set as FileIconSet, scope: raw.scope as FileIconScope, muted: requireBoolean(raw.muted, 'fileIcons.muted') };
}

// Required, no default (#821): one message for a missing or non-object key, one per field. No migration: a file from before the key boots the
// settings form prefilled (hive.ts). rightTab is kept as written while right is off: its switch keeps the value while disabled.
function requireSidebarsPerView(raw: unknown): SidebarsPerView {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "sidebarsPerView" must be an object with left, right, rightTab`);
  return {
    left: requireBoolean(raw.left, 'sidebarsPerView.left'),
    right: requireBoolean(raw.right, 'sidebarsPerView.right'),
    rightTab: requireBoolean(raw.rightTab, 'sidebarsPerView.rightTab'),
  };
}

// Required, no default (#727): the parse is signals-config.ts'. No migration: a file from before the key boots the settings form prefilled (hive.ts)
function requireSignals(raw: unknown): SignalSettings {
  const signals = parseSignals(raw);
  if (typeof signals === 'string') throw new Error(`${CONFIG_FILE}: ${signals}`);
  return signals;
}

// Required, no default (#780): no migration, the one file is fixed by hand; scopes are checked against the Comb's workspaces
function requireEditor(raw: unknown, workspaces: readonly string[]): EditorConfig {
  const editor = parseEditorConfig(raw, workspaces);
  if (typeof editor === 'string') throw new Error(`${CONFIG_FILE}: ${editor}`);
  return editor;
}

// Required, no default (#513): one message for missing and unknown, as requireTheme has.
function requireOnClose(value: unknown): OnClose {
  if (!ON_CLOSE.includes(value as OnClose)) throw new Error(`${CONFIG_FILE}: "onClose" must be one of: ${ON_CLOSE.join(', ')}`);
  return value as OnClose;
}

// Required, no default (#199): one message for a missing or non-object key, one per field; an unknown field is dropped, as the other objects
// do. A file from before the key boots the settings form prefilled through VIEWER_DEFAULTS (hive.ts).
function requireNotifications(raw: unknown): NotificationSettings {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "notifications" must be an object with ${NOTIFICATION_KINDS.join(', ')}`);
  return {
    waiting: requireBoolean(raw.waiting, 'notifications.waiting'),
    approval: requireBoolean(raw.approval, 'notifications.approval'),
    pr: requireBoolean(raw.pr, 'notifications.pr'),
    failed: requireBoolean(raw.failed, 'notifications.failed'),
  };
}

function requireCloseTabAction(value: unknown, field: string): CloseTabAction {
  if (!CLOSE_TAB_ACTIONS.includes(value as CloseTabAction)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${CLOSE_TAB_ACTIONS.join(', ')}`);
  return value as CloseTabAction;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character in a font name is one of the things refused
const TERMINAL_FONT_UNSAFE = /["\\\x00-\x1f\x7f]/;

// Required, no default (#376): one family name, "" = the system monospace. The UI wraps it in double quotes itself (terminalFontStack), so a
// quote, a backslash or a control character would break out of them. Whether the font is installed is never checked: the stack falls back.
function requireTerminalFont(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`${CONFIG_FILE}: "terminalFont" must be a string ("" = the system monospace)`);
  const font = value.trim();
  if (TERMINAL_FONT_UNSAFE.test(font)) throw new Error(`${CONFIG_FILE}: "terminalFont" must be one font family name, without ", \\ or control characters`);
  return font;
}

// Required, no default (#404): the hosts whose terminal links open without asking. Each entry is trimmed and lowercased and a repeat dropped;
// one that is not a bare host (a scheme, a port, a path, a wildcard) is refused by name, since the match is on the link's host alone.
function requireTrustedDomains(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error(`${CONFIG_FILE}: "trustedDomains" must be an array of host names ([] = every link asks)`);
  const hosts = (value as string[]).map((v) => v.trim().toLowerCase());
  const bad = hosts.find((host) => !isTrustedHost(host));
  if (bad !== undefined) throw new Error(`${CONFIG_FILE}: "trustedDomains" holds "${bad}", which is not a host name (like github.com: no scheme, port, path or *)`);
  return [...new Set(hosts)];
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: root must be an object`);
  const moved = MOVED_INTO_COMB.find((key) => raw[key] !== undefined);
  if (moved) throw new Error(`${CONFIG_FILE}: "${moved}" moved to "comb.${moved}"`);
  // #573: a renamed key, not a missing one; single user, no legacy path: the one file is fixed by hand
  if (raw.cleanup !== undefined) throw new Error(`${CONFIG_FILE}: "cleanup" is now "deleteActivity"`);
  const comb = parseComb(raw.comb);
  // Only the GitHub adapter logs in: auth is required next to it, checked when written anywhere else, and absent stays absent.
  const withAuth = comb.sources.some((b) => b.type === 'github') || raw.auth !== undefined;

  return {
    comb,
    ...(withAuth ? { auth: parseAuth(raw.auth) } : {}),
    epics: optional(raw.epics, DEFAULT_CONFIG.epics, (v) => {
      if (!EPICS_MODES.includes(v as EpicsMode)) throw new Error(`${CONFIG_FILE}: "epics" must be one of: ${EPICS_MODES.join(', ')}`);
      return v as EpicsMode;
    }),
    logLevel: optional(raw.logLevel, DEFAULT_CONFIG.logLevel, (v) => {
      if (!LOG_LEVELS.includes(v as LogLevel)) throw new Error(`${CONFIG_FILE}: "logLevel" must be one of: ${LOG_LEVELS.join(', ')}`);
      return v as LogLevel;
    }),
    ...(raw.language === undefined ? {} : { language: requireLanguage(raw.language) }), // absent stays absent: the system decides
    ...parseBranch(raw),
    // '' is how a cleared form field says "automatic": the key is dropped, not refused. Resolved per repo at spawn time, so no default.
    ...(raw.baseBranch === undefined || raw.baseBranch === '' ? {} : { baseBranch: requireBranch(raw.baseBranch, 'baseBranch') }),
    claudeArgs: optional(raw.claudeArgs, DEFAULT_CONFIG.claudeArgs, (v) => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: "claudeArgs" must be an array of strings`);
      return v as string[];
    }),
    budget: optional(raw.budget, DEFAULT_CONFIG.budget, parseBudget),
    usageRules: requireRuleStages(optional(raw.usageRules, DEFAULT_CONFIG.usageRules, parseUsageRules), comb.stages),
    // Required, no default (#513, #236, #258, #233, #268, #296, #376, #404, #353, #449, #516, #614, #573, #696, #805, #821, #727, #199): last, so any other problem in a file is named first. A file from before the keys boots
    // the settings form prefilled (hive.ts), and one save writes them.
    onClose: requireOnClose(raw.onClose),
    notifications: requireNotifications(raw.notifications),
    deleteActivity: parseDeleteActivity(raw.deleteActivity),
    shutdownIdleMinutes: requireIntFrom(raw.shutdownIdleMinutes, 'shutdownIdleMinutes', 1, SHUTDOWN_IDLE_MAX),
    approvalMinutes: requireIntFrom(raw.approvalMinutes, 'approvalMinutes', 1, APPROVAL_HOLD_MAX_MIN),
    rateLimitWaitMinutes: requireIntFrom(raw.rateLimitWaitMinutes, 'rateLimitWaitMinutes', 1, RATE_LIMIT_WAIT_MAX), // #805
    showGithubQuota: requireBoolean(raw.showGithubQuota, 'showGithubQuota'),
    closeSessionTab: requireCloseTabAction(raw.closeSessionTab, 'closeSessionTab'),
    closeStageTab: requireCloseTabAction(raw.closeStageTab, 'closeStageTab'),
    closeSessionTabNotice: requireBoolean(raw.closeSessionTabNotice, 'closeSessionTabNotice'),
    closeStageTabNotice: requireBoolean(raw.closeStageTabNotice, 'closeStageTabNotice'),
    sleepNotice: requireBoolean(raw.sleepNotice, 'sleepNotice'), // #672
    sleepAutoNotice: requireBoolean(raw.sleepAutoNotice, 'sleepAutoNotice'),
    sleepIdleNotice: requireBoolean(raw.sleepIdleNotice, 'sleepIdleNotice'),
    sleepAllNotice: requireBoolean(raw.sleepAllNotice, 'sleepAllNotice'),
    closeTerminalTab: requireCloseTabAction(raw.closeTerminalTab, 'closeTerminalTab'), // #696
    closeTerminalTabNotice: requireBoolean(raw.closeTerminalTabNotice, 'closeTerminalTabNotice'),
    defaultAgent: requireAgent(raw.defaultAgent, 'defaultAgent'), // #516: a file from before the key is migrated to claude
    theme: requireTheme(raw.theme),
    terminalFont: requireTerminalFont(raw.terminalFont),
    trustedDomains: requireTrustedDomains(raw.trustedDomains),
    consoleLines: requireIntFrom(raw.consoleLines, 'consoleLines', CONSOLE_LINES_MIN, CONSOLE_LINES_MAX),
    shortcuts: parseShortcuts(raw.shortcuts, process.platform === 'darwin'), // the rules live in shortcuts.ts, shared with the settings form (#449); this platform's defaults (#585)
    editor: requireEditor(raw.editor, comb.workspaces.map((w) => w.name)), // #780
    fileIcons: requireFileIcons(raw.fileIcons), // #754: a file from before the key is migrated to FILE_ICONS_DEFAULTS
    sidebarsPerView: requireSidebarsPerView(raw.sidebarsPerView), // #821: a file from before the key boots the settings form prefilled (hive.ts)
    signals: requireSignals(raw.signals), // #727: a file from before the key boots the settings form prefilled (hive.ts)
  };
}

/** The parsed JSON of hive.config.json, undefined when the file is missing; unreadable or invalid JSON rejects naming the path. */
export async function readConfig(home: string): Promise<unknown | undefined> {
  const path = join(home, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path}: erro de leitura (${(err as Error).message})`);
  }
  try {
    return migrateConfig(JSON.parse(text)); // files from before #511 / #513 / #515 / #516 / #754 are read in today's shape; the next save writes it
  } catch (err) {
    throw new Error(`${path}: JSON inválido (${(err as Error).message})`);
  }
}

export async function loadConfigIfPresent(home: string): Promise<Config | undefined> {
  const raw = await readConfig(home);
  return raw === undefined ? undefined : parseConfig(raw);
}

export async function loadConfig(home: string): Promise<Config> {
  const config = await loadConfigIfPresent(home);
  if (!config) throw new Error(`${CONFIG_FILE} não encontrado em ${home}`);
  return config;
}

/** A file from before the Comb (#132): no `comb`, or a top-level `board` / `columns` left over; or from before #180: a `comb.board`. Boot
 * opens the settings form empty with the parse error instead of dying; nothing is proposed (single user: the settings are entered once more). */
export const predatesComb = (raw: unknown): boolean =>
  isRecord(raw) && (raw.comb === undefined || MOVED_INTO_COMB.some((key) => raw[key] !== undefined) || (isRecord(raw.comb) && raw.comb.board !== undefined));

/** The Comb's workspace called `name` (#179); undefined for an unknown name or none. */
export const workspaceByName = ({ comb }: Pick<Config, 'comb'>, name: string | undefined): Workspace | undefined =>
  name === undefined ? undefined : comb.workspaces.find((p) => p.name === name);

/** A file from before #179: its first workspace carries no name. Boot opens the settings form with the parse error and this path proposed. */
export function unnamedWorkspacePath(raw: unknown): string | undefined {
  const comb = isRecord(raw) ? raw.comb : undefined;
  const workspaces = isRecord(comb) ? comb.workspaces : undefined;
  const first: unknown = Array.isArray(workspaces) ? workspaces[0] : undefined;
  return isRecord(first) && first.name === undefined && typeof first.path === 'string' ? first.path : undefined;
}

/** What the reducer resolves a task's workspace against (#179): the Comb's workspace names and each source's default workspace (#180, #688); the names of the commands the task menu offers in each workspace (#300, #511, #755). */
export const workspaceScope = ({ comb }: Pick<Config, 'comb'>): WorkspaceNames & Pick<State, 'commands'> => ({
  workspaces: comb.workspaces.map((p) => p.name),
  sourceWorkspaces: Object.fromEntries(comb.sources.flatMap((b) => (b.taskProps.defaults.workspace === undefined ? [] : [[b.name, b.taskProps.defaults.workspace]]))),
  commands: Object.fromEntries(comb.workspaces.map((p) => [p.name, commandsIn(comb.commands, p.name).map((c) => c.name)])),
});

/** The task's workspace in `config` (#179): resolveWorkspace against the Comb's names and the sources' defaults. */
export function taskWorkspace(config: Pick<Config, 'comb'>, task: Pick<Task, 'workspace' | 'item'>): Workspace | undefined {
  const { workspaces, sourceWorkspaces } = workspaceScope(config);
  return workspaceByName(config, resolveWorkspace(task, workspaces, sourceWorkspaces));
}

export const NO_WORKSPACE_MESSAGE = 'choose a workspace';

/** Why a task has no workspace (#179): the name it holds is gone from the Comb, or no rule answers one. */
export const noWorkspaceReason = (task: Pick<Task, 'workspace'>): string => (task.workspace === undefined ? NO_WORKSPACE_MESSAGE : `workspace ${task.workspace} is gone`);

/** taskWorkspace, or a throw with noWorkspaceReason: what the effects run git in. */
export function requireWorkspace(config: Pick<Config, 'comb'>, task: Pick<Task, 'workspace' | 'item'>): Workspace {
  const workspace = taskWorkspace(config, task);
  if (!workspace) throw new Error(noWorkspaceReason(task));
  return workspace;
}
