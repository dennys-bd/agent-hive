import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { emptyCommand, emptyEnvRow, emptyImpl, type EnvRowDraft } from '../src/ui/lib/settings-commands.js';
import { sourceColumnsUrl, draftFrom, emptySource, emptyStage, emptyWorkspace, filterOptionsUrl, isMinutes, projectsUrl, type SourceDraft, type SettingsDraft, type StageDraft, toSettingsBody, validateSettings, withHost } from '../src/ui/lib/settings-form.js';
import { withMemoryCap } from '../src/ui/lib/memory-cap.js';
import { withEntry } from '../src/ui/lib/settings-stages.js';
import { emptyRule, type RuleDraft } from '../src/ui/lib/settings-rules.js';
import type { Stage, Transition, SourceConfig, SourceTaskProps, Config, FilterRule, Command, SettingsInfo } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, RATE_LIMIT_WAIT_MAX, DELETE_ACTIVITY_DEFAULTS, CONSOLE_LINES_DEFAULT, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { FIXED } from './fakes.js';

// #30: not a new source's keys, so draftFrom visibly reads them; switchAt on STAGES' second stage
const EPICS = { epics: 'hide', epicFollows: 'ahead', switchAt: 'dev' } as const;

// A saved run command (#300), two env entries so the draft's lines keep their order
const FRONT_LINE = 'pnpm run dev -- --port $PORT';
const FRONT: Command = { name: 'Run Frontend', impls: [{ workspace: 'hive', command: FRONT_LINE }], menu: true, env: { PORT: '5173', HOST: 'localhost' } };

const STAGES: Stage[] = [
  { name: 'spec', from: { work: ['Backlog'] }, prompt: '/hive-spec {url}', model: 'opus' },
  { name: 'dev', from: { work: ['Ready'] }, onStart: { work: [{ type: 'move', column: 'In progress' }] }, prompt: '/hive-build {url}', session: 'continue' },
  { name: 'done', from: { work: ['Done'] }, action: 'deleteActivity', after: '5d' },
];
// What each stage's end does to the source (#134): the arrows the form loads by stage id and sends back
const TRANSITIONS: Transition[] = [
  { from: 'spec', to: 'dev', when: 'done', sources: { work: [{ type: 'move', column: 'Ready' }] } },
  { from: 'dev', to: 'done', when: 'done', sources: { work: [{ type: 'move', column: 'In review' }] } },
  { from: 'done', to: 'end', when: 'done' },
];

const CONFIG: Config = {
  auth: { github: 'api' },
  comb: {
    prefix: 'HIVE',
    workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }],
    commands: [FRONT], hiveSource: true, createIn: 'hive',
    sources: [{ name: 'work', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: [], taskProps: FIXED, ...EPICS }],
    transitions: TRANSITIONS,
    stages: STAGES,
  },
  logLevel: 'info', language: 'pt', baseBranch: 'develop',
  agentArgs: { claude: [], codex: [] }, agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true }, budget: { maxTokensPerHour: 50_000 }, usageRules: [{ source: 'hour', percent: 80, signal: 'yellow' }, { source: 'session', percent: 90, maxWorkers: 1, signal: 'red' }],
  onClose: 'quit', // not the form default, so draftFrom visibly reads it (#513)
  notifications: { waiting: true, approval: false, pr: true, failed: false }, // not the form default, so draftFrom visibly reads it (#199)
  deleteActivity: { session: true, transcripts: true, nonAutoTasks: true }, // not the form defaults, so draftFrom visibly reads it (#236, #496)
  shutdownIdleMinutes: 45, // not the form default, so draftFrom visibly reads it (#233)
  approvalMinutes: 30, // not the form default, so draftFrom visibly reads it (#268)
  rateLimitWaitMinutes: 600, // not the form default, so draftFrom visibly reads it (#805)
  showGithubQuota: true, // not the form default, so draftFrom visibly reads it
  closeSessionTab: 'sleep', closeStageTab: 'sleep', // not the form defaults, so draftFrom visibly reads them (#614)
  closeSessionTabNotice: false, closeStageTabNotice: false, // not the form defaults, so draftFrom visibly reads them (#614)
  sleepNotice: false, sleepAutoNotice: false, sleepIdleNotice: false, sleepAllNotice: false, // not the form defaults, so draftFrom visibly reads them (#672)
  closeTerminalTab: 'keep', closeTerminalTabNotice: false, // not the form defaults, so draftFrom visibly reads them (#696)
  defaultAgent: 'claude', // the only agent (#516)
  theme: 'dark', // not the form default, so draftFrom visibly reads it (#296)
  terminalFont: 'MesloLGS NF', // not the form default, so draftFrom visibly reads it (#376)
  trustedDomains: ['github.com', 'docs.example.com'], // not the form default, so draftFrom visibly reads it (#404)
  shortcuts: { toggleRight: 'CmdOrCtrl+Shift+Y', clear: null }, // not the form default, so draftFrom visibly reads it (#449)
  consoleLines: 20000, // not the form default, so draftFrom visibly reads it (#353)
  fileIcons: { set: 'vscode', scope: 'folders', muted: true }, sidebarsPerView: { left: false, right: true, rightTab: false }, signals: { ...SIGNALS_DEFAULTS, onOpen: 'last' }, // not the form default, so draftFrom visibly reads it (#754, #727)
  editor: EDITOR_DEFAULTS,
  reviewer: REVIEWER_DEFAULTS, mcp: MCP_DEFAULTS,
};
const withSources = (sources: SourceConfig[]): Config => ({ ...CONFIG, comb: { ...CONFIG.comb, sources } });
const GH_ROW = { name: 'work', savedName: 'work', qualifyId: false, prefix: '', type: 'github', owner: 'acme', number: '6', repository: '', filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'hide', epicFollows: 'ahead', switchAt: '' };
const info = (config?: Config, configured = true): SettingsInfo => ({ configured, home: '/home', config, language: config?.language ?? 'en', agents: [{ agent: 'claude', available: true }] });
// id is generated per row (React key material, never sent to the server): every literal comparison strips it out.
// #877: a stage draft's judge row carries a React id of its own
const stageWithoutId = (d: StageDraft) => ({ ...withoutId(d), judge: withoutId(d.judge) });
const withoutId = <T extends { id: string }>(draft: T): Omit<T, 'id'> => {
  const { id: _id, ...rest } = draft;
  return rest;
};
const NO_SETUP = { setup: '', setupTimeout: '', teardown: '', teardownTimeout: '', fork: null, baseBranch: '', memoryCap: '4000', benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', nestedRepos: [], notNestedRepos: [] }; // a workspace row's worktree setup and teardown fields (#299, #654), empty

test('draftFrom fills every field as strings from a github config, and defaults an empty setup', () => {
  const github = draftFrom(info(CONFIG));
  assert.equal(github.defaultAgent, 'claude', 'the saved default agent (#516)');
  assert.deepEqual(github.fileIcons, { set: 'vscode', scope: 'folders', muted: true }, 'the saved icons (#754)');
  assert.deepEqual(github.sidebarsPerView, { left: false, right: true, rightTab: false }, 'the saved sides (#821)');
  assert.deepEqual(github.signals, CONFIG.signals, 'the saved signal table (#727)');
  assert.deepEqual([github.closeSessionTab, github.closeStageTab, github.closeSessionTabNotice, github.closeStageTabNotice], ['sleep', 'sleep', false, false], 'the saved choices (#614)');
  assert.deepEqual(github.sources.map(withoutId), [{ ...GH_ROW, switchAt: github.stages[1].id }], 'switchAt as the dev stage draft\'s id (#30)');
  const [work] = github.sources;
  assert.deepEqual(github.workspaces.map(withoutId), [{ name: 'hive', path: '/repo', env: [], ...NO_SETUP }]);
  assert.deepEqual(github.commands.map((c) => ({ ...withoutId(c), env: c.env.map(withoutId), impls: c.impls.map(withoutId) })), [
    { name: 'Run Frontend', impls: [{ workspace: github.workspaces[0].id, command: FRONT_LINE }], menu: true, env: [{ name: 'PORT', value: '5173' }, { name: 'HOST', value: 'localhost' }], timeout: '' },
  ], 'comb.commands over the workspace rows: env as rows, in order, each line\'s workspace as a row id (#300, #348, #511, #755)');
  assert.deepEqual(stageWithoutId(github.stages[0]), { name: 'spec', savedName: 'spec', session: 'new', model: 'opus', agent: '', from: { [work.id]: ['Backlog'] }, onStart: {}, gate: false, verdicts: [], prompt: '/hive-spec {url}', skill: '', specializedAgent: '', action: '', after: '', approval: false, handoff: false, clearSession: false, maxWorkers: '', commands: [], stopOnFailure: true, onMissing: 'fail', ciChecks: 'required', checks: [], rerunOnce: false, timeout: '60m', reviewers: [], judge: { agent: 'claude', model: '', specializedAgent: '', focus: '' }, threshold: '7', rubric: '' });
  assert.equal(github.stages[1].session, 'continue');
  assert.deepEqual(stageWithoutId(github.stages[2]), { name: 'done', savedName: 'done', session: 'new', model: '', agent: '', from: { [work.id]: ['Done'] }, onStart: {}, gate: false, verdicts: [], prompt: '', skill: '', specializedAgent: '', action: 'deleteActivity', after: '5d', approval: false, handoff: false, clearSession: false, maxWorkers: '', commands: [], stopOnFailure: true, onMissing: 'fail', ciChecks: 'required', checks: [], rerunOnce: false, timeout: '60m', reviewers: [], judge: { agent: 'claude', model: '', specializedAgent: '', focus: '' }, threshold: '7', rubric: '' });
  assert.notEqual(github.stages[0].id, github.stages[1].id, 'each row gets its own id');
  assert.deepEqual([github.language, github.budgetHour, github.budgetDay], ['pt', '50000', '']);
  assert.equal(github.baseBranch, 'develop');
  assert.deepEqual(github.trustedDomains, ['github.com', 'docs.example.com']);
  assert.deepEqual(github.shortcuts, { toggleRight: 'CmdOrCtrl+Shift+Y', clear: null }, 'the saved changes as they are (#449)');
  assert.deepEqual(github.rules.map(withoutId), [
    { source: 'hour', percent: '80', stage: '', kind: 'signal', value: 'yellow' },
    { source: 'session', percent: '90', stage: '', kind: 'maxWorkers', value: '1' },
    { source: 'session', percent: '90', stage: '', kind: 'signal', value: 'red' },
  ], 'one row per present consequence key, cap before signal');
  assert.notEqual(github.rules[0].id, github.rules[1].id, 'each row gets its own id');
  assert.notEqual(github.rules[1].id, github.rules[2].id, 'each split row too');
  const empty = draftFrom(info(undefined, false));
  assert.deepEqual({ ...empty, workspaces: empty.workspaces.map(withoutId), sources: empty.sources.map(withoutId) }, {
    hiveSource: true, createIn: 'hive',
    prefix: 'HIVE', workspaces: [{ name: '', path: '', env: [], ...NO_SETUP }], commands: [], editor: EDITOR_DEFAULTS, sources: [{ ...GH_ROW, name: '', savedName: '', owner: '@me', number: '', epics: 'show', epicFollows: 'aheadThenBehind', taskProps: { defaults: { workspace: '', auto: true }, rules: [] } }],
    stages: [], transitions: [], language: 'en', branch: '', baseBranch: '', budgetHour: '', budgetDay: '', rules: [], auth: 'cli', onClose: 'menuBar',
    deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: String(SHUTDOWN_IDLE_DEFAULT), approvalMinutes: String(APPROVAL_MINUTES_DEFAULT), rateLimitWaitMinutes: String(RATE_LIMIT_WAIT_DEFAULT), showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, theme: 'system', terminalFont: '', trustedDomains: [], consoleLines: String(CONSOLE_LINES_DEFAULT), shortcuts: {},
    defaultAgent: 'claude', // DEFAULT_AGENT on a first run (#516)
    agentArgs: { claude: '', codex: '' }, // no saved list (#924)
    fileIcons: { set: 'material', scope: 'all', muted: true }, // FILE_ICONS_DEFAULTS on a new form (#754)
    sidebarsPerView: { left: false, right: false, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, // SIDEBARS_PER_VIEW_DEFAULTS on a new form (#821)
    signals: SIGNALS_DEFAULTS, // today's table on a new form (#727)
  });
  assert.equal(draftFrom(undefined).language, 'en');
  assert.equal(github.auth, 'api');
});

test('the onStart drafts hold the actions as written, keyed by row, and toSettingsBody sends them keyed by source name; withEntry sets or drops one entry (#286)', () => {
  const draft = draftFrom(info(CONFIG));
  const [work] = draft.sources;
  assert.deepEqual(draft.stages[1].onStart, { [work.id]: [{ type: 'move', column: 'In progress' }] });
  assert.deepEqual(draft.transitions[1].sources, { [work.id]: [{ type: 'move', column: 'In review' }] });
  const body = toSettingsBody(draft);
  assert.deepEqual([body.stages?.[1].onStart, body.transitions?.[1].sources], [{ work: [{ type: 'move', column: 'In progress' }] }, { work: [{ type: 'move', column: 'In review' }] }]);
  const map = { a: 1, b: 2 };
  assert.deepEqual([withEntry(map, 'a', 3), withEntry(map, 'a', undefined), withEntry(map, 'c', 4)], [{ a: 3, b: 2 }, { b: 2 }, { a: 1, b: 2, c: 4 }]);
  assert.deepEqual(map, { a: 1, b: 2 }, 'the input is not mutated');
});

test('validateSettings answers the tab and message of the first problem, in the order of today, and undefined for a valid draft', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  assert.equal(validateSettings(valid), undefined);
  assert.deepEqual(validateSettings({ ...valid, sources: [{ ...valid.sources[0], number: '' }] }), { section: 'flow', message: t('settings.error.project') });
  assert.deepEqual(validateSettings({ ...valid, stages: [] }), { section: 'flow', message: t('settings.stages.none') });
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], { ...emptyStage(), name: ' ' }] }), { section: 'flow', message: t('settings.stages.error', { n: 2 }) });
  assert.deepEqual(validateSettings({ ...valid, stages: [{ ...valid.stages[2], after: '5x' }] }), { section: 'flow', message: t('settings.stages.error', { n: 1 }) });
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], { ...valid.stages[0], after: '0d' }] }), { section: 'flow', message: t('settings.stages.error', { n: 2 }) });
  assert.equal(validateSettings({ ...valid, stages: [{ ...valid.stages[0], after: ' 12h ' }, { ...valid.stages[2], after: '' }] }), undefined, 'trimmed, or empty = right away');
  const rule = (patch: Partial<RuleDraft>): RuleDraft => ({ ...emptyRule('session'), percent: '50', kind: 'maxWorkers', value: '2', ...patch });
  const badRule = (patch: Partial<RuleDraft>, why: string) =>
    assert.deepEqual(validateSettings({ ...valid, rules: [...valid.rules, rule(patch)] }), { section: 'rules', message: t('settings.rules.error', { n: 4, source: t('settings.rules.measure.session') }) }, why);
  badRule({ percent: '' }, 'no percent');
  badRule({ percent: '101' }, 'percent over 100');
  badRule({ kind: '' }, 'a consequence without kind: what a new rule opens with');
  badRule({ kind: 'maxWorkers', value: '-1' }, 'a cap below 0');
  badRule({ kind: 'signal', value: '' }, 'a signal without value');
  badRule({ kind: 'signal', value: 'green' }, 'green is not a consequence');
  assert.equal(validateSettings({ ...valid, rules: [...valid.rules, rule({ kind: 'maxWorkers', value: '0' })] }), undefined, 'cap 0 is a valid consequence');
  assert.deepEqual(validateSettings({ ...valid, budgetHour: 'abc' }), { section: 'rules', message: t('settings.budgetHint') });
  assert.deepEqual(validateSettings({ ...valid, budgetDay: '-5' }), { section: 'rules', message: t('settings.budgetHint') });
  assert.equal(validateSettings({ ...valid, budgetHour: '0', budgetDay: '' }), undefined, '0 and empty mean no limit');
  assert.deepEqual(validateSettings({ ...valid, shortcuts: { close: 'CmdOrCtrl+1' } }), { section: 'shortcuts', message: t('settings.error.shortcutCollision', { a: t('shortcuts.viewActivities'), b: t('shortcuts.close') }) }, 'two shortcuts on one key, both named (#449); viewActivities\' on every platform (#585, #746)');
  assert.deepEqual(validateSettings({ ...valid, shortcuts: { toggleLeft: 'CmdOrCtrl+C' } }), { section: 'shortcuts', message: t('settings.error.shortcutReserved', { name: t('shortcuts.toggleLeft') }) }, 'a key the Edit menu keeps');
  assert.deepEqual(validateSettings({ ...valid, shortcuts: { clear: 'CmdOrCtrl+,' } }), { section: 'shortcuts', message: t('settings.error.shortcutReserved', { name: t('shortcuts.clear') }) }, 'Settings…\'s fixed key (#481)');
  assert.deepEqual(validateSettings({ ...valid, shortcuts: { toggleConsole: 'Alt+0' } }), { section: 'shortcuts', message: t('settings.error.shortcutFixed', { name: t('shortcuts.toggleConsole'), fixed: t('shortcuts.fixed.pickSource') }) }, 'a fixed key: Alt+0–9 picks a source on every platform (#585)');
  assert.equal(validateSettings({ ...valid, shortcuts: { close: 'CmdOrCtrl+1', viewActivities: null } }), undefined, 'a key freed by turning its shortcut off');
  for (const lines of ['', '99', '100001', '1.5', 'abc']) {
    assert.deepEqual(validateSettings({ ...valid, consoleLines: lines }), { section: 'app', message: t('settings.error.consoleLines') }, `console lines ${JSON.stringify(lines)} (#353)`);
  }
  assert.equal(validateSettings({ ...valid, consoleLines: ' 100 ' }), undefined, 'trimmed, the lower bound included');
});

test('toSettingsBody emits only filled keys, keeps stage and rule order, and reads each source from its row', () => {
  const body = toSettingsBody(draftFrom(info(CONFIG)));
  assert.deepEqual(body, {
    hiveSource: true, createIn: 'hive',
    prefix: 'HIVE',
    workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }],
    commands: [FRONT],
    auth: { github: 'api' },
    sources: [{ name: 'work', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: [], taskProps: FIXED, ...EPICS }],
    renames: {},
    stages: CONFIG.comb.stages, transitions: CONFIG.comb.transitions,
    budget: { maxTokensPerHour: 50_000 }, usageRules: CONFIG.usageRules, language: 'pt', baseBranch: 'develop', onClose: 'quit',
    deleteActivity: { session: true, transcripts: true, nonAutoTasks: true },
    shutdownIdleMinutes: 45,
    approvalMinutes: 30,
    rateLimitWaitMinutes: 600,
    showGithubQuota: true,
    closeSessionTab: 'sleep',
    closeStageTab: 'sleep',
    closeSessionTabNotice: false,
    closeStageTabNotice: false,
    sleepNotice: false,
    sleepAutoNotice: false,
    sleepIdleNotice: false,
    sleepAllNotice: false,
    closeTerminalTab: 'keep',
    closeTerminalTabNotice: false,
    defaultAgent: 'claude',
    agentArgs: { claude: [], codex: [] },
    theme: 'dark',
    fileIcons: { set: 'vscode', scope: 'folders', muted: true },
    sidebarsPerView: { left: false, right: true, rightTab: false }, notifications: { waiting: true, approval: false, pr: true, failed: false },
    signals: CONFIG.signals,
    editor: EDITOR_DEFAULTS,
    terminalFont: 'MesloLGS NF',
    trustedDomains: ['github.com', 'docs.example.com'],
    shortcuts: { toggleRight: 'CmdOrCtrl+Shift+Y', clear: null },
    consoleLines: 20000,
  });
  assert.equal('id' in body.stages[0]!, false, 'id is a draft-only field, never sent to the server');
  assert.equal('id' in body.usageRules![0]!, false, 'id is a draft-only field, never sent to the server');
  const row: SourceDraft = { ...emptySource('hive'), name: 'notes', number: '7' };
  const bare = toSettingsBody({ ...draftFrom(undefined), sources: [row], stages: [{ ...emptyStage(), name: 'fila', from: { [row.id]: ['Ready'] } }], rules: [{ ...emptyRule('day'), percent: '80', kind: 'signal', value: 'red' }] });
  assert.deepEqual(bare.sources, [{ name: 'notes', qualifyId: false, type: 'github', owner: '@me', number: 7, filter: [], taskProps: FIXED, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' }]);
  assert.deepEqual(bare.stages, [{ name: 'fila', from: { notes: ['Ready'] } }], 'session=new, empty model / onStart / prompt stay absent');
  assert.deepEqual(bare.usageRules, [{ source: 'day', percent: 80, signal: 'red' }], 'the consequence list folds back into keys; the absent one stays absent');
  assert.deepEqual(bare.budget, {});
  assert.deepEqual(bare.commands, [], 'always sent, [] included (#511)');
  assert.equal(bare.terminalFont, '', 'always sent, an empty field included: "" is the system monospace (#376)');
  assert.equal(toSettingsBody({ ...draftFrom(undefined), terminalFont: ' MesloLGS NF ' }).terminalFont, 'MesloLGS NF', 'trimmed, as baseBranch is');
  assert.deepEqual(bare.trustedDomains, [], 'always sent, an empty field included: every link asks (#404)');
  assert.deepEqual(bare.shortcuts, {}, 'always sent, {} included: every default (#449)');
  assert.deepEqual([bare.closeSessionTab, bare.closeStageTab, bare.closeSessionTabNotice, bare.closeStageTabNotice], ['keep', 'keep', true, true], 'always sent, the new form\'s defaults included (#614)');
  assert.deepEqual(toSettingsBody({ ...draftFrom(undefined), trustedDomains: ['github.com', 'docs.example.com'] }).trustedDomains, ['github.com', 'docs.example.com'], '[] sent as is: the chips already normalize (#513)');
  assert.equal('id' in bare.stages[0]!, false);
  assert.equal('id' in bare.usageRules![0]!, false);
  const cleanup = toSettingsBody({ ...draftFrom(undefined), stages: [{ ...emptyStage(), name: 'done', from: {}, action: 'deleteActivity', after: ' 5d ', prompt: '/x', session: 'continue', model: 'opus' }] });
  assert.deepEqual(cleanup.stages, [{ name: 'done', from: {}, action: 'deleteActivity', after: '5d' }], 'under delete activity the prompt, session and model never leave the form; after is trimmed');
  assert.equal(bare.baseBranch, '', 'always sent, empty included: that is how a cleared field goes back to automatic');
  assert.equal(toSettingsBody({ ...draftFrom(undefined), baseBranch: '  release  ' }).baseBranch, 'release');
  assert.deepEqual(toSettingsBody({ ...draftFrom(undefined), stages: [{ ...emptyStage(), name: 'a', from: {}, after: '' }] }).stages?.map((c) => 'after' in c), [false], 'empty after = key absent');
  assert.deepEqual(stageWithoutId(emptyStage()), { name: '', session: 'new', model: '', agent: '', from: {}, onStart: {}, gate: false, verdicts: [], prompt: '', skill: '', specializedAgent: '', action: '', after: '', approval: false, handoff: false, clearSession: false, maxWorkers: '', commands: [], stopOnFailure: true, onMissing: 'fail', ciChecks: 'required', checks: [], rerunOnce: false, timeout: '60m', reviewers: [], judge: { agent: 'claude', model: '', specializedAgent: '', focus: '' }, threshold: '7', rubric: '' });
  assert.notEqual(emptyStage().id, emptyStage().id, 'ids are unique per call');
});

test('validateSettings refuses an evaluate stage with no rubric line, naming the stage (#877)', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const evaluating = { ...emptyStage(), name: 'eval', action: 'evaluate' as const, rubric: ' ' };
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], evaluating] }), { section: 'flow', message: t('settings.stages.error.evaluate', { n: 2 }) });
});

test('the task filter rules round-trip: the row holds the saved rules, the body sends them as they are, and a new row has none (#245)', () => {
  const rules: FilterRule[] = [{ field: 'assignee', op: 'any', values: ['@me'] }, { field: 'projectField', name: 'Priority', op: 'none', values: ['P3'] }];
  const filtered = withSources([{ name: 'work', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: rules, taskProps: FIXED, ...EPICS }]);
  const draft = draftFrom(info(filtered));
  const [row] = draft.sources;
  assert.deepEqual(row.filter, rules);
  assert.deepEqual(toSettingsBody(draft).sources, filtered.comb.sources, 'an untouched form saves the rules it loaded');
  assert.deepEqual(emptySource().filter, [], 'a new row starts with no rule');
});

test('each source row carries its epics keys (#30): switchAt loaded as its stage draft id and sent by name; a rename carries it, a removal falls back to Build, else the first stage; a new row gets show, aheadThenBehind and the default', () => {
  const saved = draftFrom(info(CONFIG));
  const [work] = saved.sources;
  const dev = saved.stages[1];
  assert.deepEqual([work.epics, work.epicFollows, work.switchAt], ['hide', 'ahead', dev.id]);
  assert.deepEqual(toSettingsBody(saved).sources?.[0], CONFIG.comb.sources[0], 'an untouched form saves what it loaded');
  const switchAt = (draft: SettingsDraft): string | undefined => toSettingsBody(draft).sources?.[0].switchAt;
  assert.equal(switchAt({ ...saved, stages: saved.stages.map((s) => (s.id === dev.id ? { ...s, name: 'develop' } : s)) }), 'develop', 'the rename carries it');
  const withoutDev = saved.stages.filter((s) => s.id !== dev.id);
  assert.equal(switchAt({ ...saved, stages: withoutDev }), 'spec', 'removed, and no Build: the first stage');
  assert.equal(switchAt({ ...saved, stages: [...withoutDev, { ...emptyStage(), name: 'Build' }] }), 'Build', 'removed: the stage named Build first');
  const fresh = emptySource('hive');
  assert.deepEqual([fresh.epics, fresh.epicFollows, fresh.switchAt], ['show', 'aheadThenBehind', '']);
  assert.equal(switchAt({ ...saved, sources: [fresh] }), 'spec', 'a new row: Build, else the first stage');
  assert.deepEqual(toSettingsBody({ ...saved, sources: [{ ...work, epics: 'ignore', epicFollows: 'behind' }] }).sources?.[0], { ...CONFIG.comb.sources[0], epics: 'ignore', epicFollows: 'behind' });
});

test('the branch template round-trips: the draft seeds from the saved config, an empty field is sent as no key at all, and a typed one is trimmed', () => {
  assert.equal(draftFrom(info({ ...CONFIG, branch: 'feat/{id}-{title}' })).branch, 'feat/{id}-{title}');
  assert.equal(draftFrom(info(CONFIG)).branch, '', 'no template saved: an empty field, which means the default');
  assert.equal(draftFrom(info(undefined, false)).branch, '');
  assert.equal(toSettingsBody({ ...draftFrom(info(CONFIG)), branch: '  feat/{id}  ' }).branch, 'feat/{id}');
  assert.equal('branch' in toSettingsBody(draftFrom(info(CONFIG))), false, 'an empty field sends no key: hive.config.json stays clean');
});

test('validateSettings reports an unusable branch template on the general tab, after the limits it already checked', () => {
  const draft = draftFrom(info(CONFIG));
  assert.equal(validateSettings({ ...draft, branch: 'feat/{title}' })?.section, 'execution');
  assert.equal(validateSettings({ ...draft, branch: 'feat/{title}' })?.message, t('settings.error.branch.unique'));
  assert.equal(validateSettings({ ...draft, branch: 'hive/{id}^' })?.message, t('settings.error.branch.invalid'));
  assert.equal(validateSettings({ ...draft, branch: 'feat/{id}-{title}' }), undefined);
  assert.equal(validateSettings({ ...draft, branch: '' }), undefined, 'empty is the default, not a mistake');
  assert.equal(validateSettings({ ...draft, branch: 'feat/{title}', budgetHour: 'x' })?.section, 'rules', 'the budget is still checked first');
});

test('sourceColumnsUrl builds the GET /settings/source-columns query for a github row and is undefined while the row is not chosen; projectsUrl needs an owner', () => {
  const draft = draftFrom(info(CONFIG));
  const [row] = draft.sources;
  assert.equal(sourceColumnsUrl(draft, row), '/settings/source-columns?type=github&owner=acme&number=6&auth=api');
  assert.equal(sourceColumnsUrl(draft, { ...row, number: '' }), undefined);
  assert.equal(sourceColumnsUrl(draft, { ...row, owner: ' ' }), undefined);
  assert.equal(sourceColumnsUrl({ ...draft, auth: 'cli' }, row), '/settings/source-columns?type=github&owner=acme&number=6&auth=cli');
  assert.equal(projectsUrl('api', row), '/settings/projects?owner=acme&auth=api');
  assert.equal(projectsUrl('api', { ...row, owner: '  ' }), undefined);
});

test('validateSettings checks the prefix first, on the comb tab: a letter, then up to 9 letters or digits, trimmed', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  for (const prefix of ['', '1A', 'HI-VE', 'ABCDEFGHIJK']) {
    assert.deepEqual(validateSettings({ ...valid, prefix, sources: [{ ...valid.sources[0], number: '' }] }), { section: 'flow', message: t('settings.error.prefix') }, prefix);
  }
  assert.equal(validateSettings({ ...valid, prefix: ' T2 ' }), undefined);
  assert.equal(toSettingsBody({ ...valid, prefix: ' T2 ' }).prefix, 'T2');
});

test('no sources: a Comb saved without sources drafts none, and the body carries sources [], no auth and stages with from {} and no writes', () => {
  const none = draftFrom(info(withSources([])));
  assert.deepEqual(none.sources, []);
  assert.equal(validateSettings(none), undefined, 'no workspace or path to ask for');
  const body = toSettingsBody(none);
  assert.deepEqual([body.sources, 'auth' in body], [[], false]);
  assert.deepEqual(body.stages, [
    { name: 'spec', from: {}, prompt: '/hive-spec {url}', model: 'opus' },
    { name: 'dev', from: {}, prompt: '/hive-build {url}', session: 'continue' },
    { name: 'done', from: {}, action: 'deleteActivity', after: '5d' },
  ], 'the saved column maps name no row left: dropped');
  assert.equal(draftFrom(info(undefined, false)).sources[0].type, 'github', 'a first setup opens with one GitHub row');
});

test('the workspaces: the saved rows, else one row named after the proposed folder, else one empty row; every row needs a valid name and a folder, names unique, checked on the general tab after the limits; sent trimmed (#179)', () => {
  setLanguage('pt');
  const rows = (d: SettingsDraft) => d.workspaces.map(({ id: _id, env: _env, ...p }) => p);
  assert.deepEqual(rows(draftFrom({ ...info(undefined, false), proposedWorkspace: '/work/My App!' })), [{ name: 'My-App-', path: '/work/My App!', ...NO_SETUP }]);
  assert.deepEqual(rows(draftFrom({ ...info(CONFIG, false), proposedWorkspace: '/work/app' })), [{ name: 'hive', path: '/repo', ...NO_SETUP }], 'a saved config wins over the proposal');
  assert.deepEqual(rows(draftFrom(info(undefined, false))), [{ name: '', path: '', ...NO_SETUP }]);
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const site = { ...emptyWorkspace(), name: 'site', path: '/site' };
  assert.equal(validateSettings({ ...valid, workspaces: [...valid.workspaces, site] }), undefined);
  assert.deepEqual(validateSettings({ ...valid, workspaces: [valid.workspaces[0], { ...site, path: '  ' }] }), { section: 'workspaces', message: t('settings.error.workspaces', { n: 2 }) });
  assert.deepEqual(validateSettings({ ...valid, workspaces: [{ ...site, name: '-x' }] }), { section: 'workspaces', message: t('settings.error.workspaces', { n: 1 }) });
  assert.deepEqual(validateSettings({ ...valid, workspaces: [valid.workspaces[0], { ...site, name: ' hive ' }] }), { section: 'workspaces', message: t('settings.error.workspaceDuplicate', { name: 'hive' }) });
  assert.equal(validateSettings({ ...valid, workspaces: [{ ...site, path: '' }], budgetHour: 'x' })?.section, 'rules', 'the limits are still checked first');
  assert.equal(validateSettings({ ...valid, workspaces: [{ ...site, path: '' }], branch: 'feat/{title}' })?.message, t('settings.error.workspaces', { n: 1 }), 'before the branch');
  assert.deepEqual(toSettingsBody({ ...valid, workspaces: [{ ...site, name: ' site ', path: ' /site ' }, valid.workspaces[0]] }).workspaces, [{ name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }]);
});

test('env rows (#348, #511): a blank row is dropped, the name trimmed, the value kept as typed, in the workspace and in a command; a bad name stops the save on workspaces, the workspace env first', () => {
  setLanguage('en');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] }; // hive runs FRONT
  const [hive] = valid.workspaces;
  const row = (name: string, value: string): EnvRowDraft => ({ ...emptyEnvRow(), name, value });
  const withEnv = (workspace: EnvRowDraft[], command: EnvRowDraft[] = []): SettingsDraft =>
    ({ ...valid, workspaces: [{ ...hive, env: workspace }], commands: [...valid.commands, { ...emptyCommand(), name: 'Lint', impls: [{ ...emptyImpl(null), command: 'pnpm lint' }], env: command }] });

  const typed = withEnv([row(' NODE_ENV ', 'development'), emptyEnvRow()], [row('GREETING', '  hi  '), row('EMPTY', ''), row('  ', '')]);
  assert.equal(validateSettings(typed), undefined, 'blank rows are no problem');
  const body = toSettingsBody(typed);
  assert.deepEqual([body.workspaces[0].env, body.commands?.[1].env], [{ NODE_ENV: 'development' }, { GREETING: '  hi  ', EMPTY: '' }]);
  const workspaceProblem = { section: 'workspaces', message: t('settings.error.workspaceEnv', { workspace: 'hive' }) };
  const commandProblem = { section: 'workspaces', message: t('settings.error.commandEnv', { n: 2 }) };
  for (const bad of [[row('', 'x')], [row('1PORT', 'x')], [row('MY-PORT', 'x')], [row('PORT', '1'), row(' PORT ', '2')]]) {
    const why = JSON.stringify(bad.map(withoutId));
    assert.deepEqual(validateSettings(withEnv(bad)), workspaceProblem, why);
    assert.deepEqual(validateSettings(withEnv([], bad)), commandProblem, why);
  }
  assert.equal(validateSettings(withEnv([row('PORT', '1')], [row('PORT', '2')])), undefined, 'one name in both layers: the command wins at launch');
});

test('each row\'s task properties (#688): read from its saved source and sent back; a new row starts on the workspace it is given with auto on, a first setup\'s on the proposed folder; a problem is a flow problem, judged after the source fields and the workspaces', () => {
  setLanguage('pt');
  const GH = { name: 'work', qualifyId: false, type: 'github' as const, owner: 'acme', number: 6, filter: [] as FilterRule[], ...EPICS };
  const ROUTED: SourceTaskProps = { defaults: { auto: false }, rules: [{ field: 'title', op: 'icontains', value: '[api]', set: { workspace: 'hive' } }] };
  const body = (row: SourceDraft, draft: SettingsDraft) => toSettingsBody({ ...draft, sources: [row] }).sources?.[0];
  const routedDraft = draftFrom(info(withSources([{ ...GH, taskProps: ROUTED }])));
  const [routed] = routedDraft.sources;
  assert.equal(routed.taskProps.defaults.workspace, '', 'no default workspace');
  assert.deepEqual(body(routed, routedDraft), { ...GH, taskProps: ROUTED });
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const [fixed] = valid.sources;
  assert.deepEqual(body(fixed, valid), { ...GH, taskProps: FIXED });
  assert.deepEqual([emptySource('hive').taskProps, emptySource().taskProps.defaults.workspace], [{ defaults: { workspace: 'hive', auto: true }, rules: [] }, '']);
  assert.equal(draftFrom({ ...info(undefined, false), proposedWorkspace: '/work/app' }).sources[0].taskProps.defaults.workspace, 'app');
  const at = (workspace: string): SourceDraft => ({ ...fixed, taskProps: { ...fixed.taskProps, defaults: { workspace, auto: true } } });
  assert.deepEqual(validateSettings({ ...valid, sources: [at('gone')] }), { section: 'flow', message: t('settings.error.sourceWorkspace', { source: 'work' }) });
  assert.deepEqual(validateSettings({ ...valid, sources: [at('')] }), { section: 'flow', message: t('settings.error.taskPropsNoWorkspace', { source: 'work' }) });
  assert.deepEqual(validateSettings({ ...valid, sources: [{ ...at('gone'), number: '' }] }), { section: 'flow', message: t('settings.error.project') }, 'the source fields first');
  assert.deepEqual(validateSettings({ ...valid, sources: [at('gone')], workspaces: [{ ...valid.workspaces[0], path: '' }] }), { section: 'workspaces', message: t('settings.error.workspaces', { n: 1 }) }, 'then the workspaces it is judged against');
});

test('source rows: a valid name (not "local" or "hive"), unique, a prefix like the Comb\'s when set, checked on the comb tab; the column maps are keyed by row in the draft and by name in the body, a removed row\'s entries dropped (#180)', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const notes: SourceDraft = { ...emptySource('hive'), name: 'notes', number: '7', qualifyId: true, prefix: 'N' };
  const fed = valid.stages.map((s, i) => (i === 0 ? { ...s, from: { ...s.from, [notes.id]: ['todo'] } } : s)); // #514: a stage must enter from it too
  assert.equal(validateSettings({ ...valid, sources: [...valid.sources, notes], stages: fed }), undefined);
  for (const name of ['', '-x', 'local', 'hive', 'a:b']) {
    assert.deepEqual(validateSettings({ ...valid, sources: [valid.sources[0], { ...notes, name }] }), { section: 'flow', message: t('settings.error.sourceName', { n: 2 }) }, name);
  }
  assert.deepEqual(validateSettings({ ...valid, sources: [valid.sources[0], { ...notes, prefix: '1N' }] }), { section: 'flow', message: t('settings.error.sourceName', { n: 2 }) });
  assert.deepEqual(validateSettings({ ...valid, sources: [valid.sources[0], { ...notes, name: ' work ' }] }), { section: 'flow', message: t('settings.error.sourceDuplicate', { name: 'work' }) });
  assert.equal(validateSettings({ ...valid, sources: [] }), undefined, 'no source: tasks enter by hand');
  const [work] = valid.sources;
  const stage = { ...emptyStage(), name: 'dev', from: { [work.id]: ['Ready'], [notes.id]: ['todo'] }, onStart: { [notes.id]: [{ type: 'move' as const, column: 'doing' }] } };
  const body = toSettingsBody({ ...valid, sources: [work, notes], stages: [stage] });
  assert.deepEqual(body.sources?.[1], { name: 'notes', qualifyId: true, prefix: 'N', type: 'github', owner: '@me', number: 7, filter: [], taskProps: FIXED, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'dev' });
  assert.deepEqual(body.stages?.[0], { name: 'dev', from: { work: ['Ready'], notes: ['todo'] }, onStart: { notes: [{ type: 'move', column: 'doing' }] } }, 'no entry, no key');
  assert.deepEqual(toSettingsBody({ ...valid, sources: [notes], stages: [stage] }).stages?.[0].from, { notes: ['todo'] }, 'a removed row\'s entries go with it');
  assert.deepEqual(toSettingsBody({ ...valid, sources: [notes] }).auth, { github: 'api' }, 'a GitHub source sends auth');
});

test('validateSettings refuses a source no stage enters from, last in the chain, naming it on flow (#514)', () => {
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const notes: SourceDraft = { ...emptySource('hive'), name: 'notes', number: '3' };
  assert.deepEqual(validateSettings({ ...valid, sources: [...valid.sources, notes] }), { section: 'flow', message: t('settings.error.sourceSilent', { source: 'notes' }) });
  const fed = valid.stages.map((s, i) => (i === 0 ? { ...s, from: { ...s.from, [notes.id]: ['Ready'] } } : s));
  assert.equal(validateSettings({ ...valid, sources: [...valid.sources, notes], stages: fed }), undefined);
});

test('the draft carries notifications and toSettingsBody always sends it (#199)', () => {
  assert.deepEqual(draftFrom(undefined).notifications, { waiting: true, approval: true, pr: true, failed: true }, 'a new form: every kind on');
  assert.deepEqual(draftFrom(info(CONFIG)).notifications, { waiting: true, approval: false, pr: true, failed: false });
  const off = { waiting: false, approval: false, pr: false, failed: false };
  assert.deepEqual(toSettingsBody({ ...draftFrom(info(CONFIG)), notifications: off }).notifications, off);
});

test('the draft carries onClose and toSettingsBody always sends it (#513)', () => {
  assert.equal(draftFrom(undefined).onClose, 'menuBar');
  assert.equal(draftFrom(info(undefined, false)).onClose, 'menuBar', 'a first setup: today\'s behaviour');
  assert.equal(draftFrom(info(CONFIG)).onClose, 'quit', 'CONFIG saves quit');
  assert.equal(toSettingsBody({ ...draftFrom(info(CONFIG)), onClose: 'menuBar' }).onClose, 'menuBar');
});

test('withHost adds one trimmed, lowercased host, ignores a repeat and refuses what is not a bare host (#513)', () => {
  assert.deepEqual(withHost(['github.com'], ' Docs.Example.com '), ['github.com', 'docs.example.com']);
  assert.deepEqual(withHost(['github.com'], 'GITHUB.com'), ['github.com'], 'a repeat is no change');
  for (const bad of ['https://github.com', 'github.com:443', 'github.com/x', '*.github.com', '']) assert.equal(withHost([], bad), undefined, bad);
});

test('what deleting an activity forgets (#236, #573): a new form starts with every switch off, a saved config gives its own and the body always carries it; no combination is a problem, since the worktree and the branch always go', () => {
  setLanguage('en');
  assert.deepEqual(draftFrom(undefined).deleteActivity, DELETE_ACTIVITY_DEFAULTS);
  assert.deepEqual(draftFrom(info(undefined, false)).deleteActivity, DELETE_ACTIVITY_DEFAULTS, 'a first setup: the form defaults');
  const saved = draftFrom(info(CONFIG));
  assert.deepEqual(saved.deleteActivity, CONFIG.deleteActivity);
  assert.deepEqual(toSettingsBody(saved).deleteActivity, CONFIG.deleteActivity);
  assert.equal(validateSettings({ ...saved, deleteActivity: DELETE_ACTIVITY_DEFAULTS }), undefined, 'every switch off is valid');
});

test('the shutdown window (#233): a new form shows 10, a saved config its own minutes, the body carries a number, and anything but a whole number from 1 to 1440 is a problem on the general tab', () => {
  setLanguage('en');
  assert.equal(draftFrom(undefined).shutdownIdleMinutes, '10');
  assert.equal(draftFrom(info(undefined, false)).shutdownIdleMinutes, '10', 'a first setup: the default');
  const saved = draftFrom(info(CONFIG)); // CONFIG saves 45
  assert.equal(saved.shutdownIdleMinutes, '45');
  assert.equal(toSettingsBody({ ...saved, shutdownIdleMinutes: ' 30 ' }).shutdownIdleMinutes, 30);
  for (const bad of ['', '0', '1441', '1.5', 'ten', '-3']) {
    assert.deepEqual(validateSettings({ ...saved, shutdownIdleMinutes: bad }), { section: 'execution', message: t('settings.error.shutdownIdle') }, bad);
  }
  for (const ok of ['1', '1440', ' 30 ']) assert.equal(validateSettings({ ...saved, shutdownIdleMinutes: ok }), undefined, ok);
});

test('the approval window (#268): a new form shows 10, a saved config its own minutes, the body carries a number, and anything but a whole number from 1 to 120 is a problem on the general tab', () => {
  setLanguage('en');
  assert.equal(draftFrom(undefined).approvalMinutes, '10');
  assert.equal(draftFrom(info(undefined, false)).approvalMinutes, '10', 'a first setup: the default');
  const saved = draftFrom(info(CONFIG)); // CONFIG saves 30
  assert.equal(saved.approvalMinutes, '30');
  assert.equal(toSettingsBody({ ...saved, approvalMinutes: ' 15 ' }).approvalMinutes, 15);
  for (const bad of ['', '0', '121', '1.5', 'ten', '-3']) {
    assert.deepEqual(validateSettings({ ...saved, approvalMinutes: bad }), { section: 'execution', message: t('settings.error.approvalMinutes') }, bad);
  }
  for (const ok of ['1', '120', ' 15 ']) assert.equal(validateSettings({ ...saved, approvalMinutes: ok }), undefined, ok);
});

test('the rate-limit wait (#805): a new form shows 300, a saved config its own minutes, the body carries a number, and anything but a whole number from 1 to 10080 is a problem on the execution section', () => {
  setLanguage('en');
  assert.equal(draftFrom(undefined).rateLimitWaitMinutes, '300');
  assert.equal(draftFrom(info(undefined, false)).rateLimitWaitMinutes, '300', 'a first setup: the default');
  const saved = draftFrom(info(CONFIG)); // CONFIG saves 600
  assert.equal(saved.rateLimitWaitMinutes, '600');
  assert.equal(toSettingsBody({ ...saved, rateLimitWaitMinutes: ' 90 ' }).rateLimitWaitMinutes, 90);
  for (const bad of ['', '0', '10081', '1.5', 'ten', '-3']) {
    assert.deepEqual(validateSettings({ ...saved, rateLimitWaitMinutes: bad }), { section: 'execution', message: t('settings.error.rateLimitWait') }, bad);
  }
  for (const ok of ['1', '10080', ' 90 ']) assert.equal(validateSettings({ ...saved, rateLimitWaitMinutes: ok }), undefined, ok);
});

test('isMinutes (#778): whole minutes from 1 to the max, the predicate the sessions table marks its fields invalid with', () => {
  for (const ok of ['1', String(RATE_LIMIT_WAIT_MAX), ' 90 ']) assert.equal(isMinutes(ok, RATE_LIMIT_WAIT_MAX), true, ok);
  for (const bad of ['0', String(RATE_LIMIT_WAIT_MAX + 1), '1.5', '', 'abc', '-3']) assert.equal(isMinutes(bad, RATE_LIMIT_WAIT_MAX), false, bad);
});

test('a stage\'s approval (#268): the draft reads it, the body sends approval: true only from a prompt stage that has it, never from a delete activity one', () => {
  const approving: Config = { ...CONFIG, comb: { ...CONFIG.comb, stages: [{ ...CONFIG.comb.stages[0], approval: true }, ...CONFIG.comb.stages.slice(1)] } };
  const draft = draftFrom(info(approving));
  assert.deepEqual(draft.stages.map((c) => c.approval), [true, false, false]);
  assert.deepEqual(toSettingsBody(draft).stages, approving.comb.stages, 'the saved stages come back as they were');
  const cleanup = toSettingsBody({ ...draft, stages: [{ ...draft.stages[2], approval: true }] });
  assert.equal('approval' in cleanup.stages![0], false, 'parseStage would refuse it next to the action');
});

test('a renamed source row (#278): savedName holds the loaded name, the body sends renames only for a saved row whose trimmed name changed, and the row\'s from / onStart and the transitions\' sources come out under the new name', () => {
  const saved = draftFrom(info(CONFIG));
  const [work] = saved.sources;
  assert.equal(work.savedName, 'work');
  assert.equal(emptySource().savedName, '', 'a new row was never saved');
  assert.deepEqual(toSettingsBody(saved).renames, {}, 'nothing renamed: always sent, empty');
  const added: SourceDraft = { ...emptySource(), name: 'notes' };
  const body = toSettingsBody({ ...saved, sources: [{ ...work, name: ' job ' }, added] });
  assert.deepEqual(body.renames, { work: 'job' }, 'trimmed; the new row is no rename');
  assert.deepEqual(body.stages?.map((c) => [c.from, c.onStart]), [
    [{ job: ['Backlog'] }, undefined],
    [{ job: ['Ready'] }, { job: [{ type: 'move', column: 'In progress' }] }],
    [{ job: ['Done'] }, undefined],
  ], 'the bindings follow the row, keyed by its id in the draft');
  const two = draftFrom(info(withSources([CONFIG.comb.sources[0], { name: 'notes', qualifyId: false, type: 'github', owner: 'acme', number: 7, filter: [], taskProps: FIXED, ...EPICS }])));
  const [a, b] = two.sources;
  assert.deepEqual(toSettingsBody({ ...two, sources: [{ ...a, name: 'notes' }, { ...b, name: 'work' }] }).renames, { work: 'notes', notes: 'work' }, 'a swap is sent as one map');
});

test('a workspace row carries its worktree setup as typed and its timeout per step as a timeout text; a blank field sends no key (#299, #511)', () => {
  const setup = 'COPY .env\nRUN pnpm install\n';
  const saved = draftFrom(info({ ...CONFIG, comb: { ...CONFIG.comb, workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup, setupTimeout: '5m' }] } }));
  assert.deepEqual(saved.workspaces.map(withoutId), [{ name: 'hive', path: '/repo', env: [], setup, setupTimeout: '5m', teardown: '', teardownTimeout: '', fork: null, baseBranch: '', memoryCap: '4000', benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', nestedRepos: [], notNestedRepos: [] }]);
  assert.deepEqual(toSettingsBody({ ...saved, workspaces: [{ ...saved.workspaces[0], setupTimeout: ' 10m ' }] }).workspaces, [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup, setupTimeout: '10m' }], 'as typed: the line numbers the server names are the textarea\'s');
  assert.deepEqual(toSettingsBody({ ...saved, workspaces: [{ ...saved.workspaces[0], setup: ' \n ', setupTimeout: '' }] }).workspaces, [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }]);
});

test('a timeout per step that is not a timeout text stops the save on workspaces, naming the workspace (#511)', () => {
  const draft = draftFrom(info(CONFIG));
  const bad = { ...draft, workspaces: [{ ...draft.workspaces[0], setupTimeout: '10' }] };
  assert.deepEqual(validateSettings(bad), { section: 'workspaces', message: t('settings.error.setupTimeout', { workspace: draft.workspaces[0].name }) });
});

test('a workspace row carries its env as rows in the saved order and sends it back as an object: a row left blank dropped, the name trimmed, the value as typed (#348)', () => {
  const env = { NODE_ENV: 'development', API_BASE: '/api' };
  const saved = draftFrom(info({ ...CONFIG, comb: { ...CONFIG.comb, workspaces: [{ ...CONFIG.comb.workspaces[0], env }] } }));
  const [hive] = saved.workspaces;
  assert.deepEqual(hive.env.map(withoutId), [{ name: 'NODE_ENV', value: 'development' }, { name: 'API_BASE', value: '/api' }]);
  assert.deepEqual(toSettingsBody(saved).workspaces[0].env, env, 'an untouched form saves the env it loaded');
  const typed = [...hive.env, { ...emptyEnvRow(), name: ' GREETING ', value: '  hi  ' }, emptyEnvRow(), { ...emptyEnvRow(), name: '  ' }];
  assert.deepEqual(toSettingsBody({ ...saved, workspaces: [{ ...hive, env: typed }] }).workspaces[0].env, { ...env, GREETING: '  hi  ' });
  assert.deepEqual([withoutId(emptyEnvRow()), emptyWorkspace().env], [{ name: '', value: '' }, []], 'a new row and a new workspace start empty');
  assert.notEqual(emptyEnvRow().id, emptyEnvRow().id, 'ids are unique per call');
});

test('filterOptionsUrl names a github row\'s owner, number and transport, and is undefined for a row not chosen (#245)', () => {
  const draft = draftFrom(info(CONFIG));
  const [row] = draft.sources;
  assert.equal(filterOptionsUrl(draft, row), '/settings/filter-options?owner=acme&number=6&auth=api');
  assert.equal(filterOptionsUrl({ auth: 'cli' }, { ...row, owner: ' @me ' }), '/settings/filter-options?owner=%40me&number=6&auth=cli');
  for (const unchosen of [{ ...row, number: '' }, { ...row, owner: ' ' }]) {
    assert.equal(filterOptionsUrl(draft, unchosen), undefined, JSON.stringify(unchosen));
  }
});

test('validateSettings refuses a github row\'s rule with no values or a projectField rule with no field, naming the source and the rule (#245)', () => {
  setLanguage('en');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const [row] = valid.sources;
  const withRules = (filter: FilterRule[]): SettingsDraft => ({ ...valid, sources: [{ ...row, filter }] });
  const blocked: FilterRule = { field: 'label', op: 'none', values: ['blocked'] };
  assert.equal(validateSettings(withRules([blocked])), undefined);
  assert.deepEqual(validateSettings(withRules([blocked, { field: 'assignee', op: 'any', values: [] }])), { section: 'flow', message: t('settings.filter.error', { source: 'work', n: 2 }) });
  assert.deepEqual(validateSettings(withRules([{ field: 'projectField', name: ' ', op: 'any', values: ['P0'] }])), { section: 'flow', message: t('settings.filter.error', { source: 'work', n: 1 }) });
  assert.equal(validateSettings({ ...withRules([{ field: 'label', op: 'any', values: [] }]), sources: [{ ...row, number: '', filter: [{ field: 'label', op: 'any', values: [] }] }] })?.message, t('settings.error.project'), 'the workspace is asked for first');
});

test('a stage\'s maxWorkers and a rule\'s stage round-trip through the draft: an empty field sends no key, 0 is kept (#475)', () => {
  const capped: Config = {
    ...CONFIG,
    comb: { ...CONFIG.comb, stages: CONFIG.comb.stages.map((s) => (s.name === 'dev' ? { ...s, maxWorkers: 0 } : s)) },
    usageRules: [...CONFIG.usageRules, { source: 'week', percent: 70, maxWorkers: 1, stage: 'dev' }],
  };
  const draft = draftFrom(info(capped));
  assert.deepEqual(draft.stages.map((s) => s.maxWorkers), ['', '0', '']);
  assert.deepEqual(draft.rules.map((r) => r.stage), ['', '', '', 'dev']);
  const body = toSettingsBody(draft);
  assert.deepEqual([body.stages, body.usageRules], [capped.comb.stages, capped.usageRules], 'an untouched form saves what it loaded');
  assert.equal('stage' in body.usageRules![0]!, false, 'a global rule sends no stage key');
  const cleared = toSettingsBody({ ...draft, stages: draft.stages.map((s) => ({ ...s, maxWorkers: ' ' })) });
  assert.equal(cleared.stages?.some((s) => 'maxWorkers' in s), false, 'an empty field is no cap: no key');
});

test('validateSettings refuses a stage cap that is not an integer ≥ 0, a rule naming no stage of the form and a stage rule with a signal, on their tabs (#475)', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], { ...valid.stages[1], maxWorkers: '-1' }] }), { section: 'flow', message: t('settings.stages.error', { n: 2 }) });
  assert.equal(validateSettings({ ...valid, stages: [{ ...valid.stages[0], maxWorkers: '0' }, valid.stages[1], valid.stages[2]] }), undefined, '0 pauses the stage');
  const rule = (stage: string, kind: 'maxWorkers' | 'signal' = 'maxWorkers', value = '1'): RuleDraft =>
    ({ ...emptyRule('week'), percent: '70', stage, kind, value });
  assert.equal(validateSettings({ ...valid, rules: [rule(''), rule('dev')] }), undefined);
  assert.deepEqual(validateSettings({ ...valid, rules: [rule('dev'), rule('deploy')] }), { section: 'rules', message: t('settings.rules.stageUnknown', { n: 2, source: t('settings.rules.measure.week'), stage: 'deploy' }) });
  assert.equal(validateSettings({ ...valid, rules: [rule('', 'signal', 'red')] }), undefined, 'a global rule keeps its signal');
});

test('the four sleep notice switches: on in a new form, read from the config, and always sent (#672)', () => {
  const fresh = draftFrom(undefined);
  assert.deepEqual([fresh.sleepNotice, fresh.sleepAutoNotice, fresh.sleepIdleNotice, fresh.sleepAllNotice], [true, true, true, true]);
  assert.deepEqual([draftFrom(info(CONFIG)).sleepIdleNotice, draftFrom(info(CONFIG)).sleepAllNotice], [false, false]);
  const body = toSettingsBody({ ...fresh, sleepAutoNotice: false });
  assert.deepEqual([body.sleepNotice, body.sleepAutoNotice, body.sleepIdleNotice, body.sleepAllNotice], [true, false, true, true]);
});

test('validateSettings refuses a commands stage with no command, on flow; a name the Comb lacks is the editor\'s to strike, not a refusal (#755)', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], { ...valid.stages[1], action: 'commands', commands: [] }] }), { section: 'flow', message: t('settings.stages.error', { n: 2 }) });
  assert.equal(validateSettings({ ...valid, stages: [valid.stages[0], { ...valid.stages[1], action: 'commands', commands: ['gone'] }] }), undefined);
});

test('validateSettings refuses a wait for CI under só estes with no check, and a wait the TIMEOUT grammar does not read; an empty wait is no limit (#834)', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const wait = { ...valid.stages[1], action: 'waitForCi' as const, ciChecks: 'list' as const, checks: ['build'], timeout: '60m' };
  const problem = { section: 'flow', message: t('settings.stages.error.ci', { n: 2 }) };
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], { ...wait, checks: [] }] }), problem);
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], { ...wait, timeout: '1d' }] }), problem);
  assert.equal(validateSettings({ ...valid, stages: [valid.stages[0], { ...wait, timeout: '' }] }), undefined);
  assert.equal(validateSettings({ ...valid, stages: [valid.stages[0], { ...wait, ciChecks: 'all', checks: [] }] }), undefined);
});

test('a workspace row keeps its fork and its own base branch through the draft; an empty base branch sends no key; a new row starts undecided (#854)', () => {
  const fork = { remote: 'upstream', pr: 'fork' as const, sync: 'manual' as const };
  const saved = draftFrom(info({ ...CONFIG, comb: { ...CONFIG.comb, workspaces: [{ name: 'hive', path: '/repo', env: {}, fork, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', baseBranch: 'devtest' }] } }));
  assert.deepEqual([saved.workspaces[0].fork, saved.workspaces[0].baseBranch], [fork, 'devtest']);
  assert.deepEqual(toSettingsBody(saved).workspaces, [{ name: 'hive', path: '/repo', env: {}, fork, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', baseBranch: 'devtest' }]);
  assert.deepEqual(toSettingsBody({ ...saved, workspaces: [{ ...saved.workspaces[0], fork: false, baseBranch: ' ' }] }).workspaces, [{ name: 'hive', path: '/repo', env: {}, fork: false, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }]);
  assert.deepEqual([emptyWorkspace().fork, emptyWorkspace().baseBranch], [null, '']);
});

test('a workspace\'s nested repos load as rows and save trimmed, an empty row dropped; the dismissed paths go back as they came (#653)', () => {
  const saved = draftFrom(info({ ...CONFIG, comb: { ...CONFIG.comb, workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: ['docs'], notNestedRepos: ['vendor'], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] } }));
  const [row] = saved.workspaces;
  assert.deepEqual([row.nestedRepos.map((r) => r.path), row.notNestedRepos], [['docs'], ['vendor']]);
  const rows = [...row.nestedRepos, { id: 'n2', path: ' ee ' }, { id: 'n3', path: ' ' }]; // `+ nested repo` leaves a blank row until it is typed in
  assert.deepEqual(toSettingsBody({ ...saved, workspaces: [{ ...row, nestedRepos: rows }] }).workspaces, [
    { name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: ['docs', 'ee'], notNestedRepos: ['vendor'], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' },
  ]);
});

test('a workspace row carries its benchmarkPrIn as the config holds it and always sends it; a new row starts at worktree (#477)', () => {
  const saved = draftFrom(info({ ...CONFIG, comb: { ...CONFIG.comb, workspaces: [{ ...CONFIG.comb.workspaces[0], benchmarkPrIn: 'checkout' }] } }));
  assert.equal(saved.workspaces[0].benchmarkPrIn, 'checkout');
  assert.equal(toSettingsBody(saved).workspaces[0].benchmarkPrIn, 'checkout');
  assert.equal(emptyWorkspace().benchmarkPrIn, 'worktree');
});

test('a workspace row keeps its memory total limit as typed through the draft and sends it as a number; a new row starts at 4000 (#73)', () => {
  const saved = draftFrom(info({ ...CONFIG, comb: { ...CONFIG.comb, workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 6000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] } }));
  assert.equal(saved.workspaces[0].memoryCap, '6000');
  assert.deepEqual(toSettingsBody({ ...saved, workspaces: [{ ...saved.workspaces[0], memoryCap: ' 12000 ' }] }).workspaces, [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 12000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }]);
  assert.equal(emptyWorkspace().memoryCap, '4000');
});

test('the form loads the saved transitions by stage id and sends them back; a broken one is refused on the flow section, named as the chart names it, with its id (#134, #918)', () => {
  const saved: Config = { ...CONFIG, comb: { ...CONFIG.comb, stages: [{ name: 'Build', from: {}, prompt: '/b' }], transitions: [{ from: 'Build', to: 'end', when: 'done' }] } };
  const draft = draftFrom(info(saved));
  assert.equal(draft.transitions[0].from, draft.stages[0].id);
  assert.deepEqual(toSettingsBody(draft).transitions, [{ from: 'Build', to: 'end', when: 'done' }]);
  const ends = { ...draft.transitions[0], to: 'gone' };
  const name = (to: string): string => `Build → ${to} · ${t('flow.trigger.done')}`;
  assert.deepEqual(validateSettings({ ...draft, transitions: [ends] }), { section: 'flow', message: t('settings.transitions.error.ends', { name: name(t('settings.stages.unnamed')), stage: 'Build' }), transition: ends.id });
  assert.deepEqual(validateSettings({ ...draft, stages: [{ ...draft.stages[0], approval: true }] }), { section: 'flow', message: t('settings.transitions.error.useApproved', { name: name(t('flow.end')), stage: 'Build' }), transition: draft.transitions[0].id });
});

const REPO_CONFIG: Config = { ...CONFIG, comb: { ...CONFIG.comb, createIn: 'work', sources: [{ ...CONFIG.comb.sources[0], repository: 'acme/app' }] } };

test('draftFrom keys createIn by its source\'s row; toSettingsBody sends it by the row\'s name, a rename included, with hiveSource and each repository (#846)', () => {
  const draft = draftFrom(info(REPO_CONFIG));
  assert.deepEqual([draft.hiveSource, draft.createIn, draft.sources[0].repository], [true, draft.sources[0].id, 'acme/app']);
  const body = toSettingsBody({ ...draft, sources: [{ ...draft.sources[0], name: 'job' }] });
  assert.deepEqual([body.hiveSource, body.createIn, body.sources?.[0].repository, body.renames], [true, 'job', 'acme/app', { work: 'job' }]);
  assert.equal('repository' in (toSettingsBody({ ...draft, createIn: 'hive', sources: [{ ...draft.sources[0], repository: '' }] }).sources?.[0] ?? {}), false, 'none sends no key');
  assert.deepEqual([draftFrom(info()).hiveSource, draftFrom(info()).createIn], [true, 'hive'], 'a new form: hive on, tasks created there');
});

test('validateSettings names each createIn rule on the flow section before the save (#846)', () => {
  setLanguage('en');
  const draft = draftFrom(info(REPO_CONFIG));
  const [work] = draft.sources;
  const problem = (key: Parameters<typeof t>[0]) => ({ section: 'flow', message: t(key) });
  assert.equal(validateSettings(draft), undefined);
  assert.deepEqual(validateSettings({ ...draft, createIn: 'hive', hiveSource: false }), problem('settings.error.createIn.hiveOff'));
  assert.deepEqual(validateSettings({ ...draft, sources: [{ ...work, repository: '' }] }), problem('settings.error.createIn.noRepository'));
  assert.deepEqual(validateSettings({ ...draft, createIn: 'a-removed-row' }), problem('settings.error.createIn.unknown'));
  assert.deepEqual(validateSettings({ ...draft, sources: [], createIn: 'hive', hiveSource: false }), problem('settings.error.hiveSource.noSource'));
});

test('the form no longer judges a memory total limit; withMemoryCap sets the cap the memory dialog saved on the row named so, the others and the draft given as they were (#115)', () => {
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const [hive] = valid.workspaces;
  assert.equal(validateSettings({ ...valid, workspaces: [{ ...hive, memoryCap: 'x' }] }), undefined, 'only the dialog edits it, and its route checks it');
  const web = { ...emptyWorkspace(), name: 'web', path: '/web' };
  const two = { ...valid, workspaces: [{ ...hive, name: ' hive ' }, web] };
  const next = withMemoryCap(two, 'hive', 6000);
  assert.deepEqual(next.workspaces.map((w) => w.memoryCap), ['6000', '4000']);
  assert.equal(next.workspaces[1], web, 'another row is the same object');
  assert.deepEqual(two.workspaces.map((w) => w.memoryCap), ['4000', '4000'], 'the draft given is not changed');
});

test('a renamed stage sends stageRenames and its stage rules under the new name; nothing renamed sends no key (#861)', () => {
  const saved = draftFrom(info({ ...CONFIG, usageRules: [{ source: 'hour', percent: 50, maxWorkers: 1, stage: 'dev' }] }));
  assert.equal('stageRenames' in toSettingsBody(saved), false);
  const renamed = { ...saved, stages: saved.stages.map((s) => (s.name === 'dev' ? { ...s, name: 'build' } : s)) };
  assert.equal(validateSettings(renamed), undefined, 'the rule follows the rename: no unknown stage');
  const body = toSettingsBody(renamed);
  assert.deepEqual(body.stageRenames, { dev: 'build' });
  assert.deepEqual(body.usageRules, [{ source: 'hour', percent: 50, maxWorkers: 1, stage: 'build' }]);
});

test('validateSettings refuses a stage that continues a session no earlier stage of its agent opened, on flow (#710)', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const first = { ...valid.stages[0], action: '' as const, prompt: '/x', agent: '' as const, session: 'continue' as const };
  assert.deepEqual(validateSettings({ ...valid, stages: [first] }), { section: 'flow', message: t('settings.stages.error.continue', { n: 1, agent: 'claude' }) });
  const second = { ...first, id: 'second', name: 'second' };
  assert.equal(validateSettings({ ...valid, stages: [{ ...first, session: 'new' }, second] }), undefined);
  assert.deepEqual(validateSettings({ ...valid, stages: [{ ...first, session: 'new' }, { ...second, agent: 'codex' }] }), { section: 'flow', message: t('settings.stages.error.continue', { n: 2, agent: 'codex' }) });
});

test('validateSettings refuses a skill stage with no skill, on flow (#710)', () => {
  setLanguage('pt');
  const valid = { ...draftFrom(info(CONFIG)), transitions: [] };
  const skill = { ...valid.stages[1], action: 'skill' as const, skill: '' };
  assert.deepEqual(validateSettings({ ...valid, stages: [valid.stages[0], skill] }), { section: 'flow', message: t('settings.stages.error.skill', { n: 2 }) });
  assert.equal(validateSettings({ ...valid, stages: [valid.stages[0], { ...skill, skill: 'new-plan' }] }), undefined);
});
