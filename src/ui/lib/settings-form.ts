// The settings form's state and its pure edges: SettingsInfo → draft, draft → validation, draft → SettingsBody.
// Strings as typed: only the shown Settings section is mounted (#510), so native validation cannot reach another section's fields.
import { isRuleComplete } from '../../task-filter.js';
import { createInProblem } from '../../create-in.js';
import { branchProblem, COMB_PREFIX, HIVE_SOURCE, DEFAULT_PREFIX, DURATION, WORKSPACE_NAME, workspaceNameFor, isReservedSource } from '../../tasks.js';
import { shortcutDef } from '../../shortcut-registry.js';
import { collisions } from '../../shortcuts.js';
import { type AgentId, APPROVAL_HOLD_MAX_MIN, APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, CLOSE_TAB_DEFAULTS, CONSOLE_LINES_DEFAULT, CONSOLE_LINES_MAX, CONSOLE_LINES_MIN, DEFAULT_AGENT, FILE_ICONS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, RATE_LIMIT_WAIT_MAX, SHUTDOWN_IDLE_DEFAULT, SHUTDOWN_IDLE_MAX, SIDEBARS_PER_VIEW_DEFAULTS, SIGNALS_DEFAULTS, SLEEP_NOTICE_DEFAULTS, VIEWER_DEFAULTS, type SourceConfig, type DeleteActivityScope, type CloseTabAction, type EpicFollows, type EpicsMode, NEW_SOURCE_EPICS, type FileIcons, type FilterRule, type GithubAuth, type Language, type NotificationSettings, type OnClose, type Workspace, type WorkspaceFork, type SettingsBody, type SettingsInfo, type OperationId, type Shortcuts, type SidebarsPerView, type SignalSettings, type Theme } from '../../types.js';
import { timeoutMs } from '../../timeout.js';
import { isTrustedHost } from '../../trusted-hosts.js';
import { t } from '../i18n.js';
import { type EditorDraft, editorDraft, editorFrom, editorProblem } from './settings-format.js';
import { type ConventionRowDraft, conventionRows, conventionsFrom, conventionsProblem } from './settings-conventions.js';
import { switchAtId, switchAtName } from './settings-epics.js';
import type { SettingsSection } from './settings-sections.js';
import { isMac } from './shortcut-bindings.js';
import { type SourceTaskPropsDraft, emptyTaskProps, sourceTaskPropsProblem, taskPropsDraft, taskPropsFrom } from './setup-source-task-props.js';
import { type CommandDraft, commandDraft, commandFrom, commandsProblem, type EnvRowDraft, envFrom, envRows } from './settings-commands.js';
import { type RuleDraft, ruleDrafts, rulesFrom, rulesProblem } from './settings-rules.js';
import { limitFrom, numberField, optional, type StageDraft, stageDraft, stageFrom } from './settings-stages.js';
import { type TransitionDraft, transitionDraft, transitionFrom, transitionsProblem } from './settings-transitions.js';

export { emptyStage, type StageDraft } from './settings-stages.js';
export type { TransitionDraft } from './settings-transitions.js';

// Every row's id is a React key, generated once when the draft row is created and never sent to the server (toSettingsBody never spreads the
// draft, only picks named fields), so move/remove never leaves a surviving row showing another row's stale text. Stages: settings-stages.ts (#515).
// A workspace row of Settings › workspaces (#179, #511); id is its React key and what a command's workspaces hold, never sent. Its env
// (#348) is edited in its card; setup and setupTimeout are its worktree setup (#299), teardown and teardownTimeout its worktree teardown (#654), the same way: as typed, an empty field sends no key. Its conventions (#692) are rows, one per key set. fork (#854) is the config's value as it is, edited by the repository section; baseBranch the workspace's own base, '' = the general one.
export interface WorkspaceDraft { id: string; name: string; path: string; env: EnvRowDraft[]; setup: string; setupTimeout: string; teardown: string; teardownTimeout: string; conventions: ConventionRowDraft[]; fork: WorkspaceFork | false | null; baseBranch: string }
/** A row of Settings › flow's sources list (#180); id is its React key and the key the stage drafts use, never sent. */
export interface SourceDraft {
  id: string; name: string; qualifyId: boolean; prefix: string; type: SourceConfig['type'];
  savedName: string; // the name the row was loaded with, '' on a new row (#278): what toSettingsBody reads a rename from; never shown
  owner: string; number: string;
  repository: string; // #846: owner/name, '' = none: the source is no destination
  filter: FilterRule[]; // #245: the rules as edited; one may have no values yet, which validateSettings refuses before a save
  taskProps: SourceTaskPropsDraft; // #688: the defaults and the rules as edited
  epics: EpicsMode; epicFollows: EpicFollows; // #30
  switchAt: string; // #30: a stage draft's id, '' = the default (switchAtStage); sent by name
}
export interface SettingsDraft {
  hiveSource: boolean; createIn: string; // #846: createIn is HIVE_SOURCE or a source row's id, as a stage's from is keyed, so a rename carries it
  prefix: string; workspaces: WorkspaceDraft[]; sources: SourceDraft[]; auth: GithubAuth;
  editor: EditorDraft; // #780: the one editor config, by language
  commands: CommandDraft[]; // the Comb's run commands (#511), edited on workspaces
  stages: StageDraft[]; transitions: TransitionDraft[]; // #134: by stage draft id
  language: Language; branch: string; baseBranch: string;
  budgetHour: string; budgetDay: string; rules: RuleDraft[]; onClose: OnClose; notifications: NotificationSettings; /* #199: one switch per kind, edited on app beside onClose */ showGithubQuota: boolean; deleteActivity: DeleteActivityScope;
  closeSessionTab: CloseTabAction; closeStageTab: CloseTabAction; closeTerminalTab: CloseTabAction; closeSessionTabNotice: boolean; closeStageTabNotice: boolean; closeTerminalTabNotice: boolean; // #614, #696: what closing a tab does, and whether it warns
  sleepNotice: boolean; sleepAutoNotice: boolean; sleepIdleNotice: boolean; sleepAllNotice: boolean; // #672: one notice per cause of a sleep
  shutdownIdleMinutes: string;
  approvalMinutes: string;
  rateLimitWaitMinutes: string; // #805
  defaultAgent: AgentId; // #516
  theme: Theme;
  fileIcons: FileIcons; // #754: the files tree's icons, edited on app › appearance
  sidebarsPerView: SidebarsPerView; // #821: which sidebar state each view keeps, edited on app
  signals: SignalSettings; // #727: the signal table, edited in rules
  terminalFont: string; // the font field as typed (#376); "" = the system monospace
  trustedDomains: string[]; // the chips (#404, #513), normalized as added
  consoleLines: string; // the Limits tab's field as typed (#353)
  shortcuts: Shortcuts; // only the user's changes, as the config holds them (#449): the atalhos tab edits the map itself
}
export interface SettingsProblem { section: SettingsSection; message: string }

const DEFAULT_OWNER = '@me';
export const emptyWorkspace = (): WorkspaceDraft => ({ id: crypto.randomUUID(), name: '', path: '', env: [], setup: '', setupTimeout: '', teardown: '', teardownTimeout: '', conventions: [], fork: null, baseBranch: '' });
const workspaceDraft = (p: Workspace): WorkspaceDraft => ({
  ...emptyWorkspace(), name: p.name, path: p.path, env: envRows(p.env),
  setup: p.setup ?? '', setupTimeout: p.setupTimeout ?? '', teardown: p.teardown ?? '', teardownTimeout: p.teardownTimeout ?? '',
  conventions: conventionRows(p.conventions), fork: p.fork, baseBranch: p.baseBranch ?? '',
});
// A first setup's one row: the folder the Hive started in, named after it (#202, #179), else empty.
const proposedRow = (path?: string): WorkspaceDraft => ({ ...emptyWorkspace(), ...(path === undefined ? {} : { name: workspaceNameFor(path), path }) });

const isNonNegativeInt = (text: string): boolean => /^\d+$/.test(text.trim());
const isEmptyOrNonNegativeInt = (text: string): boolean => text.trim() === '' || isNonNegativeInt(text);
const isEmptyOrDuration = (text: string): boolean => text.trim() === '' || DURATION.test(text.trim());

/** The chips with `text` added (#513): trimmed and lowercased like the parser, a repeat left out; undefined when it is not a bare host. */
export function withHost(hosts: readonly string[], text: string): string[] | undefined {
  const host = text.trim().toLowerCase();
  if (!isTrustedHost(host)) return undefined;
  return hosts.includes(host) ? [...hosts] : [...hosts, host];
}

// A new row's default workspace is `workspace` (#293, #688): the Comb's first, which is what a source with one workspace meant before; auto on;
// a new source's epics keys, switchAt on the default (#30).
export const emptySource = (workspace = ''): SourceDraft => ({
  id: crypto.randomUUID(), name: '', savedName: '', qualifyId: false, prefix: '', type: 'github', owner: DEFAULT_OWNER, number: '', repository: '',
  filter: [], taskProps: emptyTaskProps(workspace), ...NEW_SOURCE_EPICS, switchAt: '',
});
// switchAt is set by draftFrom once the stages are drafted (#30): their ids come from the rows
const sourceDraft = (b: SourceConfig): SourceDraft => ({
  ...emptySource(), name: b.name, savedName: b.name, qualifyId: b.qualifyId, prefix: b.prefix ?? '', type: b.type, taskProps: taskPropsDraft(b.taskProps),
  owner: b.owner, number: String(b.number), repository: b.repository ?? '', filter: b.filter, epics: b.epics, epicFollows: b.epicFollows,
});

// #846: the saved name as its row's id; hive, or a name no row has, stays as written for createInDraftProblem to name
const createInRow = (createIn: string | undefined, rows: SourceDraft[]): string =>
  (createIn === undefined ? HIVE_SOURCE : (rows.find((r) => r.savedName === createIn)?.id ?? createIn));
const createInName = (draft: Pick<SettingsDraft, 'createIn' | 'sources'>): string =>
  (draft.createIn === HIVE_SOURCE ? HIVE_SOURCE : (draft.sources.find((r) => r.id === draft.createIn)?.name.trim() ?? draft.createIn));

/** Today's defaults (@me, a new source's epics keys, the effective language) under whatever the saved config has. */
export function draftFrom(info?: SettingsInfo): SettingsDraft {
  const config = info?.config;
  const workspaces = config ? config.comb.workspaces.map(workspaceDraft) : [proposedRow(info?.proposedWorkspace)]; // the saved workspaces, else the proposal (#179)
  const rows = config ? config.comb.sources.map(sourceDraft) : [emptySource(workspaces[0].name)]; // a first setup: one GitHub row (#180), its default workspace the proposal (#293, #688)
  const stages = (config?.comb.stages ?? []).map((c) => stageDraft(c, rows));
  // #30: switchAt as its stage draft's id; the ids are kept, so the stages' from still finds each row
  const sources = config ? rows.map((row, i) => ({ ...row, switchAt: switchAtId(config.comb.sources[i].switchAt, stages) })) : rows;
  return {
    hiveSource: config?.comb.hiveSource ?? true, // the new form's default; the parser still requires the key (#846)
    createIn: createInRow(config?.comb.createIn, sources),
    prefix: config?.comb.prefix ?? DEFAULT_PREFIX,
    workspaces,
    editor: editorDraft(config?.editor),
    commands: (config?.comb.commands ?? []).map((c) => commandDraft(c, workspaces)), // #511: workspaces as row ids
    sources,
    auth: config?.auth?.github ?? 'cli', // a form opened with no config starts on cli, the transport that needs nothing
    stages,
    transitions: (config?.comb.transitions ?? []).map((t) => transitionDraft(t, stages, sources)),
    language: info?.language ?? 'en',
    branch: config?.branch ?? '', // empty = the default template; the hint under the field says which
    baseBranch: config?.baseBranch ?? '', // empty field = automatic
    budgetHour: numberField(config?.budget.maxTokensPerHour),
    budgetDay: numberField(config?.budget.maxTokensPerDay),
    rules: (config?.usageRules ?? []).flatMap(ruleDrafts),
    onClose: config?.onClose ?? VIEWER_DEFAULTS.onClose, // a new form keeps the menu bar (#513); the parser still requires the key
    notifications: config?.notifications ?? VIEWER_DEFAULTS.notifications, // every kind on in a new form (#199); the parser still requires the key
    sidebarsPerView: config?.sidebarsPerView ?? SIDEBARS_PER_VIEW_DEFAULTS, // both sides shared and the tab kept in a new form (#821); the parser still requires the key
    signals: config?.signals ?? SIGNALS_DEFAULTS, // today's table in a new form (#727); the parser still requires the key
    deleteActivity: config?.deleteActivity ?? DELETE_ACTIVITY_DEFAULTS, // the form defaults on a new form (#236, #573); the parser still requires the key
    shutdownIdleMinutes: String(config?.shutdownIdleMinutes ?? SHUTDOWN_IDLE_DEFAULT), // 10 on a new form (#233); the parser still requires the key
    approvalMinutes: String(config?.approvalMinutes ?? APPROVAL_MINUTES_DEFAULT), // 10 on a new form (#268); the parser still requires the key
    rateLimitWaitMinutes: String(config?.rateLimitWaitMinutes ?? RATE_LIMIT_WAIT_DEFAULT), // 300 on a new form (#805); the parser still requires the key
    consoleLines: String(config?.consoleLines ?? CONSOLE_LINES_DEFAULT), // 5000 on a new form (#353); the parser still requires the key
    showGithubQuota: config?.showGithubQuota ?? false, // off on a new form; the parser still requires the key
    closeSessionTab: config?.closeSessionTab ?? CLOSE_TAB_DEFAULTS.closeSessionTab, // keep on a new form (#614); the parser still requires the key
    closeStageTab: config?.closeStageTab ?? CLOSE_TAB_DEFAULTS.closeStageTab, // #614: the parser still requires the key
    closeSessionTabNotice: config?.closeSessionTabNotice ?? CLOSE_TAB_DEFAULTS.closeSessionTabNotice, // on in a new form (#614)
    closeStageTabNotice: config?.closeStageTabNotice ?? CLOSE_TAB_DEFAULTS.closeStageTabNotice, // #614: the parser still requires the key
    closeTerminalTab: config?.closeTerminalTab ?? CLOSE_TAB_DEFAULTS.closeTerminalTab, // sleep on a new form (#696); the parser still requires the key
    closeTerminalTabNotice: config?.closeTerminalTabNotice ?? CLOSE_TAB_DEFAULTS.closeTerminalTabNotice, // #696
    sleepNotice: config?.sleepNotice ?? SLEEP_NOTICE_DEFAULTS.sleepNotice, // on in a new form (#672); the parser still requires the key
    sleepAutoNotice: config?.sleepAutoNotice ?? SLEEP_NOTICE_DEFAULTS.sleepAutoNotice,
    sleepIdleNotice: config?.sleepIdleNotice ?? SLEEP_NOTICE_DEFAULTS.sleepIdleNotice,
    sleepAllNotice: config?.sleepAllNotice ?? SLEEP_NOTICE_DEFAULTS.sleepAllNotice,
    defaultAgent: config?.defaultAgent ?? DEFAULT_AGENT, // #516: the parser still requires the key
    theme: config?.theme ?? 'system', // a new form follows macOS (#296); the parser still requires the key
    fileIcons: config?.fileIcons ?? FILE_ICONS_DEFAULTS, // Material on a new form (#754); the parser still requires the key
    terminalFont: config?.terminalFont ?? '', // a new form uses the system monospace (#376); the parser still requires the key
    trustedDomains: config?.trustedDomains ?? [], // a new form trusts nothing (#404); the parser still requires the key
    shortcuts: config?.shortcuts ?? {}, // a new form changes no shortcut (#449); the parser still requires the key
  };
}

function prefixProblem(draft: SettingsDraft): SettingsProblem | undefined {
  return COMB_PREFIX.test(draft.prefix.trim()) ? undefined : { section: 'flow', message: t('settings.error.prefix') };
}

// #245: a rule is saved whole or not at all (isRuleComplete, shared with a stage's view filter, #374).

function filterProblem(sources: SourceDraft[]): SettingsProblem | undefined {
  const problems = sources.flatMap((b) => {
    const bad = b.filter.findIndex((r) => !isRuleComplete(r));
    return bad === -1 ? [] : [{ section: 'flow' as const, message: t('settings.filter.error', { source: b.name.trim(), n: bad + 1 }) }];
  });
  return problems[0];
}

// Every row a valid name (not "local" or "hive"), unique, and a prefix like the Comb's when set; then a GitHub project picked (#180).
// The server checks the rest (the source itself, each source's from).
// The parser's four createIn rules (#846, createInProblem), named before the round trip
function createInDraftProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const sources = draft.sources.map((r) => ({ name: r.name.trim(), ...(r.repository === '' ? {} : { repository: r.repository }) }));
  const problem = createInProblem({ hiveSource: draft.hiveSource, createIn: createInName(draft), sources });
  return problem === undefined ? undefined : { section: 'flow', message: t(problem) };
}

function sourcesProblem(sources: SourceDraft[]): SettingsProblem | undefined {
  const badName = (b: SourceDraft): boolean => !WORKSPACE_NAME.test(b.name.trim()) || isReservedSource(b.name.trim());
  const bad = sources.findIndex((b) => badName(b) || (b.prefix.trim() !== '' && !COMB_PREFIX.test(b.prefix.trim())));
  if (bad !== -1) return { section: 'flow', message: t('settings.error.sourceName', { n: bad + 1 }) };
  const names = sources.map((b) => b.name.trim());
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) return { section: 'flow', message: t('settings.error.sourceDuplicate', { name: twice }) };
  if (sources.some((b) => b.number === '')) return { section: 'flow', message: t('settings.error.project') };
  return filterProblem(sources);
}

// #134: an arrow whose ends, verdict or tries the parser refuses, named on the flow section before the round trip
function transitionsDraftProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const bad = transitionsProblem(draft.transitions, draft.stages);
  return bad === undefined ? undefined : { section: 'flow', message: t('settings.transitions.error', { n: bad + 1 }) };
}

// #834: a wait for CI needs a check under só estes, and its wait in the TIMEOUT grammar; an empty wait is no limit
const badWait = (c: StageDraft): boolean =>
  c.action === 'waitForCi' && ((c.ciChecks === 'list' && c.checks.length === 0) || (c.timeout.trim() !== '' && timeoutMs(c.timeout) === undefined));

function stagesProblem(stages: StageDraft[]): SettingsProblem | undefined {
  if (stages.length === 0) return { section: 'flow', message: t('settings.stages.none') };
  const bad = stages.findIndex((c) => c.name.trim() === '' || !isEmptyOrDuration(c.after) || !isEmptyOrNonNegativeInt(c.maxWorkers) || (c.action === 'commands' && c.commands.length === 0)); // #755: the parser refuses an empty list
  if (bad !== -1) return { section: 'flow', message: t('settings.stages.error', { n: bad + 1 }) };
  const wait = stages.findIndex(badWait);
  return wait === -1 ? undefined : { section: 'flow', message: t('settings.stages.error.ci', { n: wait + 1 }) };
}

function budgetProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const bad = [draft.budgetHour, draft.budgetDay].some((v) => !isEmptyOrNonNegativeInt(v));
  return bad ? { section: 'rules', message: t('settings.budgetHint') } : undefined;
}

// Every row a valid name and a folder, names unique (#179); the server checks each folder is a repo's top level and the paths are unique.
function workspacesProblem(workspaces: WorkspaceDraft[]): SettingsProblem | undefined {
  const bad = workspaces.findIndex((p) => !WORKSPACE_NAME.test(p.name.trim()) || p.path.trim() === '');
  if (bad !== -1) return { section: 'workspaces', message: t('settings.error.workspaces', { n: bad + 1 }) };
  const names = workspaces.map((p) => p.name.trim());
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) return { section: 'workspaces', message: t('settings.error.workspaceDuplicate', { name: twice }) };
  const badTimeout = (text: string): boolean => text.trim() !== '' && timeoutMs(text) === undefined;
  const slow = workspaces.find((p) => badTimeout(p.setupTimeout) || badTimeout(p.teardownTimeout)); // #511, #654
  return slow === undefined ? undefined : { section: 'workspaces', message: t('settings.error.setupTimeout', { workspace: slow.name.trim() }) };
}

// Each source's task properties against the workspace rows (#293, #688): after workspacesProblem, so the names it is judged against are valid ones.
function taskPropsProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const listed = draft.workspaces.map((p) => p.name.trim());
  const message = draft.sources.map((b) => sourceTaskPropsProblem(b.name.trim(), b.taskProps, listed)).find((m) => m !== undefined);
  return message === undefined ? undefined : { section: 'flow', message };
}

// The only problem the general tab can report besides the workspaces. Empty is not a problem: absent means DEFAULT_BRANCH_TEMPLATE.
function branchDraftProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const problem = branchProblem(draft.branch.trim());
  return problem === undefined ? undefined : { section: 'execution', message: t(problem) };
}

// Whole minutes from 1 to `max`, what the parser accepts: the shutdown window (#233), the approval window (#268) and the rate-limit wait (#805).
// Exported for the sessions table (#778): a field marks itself invalid with the same predicate the footer's message comes from.
export const isMinutes = (text: string, max: number): boolean => isNonNegativeInt(text) && Number(text.trim()) >= 1 && Number(text.trim()) <= max;

function minutesProblem(draft: SettingsDraft): SettingsProblem | undefined {
  if (!isMinutes(draft.shutdownIdleMinutes, SHUTDOWN_IDLE_MAX)) return { section: 'execution', message: t('settings.error.shutdownIdle') };
  if (!isMinutes(draft.approvalMinutes, APPROVAL_HOLD_MAX_MIN)) return { section: 'execution', message: t('settings.error.approvalMinutes') };
  return isMinutes(draft.rateLimitWaitMinutes, RATE_LIMIT_WAIT_MAX) ? undefined : { section: 'execution', message: t('settings.error.rateLimitWait') };
}

// Whole lines from CONSOLE_LINES_MIN to CONSOLE_LINES_MAX, what the parser accepts (#353).
function consoleLinesProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const lines = Number(draft.consoleLines.trim());
  const valid = isNonNegativeInt(draft.consoleLines) && lines >= CONSOLE_LINES_MIN && lines <= CONSOLE_LINES_MAX;
  return valid ? undefined : { section: 'app', message: t('settings.error.consoleLines') };
}

// Two keys that meet, one on a key the Edit and app menus keep, or one on a fixed key (#449, #585): the parser refuses each, so the form names
// them on their tab.
function shortcutsProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const [clash] = collisions(draft.shortcuts, isMac()); // this platform's defaults (#585)
  if (clash === undefined) return undefined;
  const [id, other] = clash;
  const name = (shortcut: OperationId): string => t(shortcutDef(shortcut).label);
  if (other === 'reserved') return { section: 'shortcuts', message: t('settings.error.shortcutReserved', { name: name(id) }) };
  if (typeof other === 'object') return { section: 'shortcuts', message: t('settings.error.shortcutFixed', { name: name(id), fixed: t(other.label) }) };
  return { section: 'shortcuts', message: t('settings.error.shortcutCollision', { a: name(id), b: name(other) }) };
}

// A source no stage enters from (#514): the parser refuses it too (parseStages), this names it before the round trip. Last in the chain:
// a source just added from the dialog meets it only once everything else is right.
function silentSourceProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const silent = draft.sources.find((b) => !draft.stages.some((s) => (s.from[b.id]?.length ?? 0) > 0));
  return silent === undefined ? undefined : { section: 'flow', message: t('settings.error.sourceSilent', { source: silent.name.trim() }) };
}

/** The first problem in today's order (prefix, sources, create in, stages, rules, budget, console lines, workspaces, conventions, editor, task properties, branch, shutdown
 * window, approval window, run commands, shortcuts, silent sources) with the section to reveal (#510); undefined when the server may judge the
 * rest. A bad trusted-domain host is refused inline by its own chip field (#513), so it is not in this chain. */
export function validateSettings(draft: SettingsDraft): SettingsProblem | undefined {
  return prefixProblem(draft) ?? sourcesProblem(draft.sources) ?? createInDraftProblem(draft) ?? stagesProblem(draft.stages) ?? transitionsDraftProblem(draft) ?? rulesProblem(draft.rules, draft.stages.map((s) => s.name.trim())) ?? budgetProblem(draft) ?? consoleLinesProblem(draft) ?? workspacesProblem(draft.workspaces) ?? conventionsProblem(draft.workspaces) ?? editorProblem(draft) ?? taskPropsProblem(draft) ?? branchDraftProblem(draft) ?? minutesProblem(draft) ?? commandsProblem(draft) ?? shortcutsProblem(draft) ?? silentSourceProblem(draft);
}

/** A row as a comb.sources entry (#180): its key first, then its type's fields, its task properties (#688) and its epics keys, switchAt by the
 * name it resolves to among `stages` (#30). */
export function sourceFrom(row: SourceDraft, stages: readonly StageDraft[]): SourceConfig {
  const key = { name: row.name.trim(), qualifyId: row.qualifyId, ...optional('prefix', row.prefix) };
  return {
    ...key, type: 'github', owner: row.owner.trim(), number: Number(row.number), ...optional('repository', row.repository), filter: row.filter, taskProps: taskPropsFrom(row.taskProps),
    epics: row.epics, epicFollows: row.epicFollows, switchAt: switchAtName(row.switchAt, stages),
  };
}

// Rows loaded under another name (#278): the server carries their tasks over. A new row (savedName '') renames nothing.
const renamesFrom = (rows: SourceDraft[]): Record<string, string> =>
  Object.fromEntries(rows.flatMap((r) => (r.savedName === '' || r.name.trim() === r.savedName ? [] : [[r.savedName, r.name.trim()]])));

// A row as a comb.workspaces entry: the setup untrimmed, so the line numbers POST /settings names are the textarea's (#299); the timeout trimmed,
// validateSettings checked its grammar (#511); the conventions only when one is set (#692).
const workspaceFrom = (p: WorkspaceDraft): Workspace => ({
  name: p.name.trim(), path: p.path.trim(), env: envFrom(p.env), // env always sent (#348)
  fork: p.fork, // #854: always sent, null included: the parser requires it
  ...(p.baseBranch.trim() === '' ? {} : { baseBranch: p.baseBranch.trim() }),
  ...(p.setup.trim() === '' ? {} : { setup: p.setup }),
  ...(p.setupTimeout.trim() === '' ? {} : { setupTimeout: p.setupTimeout.trim() }),
  ...(p.teardown.trim() === '' ? {} : { teardown: p.teardown }),
  ...(p.teardownTimeout.trim() === '' ? {} : { teardownTimeout: p.teardownTimeout.trim() }),
  ...conventionsFrom(p.conventions),
});

export function toSettingsBody(draft: SettingsDraft): SettingsBody {
  const hour = limitFrom(draft.budgetHour);
  const day = limitFrom(draft.budgetDay);
  return {
    hiveSource: draft.hiveSource, createIn: createInName(draft), // always sent (#846)
    prefix: draft.prefix.trim(),
    workspaces: draft.workspaces.map(workspaceFrom),
    commands: draft.commands.map((c) => commandFrom(c, draft.workspaces)), // always sent (#511), [] included
    sources: draft.sources.map((row) => sourceFrom(row, draft.stages)),
    renames: renamesFrom(draft.sources), // always sent (#278), {} included
    // only the GitHub adapter logs in: with no GitHub source no auth is sent, and a saved one stays as the server has it
    ...(draft.sources.some((b) => b.type === 'github') ? { auth: { github: draft.auth } } : {}),
    stages: draft.stages.map((c) => stageFrom(c, draft.sources)),
    transitions: draft.transitions.map((d) => transitionFrom(d, draft.stages, draft.sources)), // #134: always sent, [] included
    budget: { ...(hour ? { maxTokensPerHour: hour } : {}), ...(day ? { maxTokensPerDay: day } : {}) },
    usageRules: rulesFrom(draft.rules), language: draft.language, ...optional('branch', draft.branch),
    // always sent, '' included: optional() would omit the key and saveSettings would keep the old branch, so clearing the field could never work
    baseBranch: draft.baseBranch.trim(),
    onClose: draft.onClose, // always sent (#513)
    notifications: draft.notifications, // always sent (#199)
    deleteActivity: draft.deleteActivity, // always sent (#236, #573)
    shutdownIdleMinutes: Number(draft.shutdownIdleMinutes.trim()), // always sent (#233); validateSettings ran first
    approvalMinutes: Number(draft.approvalMinutes.trim()), // always sent (#268); validateSettings ran first
    rateLimitWaitMinutes: Number(draft.rateLimitWaitMinutes.trim()), // always sent (#805); validateSettings ran first
    showGithubQuota: draft.showGithubQuota, // always sent
    closeSessionTab: draft.closeSessionTab, // always sent (#614)
    closeStageTab: draft.closeStageTab, // always sent (#614)
    closeSessionTabNotice: draft.closeSessionTabNotice, // always sent (#614)
    closeStageTabNotice: draft.closeStageTabNotice, // always sent (#614)
    closeTerminalTab: draft.closeTerminalTab, // always sent (#696)
    closeTerminalTabNotice: draft.closeTerminalTabNotice, // always sent (#696)
    sleepNotice: draft.sleepNotice, // always sent (#672)
    sleepAutoNotice: draft.sleepAutoNotice,
    sleepIdleNotice: draft.sleepIdleNotice,
    sleepAllNotice: draft.sleepAllNotice,
    defaultAgent: draft.defaultAgent, // always sent (#516)
    theme: draft.theme, // always sent (#296)
    fileIcons: draft.fileIcons, // always sent (#754)
    sidebarsPerView: draft.sidebarsPerView, // always sent (#821)
    signals: draft.signals, // always sent (#727)
    editor: editorFrom(draft.editor), // always sent (#780)
    terminalFont: draft.terminalFont.trim(), // always sent (#376), '' included: optional() would drop it and the save would keep the old font
    trustedDomains: draft.trustedDomains, // always sent (#404), [] included: an emptied field un-trusts everything
    consoleLines: Number(draft.consoleLines.trim()), // always sent (#353); validateSettings ran first
    shortcuts: draft.shortcuts, // always sent (#449), {} included: Restaurar todos must reach the file
  };
}

/** GET /settings/source-columns for one row (#180); undefined while it is not chosen (no owner or no project). */
export function sourceColumnsUrl(draft: Pick<SettingsDraft, 'auth'>, row: SourceDraft): string | undefined {
  const owner = row.owner.trim();
  if (owner === '' || row.number === '') return undefined;
  return `/settings/source-columns?${new URLSearchParams({ type: 'github', owner, number: row.number, auth: draft.auth })}`;
}

/** GET /settings/projects for a row's owner and the transport; undefined without an owner. */
export function projectsUrl(auth: GithubAuth, row: Pick<SourceDraft, 'owner'>): string | undefined {
  const owner = row.owner.trim();
  return owner === '' ? undefined : `/settings/projects?${new URLSearchParams({ owner, auth })}`;
}

/** GET /settings/filter-options for a github row (#245); undefined for a row of another type or one not chosen yet. */
export function filterOptionsUrl(draft: Pick<SettingsDraft, 'auth'>, row: SourceDraft): string | undefined {
  const owner = row.owner.trim();
  if (row.type !== 'github' || owner === '' || row.number === '') return undefined;
  return `/settings/filter-options?${new URLSearchParams({ owner, number: row.number, auth: draft.auth })}`;
}
