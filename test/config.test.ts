import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { taskWorkspace, loadConfig, loadConfigIfPresent, parseConfig, predatesComb, workspaceByName, workspaceScope, requireWorkspace, unnamedWorkspacePath } from '../src/config.js';
import { type LegacyStage, transitionsOf } from '../src/config-migrate.js';
import { SHORTCUTS } from '../src/shortcut-registry.js';
import type { SourceTaskProps, Config } from '../src/types.js';
import { MCP_DEFAULTS, EDITOR_DEFAULTS, REVIEWER_DEFAULTS, SIGNALS_DEFAULTS, APPROVAL_MINUTES_DEFAULT, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RESERVED_ENV_NAMES, SHUTDOWN_IDLE_DEFAULT, WORKSPACE_PRESET_COLORS } from '../src/types.js';
import { sourceEntry, FIXED, STAGES, FILTER, LOCAL_STAGES, chained, combConfig, move, EPICS } from './fakes.js';
import { tempDir } from './temp-dir.js';

const GITHUB_SOURCE = { type: 'github', owner: '@me', number: 6, filter: FILTER };
/** A raw file with a GitHub Comb; `extra` goes through combConfig (board, columns, prefix, path, workspaces, or any top-level key). */
const github = (extra: Record<string, unknown> = {}) => combConfig({ source: GITHUB_SOURCE, ...extra });
const GITHUB = github();
const FRONT = { name: 'Run Frontend', impls: [{ workspace: 'hive', command: 'pnpm run dev -- --port $PORT' }], menu: true, env: { PORT: '5173' } };
const DYNAMIC: SourceTaskProps = { defaults: { auto: true }, rules: [{ field: 'title', op: 'icontains', value: '[site]', set: { workspace: 'site' } }] };
const TWO = [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 70)' }];

test('parseConfig applies defaults on top of a minimal config', () => {
  const config = parseConfig({ ...GITHUB });
  assert.equal('maxConcurrent' in config, false, 'the state owns the cap (#727)');
  assert.equal('port' in config, false, 'the daemon binds a free port (#466): no setting');
  assert.deepEqual(config.agentArgs, { claude: [], codex: [] });
  assert.deepEqual(config.budget, {});
  assert.deepEqual(config.usageRules, []);
  assert.equal('epics' in config, false, 'the epics keys live on each source (#30)');
  assert.equal(config.logLevel, 'info');
});

test('parseConfig reads stages[].action and after, keeps them absent when unset and rejects the bad ones naming the index', () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'done', from: { board: ['Done'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  assert.equal(parsed({ action: 'deleteActivity' }).action, 'deleteActivity');
  assert.deepEqual(
    parsed({ action: 'deleteActivity', after: '5d', session: 'continue', model: 'opus' }),
    { name: 'done', from: { board: ['Done'] }, session: 'continue', model: 'opus', action: 'deleteActivity', after: '5d' },
    'session and model next to an action are accepted as written: the form hides them, nothing reads them',
  );
  for (const after of ['5d', '12h', '30m', '1m', '100d']) assert.equal(parsed({ after }).after, after, after);
  const plain = parsed({});
  assert.deepEqual(['action' in plain, 'after' in plain], [false, false], 'absent stays absent: the file stays clean');
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  assert.throws(bad({ action: 'other' }), { message: 'hive.config.json: "comb.stages[0].action" must be "deleteActivity", "commands", "waitForCi", "skill" or "evaluate"' });
  assert.throws(bad({ action: 1 }), /comb\.stages\[0\]\.action/);
  assert.throws(bad({ action: 'deleteActivity', prompt: '/x' }), { message: 'hive.config.json: "comb.stages[0].action" cannot be combined with "prompt"' });
  for (const after of ['5', '0d', '5 d', '1w', '', '05d', '1.5h', '1H', 5, null]) {
    assert.throws(bad({ after }), { message: 'hive.config.json: "comb.stages[0].after" must be a duration like "30m", "12h" or "5d"' }, JSON.stringify(after));
  }
});

test('parseConfig refuses a stage whose action is still delete activity, naming deleteActivity, and reads deleteActivity (#573)', () => {
  const stage = (action: string) => ({ name: 'done', from: { board: ['Done'] }, action });
  assert.throws(() => parseConfig(github({ stages: [stage('cleanup')] })), { message: 'hive.config.json: "comb.stages[0].action" must be "deleteActivity", "commands", "waitForCi", "skill" or "evaluate"' }); // #573: the old name, on purpose
  assert.equal(parseConfig(github({ stages: [stage('deleteActivity')] })).comb.stages[0].action, 'deleteActivity');
});

test('parseConfig reads a commands stage: its names trimmed, in order, and its switch; refuses either key without the action, a missing, empty or repeated list, and every agent key beside it (#755)', () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'checks', from: { board: ['Checks'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  const ok = { action: 'commands', commands: [' build ', 'lint', 'hive test'], stopOnFailure: true, onMissing: 'fail' };
  assert.deepEqual(parsed(ok), { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build', 'lint', 'hive test'], stopOnFailure: true, onMissing: 'fail' });
  assert.deepEqual(parsed({ ...ok, commands: ['gone'], stopOnFailure: false, onMissing: 'skip' }), { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['gone'], stopOnFailure: false, onMissing: 'skip' }, 'a name the Comb does not have is checked when the stage runs');
  const list = '"comb.stages[0].commands" must be a non-empty array of distinct command names';
  const refused: [Record<string, unknown>, string][] = [
    [{ commands: ['build'] }, '"comb.stages[0].commands" needs "action": "commands"'],
    [{ stopOnFailure: true }, '"comb.stages[0].stopOnFailure" needs "action": "commands"'],
    [{ action: 'deleteActivity', commands: ['build'] }, '"comb.stages[0].commands" needs "action": "commands"'],
    [{ onMissing: 'skip' }, '"comb.stages[0].onMissing" needs "action": "commands"'],
    [{ action: 'deleteActivity', onMissing: 'fail' }, '"comb.stages[0].onMissing" needs "action": "commands"'],
    [{ ...ok, onMissing: undefined }, '"comb.stages[0].onMissing" must be "fail" or "skip"'],
    [{ ...ok, onMissing: 'ignore' }, '"comb.stages[0].onMissing" must be "fail" or "skip"'],
    [{ action: 'commands', stopOnFailure: true, onMissing: 'fail' }, list],
    [{ ...ok, commands: [] }, list],
    [{ ...ok, commands: ['build', ' build'] }, list],
    [{ ...ok, commands: ['build', ' '] }, list],
    [{ ...ok, commands: 'build' }, list],
    [{ ...ok, commands: ['build', 7] }, list],
    [{ action: 'commands', commands: ['build'], onMissing: 'fail' }, '"comb.stages[0].stopOnFailure" must be true or false'],
    [{ ...ok, stopOnFailure: 'yes' }, '"comb.stages[0].stopOnFailure" must be true or false'],
    [{ ...ok, prompt: '/x' }, '"comb.stages[0].action" cannot be combined with "prompt"'],
    [{ ...ok, approval: true }, '"comb.stages[0].approval" cannot be combined with "action"'],
    [{ ...ok, agent: 'claude' }, '"comb.stages[0].agent" cannot be combined with "action"'],
    [{ ...ok, handoff: true }, '"comb.stages[0].handoff" cannot be combined with "action"'],
    [{ ...ok, model: 'opus' }, '"comb.stages[0].model" cannot be combined with "action": "commands"'],
    [{ ...ok, session: 'new' }, '"comb.stages[0].session" cannot be combined with "action": "commands"'],
  ];
  for (const [extra, message] of refused) assert.throws(bad(extra), { message: `hive.config.json: ${message}` }, JSON.stringify(extra));
});

test('parseConfig reads stages[].approval as a boolean kept only when true, and refuses it next to an action (#268)', () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'spec', from: { board: ['Ready'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  assert.equal(parsed({ prompt: '/x', approval: true }).approval, true);
  assert.equal('approval' in parsed({ prompt: '/x', approval: false }), false, 'false is no key: the file stays clean');
  assert.equal('approval' in parsed({ prompt: '/x' }), false);
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  assert.throws(bad({ action: 'deleteActivity', approval: true }), { message: 'hive.config.json: "comb.stages[0].approval" cannot be combined with "action"' });
  assert.throws(bad({ prompt: '/x', approval: 'yes' }), { message: 'hive.config.json: "comb.stages[0].approval" must be true or false' });
});

test('parseConfig reads stages[].handoff as a boolean kept only when true, and refuses it next to an action or a continued session (#692)', () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'plan', from: { board: ['Ready'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  assert.equal(parsed({ prompt: '/x', handoff: true }).handoff, true);
  assert.equal(parsed({ prompt: '/x', session: 'new', handoff: true }).handoff, true);
  assert.equal('handoff' in parsed({ prompt: '/x', handoff: false }), false, 'false is no key: the file stays clean');
  assert.equal('handoff' in parsed({ prompt: '/x' }), false);
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  assert.throws(bad({ action: 'deleteActivity', handoff: true }), { message: 'hive.config.json: "comb.stages[0].handoff" cannot be combined with "action"' });
  assert.throws(bad({ prompt: '/x', session: 'continue', handoff: true }), { message: 'hive.config.json: "comb.stages[0].handoff" cannot be combined with "session": "continue"' });
  assert.throws(bad({ handoff: true }), { message: 'hive.config.json: "comb.stages[0].handoff" cannot be used without "prompt"' });
  assert.throws(bad({ prompt: '/x', handoff: 'yes' }), { message: 'hive.config.json: "comb.stages[0].handoff" must be true or false' });
});

test('parseConfig reads stages[].clearSession as a boolean kept only when true, on a prompt or a skill stage, a continued session included; refused next to a Hive action and on a stage that runs no agent (#494)', () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'spec', from: { board: ['Ready'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  assert.equal(parsed({ prompt: '/x', clearSession: true }).clearSession, true);
  assert.equal(parsed({ action: 'skill', skill: 'new-spec', clearSession: true }).clearSession, true);
  assert.equal(parsed({ prompt: '/x', session: 'continue', clearSession: true }).clearSession, true, 'it resumes the previous session and clears it when done');
  assert.equal('clearSession' in parsed({ prompt: '/x', clearSession: false }), false, 'false is no key: the file stays clean');
  assert.equal('clearSession' in parsed({ prompt: '/x' }), false);
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  for (const action of ['deleteActivity', 'commands', 'waitForCi', 'evaluate']) {
    assert.throws(bad({ action, clearSession: true }), { message: 'hive.config.json: "comb.stages[0].clearSession" cannot be combined with "action"' }, action);
  }
  assert.throws(bad({ clearSession: true }), { message: 'hive.config.json: "comb.stages[0].clearSession" cannot be used without "prompt"' });
  assert.throws(bad({ approval: true, clearSession: true }), { message: 'hive.config.json: "comb.stages[0].clearSession" cannot be used without "prompt"' }, 'a gate never spawns');
  assert.throws(bad({ prompt: '/x', clearSession: 'yes' }), { message: 'hive.config.json: "comb.stages[0].clearSession" must be true or false' });
});

test('parseConfig refuses a transition that resumes the session of a stage with clearSession; a new session out of it parses (#494)', () => {
  const stages = [{ name: 'spec', from: { board: ['Ready'] }, prompt: '/spec', clearSession: true }, { name: 'plan', from: {}, prompt: '/plan' }];
  const config = (session: unknown) => github({ stages, transitions: [{ from: 'spec', to: 'plan', when: 'done', session }] });
  assert.throws(() => parseConfig(config('previous')), { message: 'hive.config.json: "comb.transitions[0].session" resumes the session of "spec", which clears it when it ends (#494)' });
  assert.doesNotThrow(() => parseConfig(config('new')));
});

test('parseConfig reads no terminal key: a file that still holds one parses as if it had none, and the config carries none (#378)', () => {
  const leftover = parseConfig({ ...GITHUB, terminal: 'internal' });
  assert.equal('terminal' in leftover, false);
  assert.deepEqual(leftover, parseConfig(GITHUB));
});

test('a GitHub source requires epics, epicFollows and switchAt, naming the field; an unknown value is refused (#30)', () => {
  const source = (patch: Record<string, unknown>) => () => parseConfig(github({ source: { ...GITHUB_SOURCE, ...patch } }));
  const missing: [string, string][] = [
    ['epics', '"comb.sources[0].epics" must be one of: ignore, show, hide'],
    ['epicFollows', '"comb.sources[0].epicFollows" must be one of: behind, ahead, aheadThenBehind'],
    ['switchAt', '"comb.sources[0].switchAt" is required'],
  ];
  for (const [key, message] of missing) assert.throws(source({ [key]: undefined }), { message: `hive.config.json: ${message}` }, `${key} missing`);
  assert.throws(source({ epics: 'queue' }), { message: 'hive.config.json: "comb.sources[0].epics" must be one of: ignore, show, hide' }, 'the old mode');
  assert.throws(source({ epicFollows: 'middle' }), { message: 'hive.config.json: "comb.sources[0].epicFollows" must be one of: behind, ahead, aheadThenBehind' });
  assert.throws(source({ switchAt: '' }), { message: 'hive.config.json: "comb.sources[0].switchAt" must be a non-empty string' });
  assert.throws(source({ switchAt: 3 }), { message: 'hive.config.json: "comb.sources[0].switchAt" must be a non-empty string' });
});

test('a switchAt that is no stage of the flow is refused, compared exactly; a valid source round-trips its three keys (#30)', () => {
  assert.throws(() => parseConfig(github({ source: { ...GITHUB_SOURCE, switchAt: 'Build' } })), { message: 'hive.config.json: "comb.sources[0].switchAt" is "Build", which is not a stage of the flow' });
  assert.throws(() => parseConfig(github({ source: { ...GITHUB_SOURCE, switchAt: 'Fila' } })), /"comb\.sources\[0\]\.switchAt" is "Fila"/, 'compared exactly');
  const [source] = parseConfig(github({ source: { ...GITHUB_SOURCE, epics: 'hide', epicFollows: 'behind', switchAt: 'fila' } })).comb.sources;
  assert.deepEqual([source.epics, source.epicFollows, source.switchAt], ['hide', 'behind', 'fila']);
  for (const epics of ['ignore', 'show', 'hide']) assert.equal(parseConfig(github({ source: { ...GITHUB_SOURCE, epics } })).comb.sources[0].epics, epics);
});

test('a top-level epics is refused, saying it moved into each source and how the values changed (#30)', () => {
  const message = 'hive.config.json: "epics" moved into each source (comb.sources[].epics); the old "ignore" is now "hide" and the old "queue" is now "ignore"';
  for (const epics of ['ignore', 'queue']) assert.throws(() => parseConfig({ ...GITHUB, epics }), { message }, epics);
});

test('parseConfig accepts logLevel warn, info or debug and rejects anything else, error included (#742)', () => {
  assert.equal(parseConfig({ ...GITHUB, logLevel: 'warn' }).logLevel, 'warn');
  assert.equal(parseConfig({ ...GITHUB, logLevel: 'debug' }).logLevel, 'debug');
  assert.equal(parseConfig({ ...GITHUB, logLevel: 'info' }).logLevel, 'info');
  assert.throws(() => parseConfig({ ...GITHUB, logLevel: 'error' }), { message: 'hive.config.json: "logLevel" must be one of: warn, info, debug' });
  assert.throws(() => parseConfig({ ...GITHUB, logLevel: 'trace' }), /"logLevel" must be one of: warn, info, debug/);
  assert.throws(() => parseConfig({ ...GITHUB, logLevel: true }), /"logLevel" must be one of: warn, info, debug/);
});

test('parseConfig accepts language pt or en, leaves the key absent when unset and rejects anything else', () => {
  assert.equal(parseConfig({ ...GITHUB, language: 'en' }).language, 'en');
  assert.equal(parseConfig({ ...GITHUB, language: 'pt' }).language, 'pt');
  assert.equal('language' in parseConfig({ ...GITHUB }), false, 'absent stays absent so writeConfigFile keeps the file clean');
  assert.throws(() => parseConfig({ ...GITHUB, language: 'fr' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ ...GITHUB, language: 'pt-BR' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ ...GITHUB, language: true }), /"language" must be one of: pt, en/);
});

test('parseConfig keeps a baseBranch, leaves the key out when absent or empty, and names the field on a non-string', () => {
  assert.equal(parseConfig({ ...GITHUB, baseBranch: 'develop' }).baseBranch, 'develop');
  assert.equal('baseBranch' in parseConfig({ ...GITHUB }), false, 'absent = automatic: the remote decides');
  assert.equal('baseBranch' in parseConfig({ ...GITHUB, baseBranch: '' }), false, 'a cleared form field is automatic, not an error');
  assert.throws(() => parseConfig({ ...GITHUB, baseBranch: 7 }), { message: 'hive.config.json: "baseBranch" must be a non-empty string' });
  assert.throws(() => parseConfig({ ...GITHUB, baseBranch: null }), /"baseBranch"/);
});

test('parseConfig refuses a baseBranch that is not a branch name: a leading dash is an option to git, not a ref', () => {
  // `fetch origin --upload-pack=<cmd>` runs <cmd> when origin resolves locally; the boundary refuses the value instead.
  for (const bad of ['--upload-pack=touch /tmp/x', '-main', 'a branch', 'main;id', '..', 'main..dev', 'main~1', 'refs^']) {
    assert.throws(() => parseConfig({ ...GITHUB, baseBranch: bad }), { message: 'hive.config.json: "baseBranch" must be a branch name' }, bad);
  }
  for (const ok of ['main', 'master', 'develop', 'release/2.0', 'v1.2.3', 'feature_x', '0.x']) {
    assert.equal(parseConfig({ ...GITHUB, baseBranch: ok }).baseBranch, ok, ok);
  }
});

test('parseConfig requires onClose, menuBar or quit, with no default, and names the key (#513)', () => {
  assert.equal(parseConfig(GITHUB).onClose, 'menuBar', 'what combConfig writes: the form default');
  assert.equal(parseConfig({ ...GITHUB, onClose: 'quit' }).onClose, 'quit');
  const message = 'hive.config.json: "onClose" must be one of: menuBar, quit';
  for (const bad of [undefined, 'stop', true, null]) assert.throws(() => parseConfig({ ...GITHUB, onClose: bad }), { message }, JSON.stringify(bad));
});

test('parseConfig requires deleteActivity and its three switches with no default, accepts every switch off, and refuses transcripts without the sessions, a worktree or a branch switch and the old delete activity key (#236, #496, #573)', () => {
  assert.deepEqual(parseConfig(GITHUB).deleteActivity, DELETE_ACTIVITY_DEFAULTS, 'what combConfig writes: the form defaults');
  assert.deepEqual(parseConfig({ ...GITHUB, deleteActivity: { session: false, transcripts: false, nonAutoTasks: false } }).deleteActivity, { session: false, transcripts: false, nonAutoTasks: false }, 'every switch off: the worktree and the branch still go');
  const scope = { session: true, transcripts: true, nonAutoTasks: true };
  assert.deepEqual(parseConfig({ ...GITHUB, deleteActivity: scope }).deleteActivity, scope, 'a valid scope round-trips');
  const refused: [unknown, string][] = [
    [undefined, '"deleteActivity" must be an object with session, transcripts, nonAutoTasks'],
    [{ ...DELETE_ACTIVITY_DEFAULTS, session: undefined }, '"deleteActivity.session" must be true or false'],
    [{ ...DELETE_ACTIVITY_DEFAULTS, nonAutoTasks: 'yes' }, '"deleteActivity.nonAutoTasks" must be true or false'],
    [{ ...DELETE_ACTIVITY_DEFAULTS, transcripts: true }, '"deleteActivity.transcripts" needs "deleteActivity.session"'],
    [{ ...DELETE_ACTIVITY_DEFAULTS, worktree: false }, 'deleteActivity always removes the worktree and the branch'],
    [{ ...DELETE_ACTIVITY_DEFAULTS, branch: true }, 'deleteActivity always removes the worktree and the branch'],
  ];
  for (const [deleteActivity, message] of refused) {
    assert.throws(() => parseConfig({ ...GITHUB, deleteActivity }), { message: `hive.config.json: ${message}` }, JSON.stringify(deleteActivity));
  }
  assert.throws(() => parseConfig({ ...GITHUB, cleanup: DELETE_ACTIVITY_DEFAULTS }), { message: 'hive.config.json: "cleanup" is now "deleteActivity"' }, 'no legacy path: the one file is fixed by hand'); // #573: the old key, on purpose
});

test('parseConfig requires shutdownIdleMinutes, an integer from 1 to 1440, with no default (#233)', () => {
  assert.equal(parseConfig(GITHUB).shutdownIdleMinutes, SHUTDOWN_IDLE_DEFAULT, 'what combConfig writes: the form default');
  for (const ok of [1, 1440]) assert.equal(parseConfig({ ...GITHUB, shutdownIdleMinutes: ok }).shutdownIdleMinutes, ok, String(ok));
  const message = 'hive.config.json: "shutdownIdleMinutes" must be an integer from 1 to 1440';
  for (const bad of [undefined, 0, 1441, 1.5, '10', null]) {
    assert.throws(() => parseConfig({ ...GITHUB, shutdownIdleMinutes: bad }), { message }, JSON.stringify(bad));
  }
});

test('parseConfig requires approvalMinutes, an integer from 1 to 120, with no default (#268)', () => {
  assert.equal(parseConfig(GITHUB).approvalMinutes, APPROVAL_MINUTES_DEFAULT, 'what combConfig writes: the form default');
  for (const ok of [1, 120]) assert.equal(parseConfig({ ...GITHUB, approvalMinutes: ok }).approvalMinutes, ok, String(ok));
  const message = 'hive.config.json: "approvalMinutes" must be an integer from 1 to 120';
  for (const bad of [undefined, 0, 121, 1.5, '10', null]) {
    assert.throws(() => parseConfig({ ...GITHUB, approvalMinutes: bad }), { message }, JSON.stringify(bad));
  }
});

test('parseConfig requires rateLimitWaitMinutes, an integer from 1 to 10080, with no default (#805)', () => {
  assert.equal(parseConfig(GITHUB).rateLimitWaitMinutes, RATE_LIMIT_WAIT_DEFAULT, 'what combConfig writes: the form default');
  for (const ok of [1, 10_080]) assert.equal(parseConfig({ ...GITHUB, rateLimitWaitMinutes: ok }).rateLimitWaitMinutes, ok, String(ok));
  const message = 'hive.config.json: "rateLimitWaitMinutes" must be an integer from 1 to 10080';
  for (const bad of [undefined, 0, 10_081, 1.5, '300', null]) {
    assert.throws(() => parseConfig({ ...GITHUB, rateLimitWaitMinutes: bad }), { message }, JSON.stringify(bad));
  }
});

test('parseConfig ignores ide, retired with the external IDE (#818): a file that still holds it parses, without the key', () => {
  assert.equal('ide' in parseConfig({ ...GITHUB, ide: 'zed' }), false);
  assert.equal('ide' in parseConfig(GITHUB), false);
});

test('parseConfig requires showGithubQuota, a boolean with no default', () => {
  assert.equal(parseConfig(GITHUB).showGithubQuota, false, 'what combConfig writes: the form default');
  assert.equal(parseConfig({ ...GITHUB, showGithubQuota: true }).showGithubQuota, true);
  for (const bad of [undefined, 'true', 1, null]) assert.throws(() => parseConfig({ ...GITHUB, showGithubQuota: bad }), /"showGithubQuota"/, JSON.stringify(bad));
});

test('parseConfig requires closeSessionTab and closeStageTab (keep or sleep) and their notice switches (booleans), with no default; the keys before them are ignored (#614)', () => {
  const parsed = parseConfig(GITHUB);
  const four = (c: Config): unknown[] => [c.closeSessionTab, c.closeStageTab, c.closeSessionTabNotice, c.closeStageTabNotice];
  assert.deepEqual(four(parsed), ['keep', 'keep', true, true], 'what combConfig writes: the form defaults');
  assert.deepEqual(four(parseConfig({ ...GITHUB, closeSessionTab: 'sleep', closeStageTab: 'sleep', closeSessionTabNotice: false, closeStageTabNotice: false })), ['sleep', 'sleep', false, false]);
  for (const key of ['closeSessionTab', 'closeStageTab']) {
    for (const bad of [undefined, 'end', 'pause', 'SLEEP', true, null]) {
      assert.throws(() => parseConfig({ ...GITHUB, [key]: bad }), { message: `hive.config.json: "${key}" must be one of: keep, sleep` }, `${key} ${JSON.stringify(bad)}`);
    }
  }
  for (const key of ['closeSessionTabNotice', 'closeStageTabNotice']) {
    for (const bad of [undefined, 'true', 1, null]) {
      assert.throws(() => parseConfig({ ...GITHUB, [key]: bad }), { message: `hive.config.json: "${key}" must be true or false` }, `${key} ${JSON.stringify(bad)}`);
    }
  }
  const old = parseConfig({ ...GITHUB, closeTabEndsSession: true, closeTabEndsStageSession: 'yes' });
  assert.equal('closeTabEndsSession' in old || 'closeTabEndsStageSession' in old, false, 'an old key is neither read nor refused');
});

test('parseConfig requires agentArgs, one array of strings per agent, and names a missing agent, a non-array value and an unknown key (#924, #927)', () => {
  assert.deepEqual(parseConfig(GITHUB).agentArgs, { claude: [], codex: [] }, 'what combConfig writes: the form default');
  const both = { claude: ['--permission-mode', 'auto', 'a b'], codex: ['--sandbox', 'workspace-write'] };
  assert.deepEqual(parseConfig({ ...GITHUB, agentArgs: both }).agentArgs, both);
  const notList = 'hive.config.json: "agentArgs.claude" must be an array of strings';
  for (const bad of [undefined, {}, { claude: 'x' }, { claude: [1] }, { claude: null }]) {
    assert.throws(() => parseConfig({ ...GITHUB, agentArgs: bad }), { message: notList }, JSON.stringify(bad));
  }
  assert.throws(() => parseConfig({ ...GITHUB, agentArgs: { claude: [] } }), { message: 'hive.config.json: "agentArgs.codex" must be an array of strings' });
  assert.throws(() => parseConfig({ ...GITHUB, agentArgs: { claude: [], codex: [], gemini: [] } }), { message: 'hive.config.json: "agentArgs" has an unknown agent "gemini"' });
});

test('parseConfig requires agentModels, null or a model name per agent, and refuses a stray agent, a bad name and a Claude model as Codex\'s default (#482)', () => {
  assert.deepEqual(parseConfig(GITHUB).agentModels, { claude: null, codex: null }, 'what combConfig writes: the form default');
  const both = { claude: 'opus', codex: 'gpt-5.6-terra' };
  assert.deepEqual(parseConfig({ ...GITHUB, agentModels: both }).agentModels, both);
  for (const bad of ['', '-x', 3, ['opus']]) {
    assert.throws(() => parseConfig({ ...GITHUB, agentModels: { claude: bad, codex: null } }), { message: 'hive.config.json: "agentModels.claude" must be null or a model name' }, JSON.stringify(bad));
  }
  assert.throws(() => parseConfig({ ...GITHUB, agentModels: { claude: null } }), { message: 'hive.config.json: "agentModels.codex" must be null or a model name' });
  assert.throws(() => parseConfig({ ...GITHUB, agentModels: { claude: null, codex: null, gemini: null } }), { message: 'hive.config.json: "agentModels" has an unknown agent "gemini"' });
  assert.throws(() => parseConfig({ ...GITHUB, agentModels: { claude: null, codex: 'opus' } }), { message: 'hive.config.json: "agentModels.codex" "opus" is a Claude model; codex needs a Codex model name' });
});

test('parseConfig requires agentEnabled, true or false per agent; the default agent cannot be off, nor can a stage or an evaluation row name an agent that is (#482)', () => {
  assert.deepEqual(parseConfig(GITHUB).agentEnabled, { claude: true, codex: true });
  const off = { claude: true, codex: false };
  assert.deepEqual(parseConfig({ ...GITHUB, agentEnabled: off }).agentEnabled, off);
  assert.throws(() => parseConfig({ ...GITHUB, agentEnabled: { claude: 'yes', codex: true } }), { message: 'hive.config.json: "agentEnabled.claude" must be true or false' });
  assert.throws(() => parseConfig({ ...GITHUB, agentEnabled: { claude: true, codex: true, gemini: true } }), { message: 'hive.config.json: "agentEnabled" has an unknown agent "gemini"' });
  assert.throws(() => parseConfig({ ...GITHUB, agentEnabled: { claude: false, codex: true } }), { message: 'hive.config.json: "agentEnabled.claude" cannot be false: claude is the default agent' });
  const stage = (extra: Record<string, unknown>) => ({ name: 'spec', from: { board: ['Ready'] }, ...extra });
  const codexOff = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)], agentEnabled: off }));
  assert.throws(codexOff({ prompt: '/x', agent: 'codex' }), { message: 'hive.config.json: "comb.stages[0].agent" names codex, which "agentEnabled" turns off' });
  const evaluate = { action: 'evaluate', threshold: 3, rubric: 'Good?' };
  assert.throws(codexOff({ ...evaluate, reviewers: [{ agent: 'claude', focus: 'a' }, { agent: 'codex', focus: 'b' }], judge: { agent: 'claude' } }), { message: 'hive.config.json: "comb.stages[0].reviewers[1].agent" names codex, which "agentEnabled" turns off' });
  assert.throws(codexOff({ ...evaluate, reviewers: [], judge: { agent: 'codex' } }), { message: 'hive.config.json: "comb.stages[0].judge.agent" names codex, which "agentEnabled" turns off' });
  assert.doesNotThrow(codexOff({ prompt: '/x' }), 'no own agent: the default, always on');
});

test('parseConfig requires defaultAgent, one of the known agents, with no default (#516)', () => {
  assert.equal(parseConfig(GITHUB).defaultAgent, 'claude', 'what combConfig writes: the form default');
  for (const bad of [undefined, 'gemini', '', 1, null]) {
    assert.throws(() => parseConfig({ ...GITHUB, defaultAgent: bad }), { message: 'hive.config.json: "defaultAgent" must be one of: claude, codex' }, JSON.stringify(bad));
  }
});

test("parseConfig reads a stage's agent: kept when known, absent stays absent, unknown or next to an action refused by field (#516)", () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'dev', from: { board: ['Ready'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  assert.equal(parsed({ prompt: '/x', agent: 'claude' }).agent, 'claude');
  assert.equal('agent' in parsed({ prompt: '/x' }), false, 'absent = the default agent; the file stays clean');
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  assert.throws(bad({ prompt: '/x', agent: 'gemini' }), { message: 'hive.config.json: "comb.stages[0].agent" must be one of: claude, codex' });
  assert.throws(bad({ action: 'deleteActivity', agent: 'claude' }), { message: 'hive.config.json: "comb.stages[0].agent" cannot be combined with "action"' });
});

test('parseConfig requires theme, one of system, light or dark, with no default (#296)', () => {
  assert.equal(parseConfig(GITHUB).theme, 'system', 'what combConfig writes: the form default');
  for (const theme of ['system', 'light', 'dark']) assert.equal(parseConfig({ ...GITHUB, theme }).theme, theme, theme);
  const message = 'hive.config.json: "theme" must be one of: system, light, dark';
  for (const bad of [undefined, 'sepia', 'Dark', '', 1, null]) assert.throws(() => parseConfig({ ...GITHUB, theme: bad }), { message }, JSON.stringify(bad));
});

test('parseConfig requires terminalFont, one trimmed family name with "" for the system monospace, and refuses what would break its quotes (#376)', () => {
  assert.equal(parseConfig(GITHUB).terminalFont, '', 'what combConfig writes: the form default');
  assert.equal(parseConfig({ ...GITHUB, terminalFont: '  MesloLGS NF ' }).terminalFont, 'MesloLGS NF');
  assert.equal(parseConfig({ ...GITHUB, terminalFont: '   ' }).terminalFont, '', 'blank is the system monospace');
  const missing = 'hive.config.json: "terminalFont" must be a string ("" = the system monospace)';
  for (const bad of [undefined, 1, null, ['MesloLGS NF']]) assert.throws(() => parseConfig({ ...GITHUB, terminalFont: bad }), { message: missing }, JSON.stringify(bad));
  const unsafe = 'hive.config.json: "terminalFont" must be one font family name, without ", \\ or control characters';
  for (const bad of ['Meslo"NF', 'Meslo\\NF', 'Meslo\nNF', 'Meslo\u0007NF', 'Meslo\u007fNF']) assert.throws(() => parseConfig({ ...GITHUB, terminalFont: bad }), { message: unsafe }, JSON.stringify(bad));
});

test('parseConfig requires consoleLines, a whole number of lines from 100 to 100000, and names it otherwise (#353)', () => {
  assert.equal(parseConfig(GITHUB).consoleLines, 5000, 'what combConfig writes: the form default');
  assert.equal(parseConfig({ ...GITHUB, consoleLines: 100 }).consoleLines, 100);
  assert.equal(parseConfig({ ...GITHUB, consoleLines: 100_000 }).consoleLines, 100_000);
  const message = 'hive.config.json: "consoleLines" must be an integer from 100 to 100000';
  for (const bad of [undefined, 99, 100_001, 1.5, '5000', null]) assert.throws(() => parseConfig({ ...GITHUB, consoleLines: bad }), { message }, String(bad));
});

test('parseConfig requires trustedDomains, an array of bare hosts, trimmed, lowercased and without duplicates; [] is every link asking (#404)', () => {
  assert.deepEqual(parseConfig(GITHUB).trustedDomains, [], 'what combConfig writes: the form default');
  assert.deepEqual(parseConfig({ ...GITHUB, trustedDomains: [' GitHub.com ', 'api.github.com', 'github.com'] }).trustedDomains, ['github.com', 'api.github.com']);
  const missing = 'hive.config.json: "trustedDomains" must be an array of host names ([] = every link asks)';
  for (const bad of [undefined, null, 'github.com', {}, ['github.com', 1]]) assert.throws(() => parseConfig({ ...GITHUB, trustedDomains: bad }), { message: missing }, JSON.stringify(bad));
  const notHost = (entry: string): string => `hive.config.json: "trustedDomains" holds "${entry}", which is not a host name (like github.com: no scheme, port, path or *)`;
  for (const bad of ['https://github.com', 'github.com:443', 'github.com/issues', '*.github.com', '-github.com', 'github-.com', '', 'git hub.com']) {
    assert.throws(() => parseConfig({ ...GITHUB, trustedDomains: ['github.com', bad] }), { message: notHost(bad) }, bad);
  }
  assert.throws(() => parseConfig({ ...GITHUB, trustedDomains: [' HTTPS://GitHub.com '] }), { message: notHost('https://github.com') }, 'named as normalized');
});

test('parseConfig requires shortcuts, the user\'s changes only: a binding stored normalized or null for off; an unknown id, a bad binding, a collision and a reserved key are refused by name (#449); Cmd+, Shift+Enter and Escape are fixed keys (#481)', () => {
  assert.deepEqual(parseConfig(GITHUB).shortcuts, {}, 'what combConfig writes: every default');
  assert.deepEqual(parseConfig({ ...GITHUB, shortcuts: { toggleRight: 'Shift+CmdOrCtrl+y', clear: null } }).shortcuts, { toggleRight: 'CmdOrCtrl+Shift+Y', clear: null });
  const notObject = 'hive.config.json: "shortcuts" must be an object of shortcut ids to a key binding or null ({} = every default)';
  for (const bad of [undefined, null, 'CmdOrCtrl+J', ['CmdOrCtrl+J']]) assert.throws(() => parseConfig({ ...GITHUB, shortcuts: bad }), { message: notObject }, JSON.stringify(bad));
  const noShortcut = (id: string): string => `hive.config.json: "shortcuts" names "${id}", which is no shortcut (${SHORTCUTS.map((s) => s.id).join(', ')})`;
  assert.throws(() => parseConfig({ ...GITHUB, shortcuts: { palette: 'CmdOrCtrl+K' } }), { message: noShortcut('palette') });
  const badBinding = 'hive.config.json: "shortcuts.toggleRight" must be null (off) or a key binding like CmdOrCtrl+Shift+J; a letter, digit or punctuation key needs CmdOrCtrl, Ctrl or Alt';
  for (const bad of ['J', 'Shift+J', 'Shift', '', 7, 'Escape', 'Shift+Escape']) assert.throws(() => parseConfig({ ...GITHUB, shortcuts: { toggleRight: bad } }), { message: badBinding }, String(bad));
  // CmdOrCtrl+1 is viewActivities' on every platform (#746): the config is parsed with the platform it runs on (#585), macOS here and Linux on CI
  assert.throws(() => parseConfig({ ...GITHUB, shortcuts: { close: 'CmdOrCtrl+1' } }), { message: 'hive.config.json: "shortcuts.viewActivities" and "shortcuts.close" are both CmdOrCtrl+1' });
  assert.throws(() => parseConfig({ ...GITHUB, shortcuts: { toggleLeft: 'CmdOrCtrl+C' } }), { message: 'hive.config.json: "shortcuts.toggleLeft" is CmdOrCtrl+C, which the Edit or app menu keeps' });
  assert.throws(() => parseConfig({ ...GITHUB, shortcuts: { close: 'CmdOrCtrl+,' } }), { message: 'hive.config.json: "shortcuts.close" is CmdOrCtrl+,, which the Edit or app menu keeps' });
  assert.throws(() => parseConfig({ ...GITHUB, shortcuts: { settings: null } }), { message: noShortcut('settings') });
  assert.deepEqual(parseConfig({ ...GITHUB, shortcuts: { close: 'CmdOrCtrl+1', viewActivities: null } }).shortcuts, { close: 'CmdOrCtrl+1', viewActivities: null }, 'a key freed by turning its shortcut off');
});

test('parseConfig keeps explicit values and ignores a leftover port (#466)', () => {
  const config = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 3, filter: FILTER }, port: 5000, agentArgs: { claude: ['--model', 'sonnet'], codex: [] } }));
  assert.deepEqual(config.agentArgs, { claude: ['--model', 'sonnet'], codex: [] });
  assert.equal('port' in config, false);
});

test('a maxConcurrent left in hive.config.json is dropped on load: the state owns the cap (#727)', async (t) => {
  const home = await tempDir(t, 'cfg-');
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(combConfig({ source: GITHUB_SOURCE, maxConcurrent: 4 })));
  assert.equal('maxConcurrent' in (await loadConfig(home)), false);
});

test('parseConfig accepts a github source as a comb.sources entry', () => {
  assert.deepEqual(parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter: FILTER } })).comb.sources, [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS }]);
});

test('parseConfig rejects missing or wrong-typed fields with the field name', () => {
  assert.throws(() => parseConfig({}), { message: 'hive.config.json: "comb" is required' });
  assert.throws(() => parseConfig(github({ source: { type: 'github', owner: '@me' } })), /comb\.sources\[0\]\.number/);
  assert.throws(() => parseConfig(github({ source: { type: 'github', number: 1 } })), /comb\.sources\[0\]\.owner/);
  assert.throws(() => parseConfig(github({ source: { type: 'asana', id: 1 } })), { message: 'hive.config.json: "comb.sources[0].type" must be one of: github' });
  assert.throws(() => parseConfig({ ...GITHUB, agentArgs: { claude: 'x' } }), /agentArgs/);
});

test('loadConfig reads hive.config.json from the home and reports a missing file clearly', async (t) => {
  const home = await tempDir(t, '');
  await assert.rejects(loadConfig(home), /hive\.config\.json/);
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(GITHUB));
  assert.deepEqual((await loadConfig(home)).comb.sources, [sourceEntry({ ...GITHUB_SOURCE, ...EPICS })]);
});

test('loadConfigIfPresent returns undefined only when the file is missing', async (t) => {
  const home = await tempDir(t, '');
  assert.equal(await loadConfigIfPresent(home), undefined);
  await writeFile(join(home, 'hive.config.json'), '{not json');
  await assert.rejects(loadConfigIfPresent(home), /JSON inválido/);
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(GITHUB));
  assert.deepEqual((await loadConfigIfPresent(home))?.comb.sources, [sourceEntry({ ...GITHUB_SOURCE, ...EPICS })]);
});

test('parseConfig reads budget, leaves absent limits absent and defaults to {}', () => {
  assert.deepEqual(parseConfig({ ...GITHUB }).budget, {});
  assert.deepEqual(parseConfig({ ...GITHUB, budget: {} }).budget, {});
  assert.deepEqual(parseConfig({ ...GITHUB, budget: { maxTokensPerHour: 50_000 } }).budget, { maxTokensPerHour: 50_000 });
  assert.deepEqual(
    parseConfig({ ...GITHUB, budget: { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 } }).budget,
    { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 },
  );
});

test('parseConfig rejects a budget that is not an object or has a non-integer limit, naming the field', () => {
  assert.throws(() => parseConfig({ ...GITHUB, budget: 5 }), { message: 'hive.config.json: "budget" must be an object' });
  assert.throws(() => parseConfig({ ...GITHUB, budget: [] }), /"budget" must be an object/);
  assert.throws(() => parseConfig({ ...GITHUB, budget: null }), /"budget" must be an object/);
  assert.throws(
    () => parseConfig({ ...GITHUB, budget: { maxTokensPerHour: 1.5 } }),
    { message: 'hive.config.json: "budget.maxTokensPerHour" must be a non-negative integer' },
  );
  assert.throws(() => parseConfig({ ...GITHUB, budget: { maxTokensPerDay: -1 } }), /budget\.maxTokensPerDay/);
  assert.throws(() => parseConfig({ ...GITHUB, budget: { maxTokensPerDay: '10' } }), /budget\.maxTokensPerDay/);
});

test('parseConfig reads usageRules as written, one per source', () => {
  const usageRules = [
    { source: 'hour', percent: 50, maxWorkers: 4 }, { source: 'day', percent: 80, signal: 'yellow' },
    { source: 'session', percent: 90, maxWorkers: 0, signal: 'red' }, { source: 'week', percent: 100, signal: 'red' },
  ];
  assert.deepEqual(parseConfig({ ...GITHUB, usageRules }).usageRules, usageRules);
  assert.deepEqual(parseConfig({ ...GITHUB, usageRules: [] }).usageRules, []);
});

test('parseConfig rejects bad usage rules naming the field', () => {
  const rules = (usageRules: unknown) => () => parseConfig({ ...GITHUB, usageRules });
  assert.throws(rules('x'), /"usageRules" must be an array/);
  assert.throws(rules([5]), /"usageRules\[0\]" must be an object/);
  assert.throws(rules([{ percent: 50, signal: 'red' }]), { message: 'hive.config.json: "usageRules[0].source" must be one of: hour, day, session, week, month' }, 'no source: no default, nothing to migrate');
  assert.throws(rules([{ source: 'x', percent: 50, signal: 'red' }]), /"usageRules\[0\]\.source" must be one of: hour, day, session, week, month/);
  assert.throws(rules([{ source: 'hour', percent: 101, signal: 'red' }]), /"usageRules\[0\]\.percent" must be an integer from 0 to 100/);
  assert.throws(rules([{ source: 'hour', percent: -1, signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ source: 'hour', percent: 1.5, signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ source: 'hour', signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ source: 'hour', percent: 50, signal: 'blue' }]), /"usageRules\[0\]\.signal" must be one of: yellow, red/);
  assert.throws(rules([{ source: 'hour', percent: 50, signal: 'green' }]), /"usageRules\[0\]\.signal" must be one of: yellow, red/, 'green never restricts: not a consequence');
  assert.throws(rules([{ source: 'hour', percent: 50, maxWorkers: -1 }]), /usageRules\[0\]\.maxWorkers/);
  assert.throws(rules([{ source: 'hour', percent: 50, signal: 'red' }, { source: 'day', percent: 60 }]), /"usageRules\[1\]" must set "maxWorkers" or "signal"/);
});

test('parseConfig reads stages as written, keeps absent optional keys absent and rejects the bad ones naming the index', () => {
  const stages: LegacyStage[] = [
    { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] }, prompt: '/hive-spec {url}', session: 'new', model: 'opus' },
    { name: 'dev', from: { board: ['Ready'] }, onStart: { board: [move('In progress')] }, onFinish: { board: [move('In review')] }, prompt: '/hive-build {url}', session: 'continue' },
    { name: 'review', from: { board: ['In review'] } },
  ];
  assert.deepEqual(parseConfig(github({ stages })).comb.stages, chained(stages).stages); // #134: onFinish moved to the transitions
  assert.equal('weight' in parseConfig(github({ stages: [{ ...stages[0], weight: 5 }, ...stages.slice(1)] })).comb.stages[0], false, 'a leftover weight is ignored: the file boots as it is (#316)');
  assert.equal('session' in parseConfig(github({ stages })).comb.stages[2], false, 'absent stays absent: new is the default at use');
  const bad = (stages: unknown) => () => parseConfig(github({ stages }));
  const { stages: _dropped, ...noStages } = GITHUB.comb as Record<string, unknown>;
  assert.throws(() => parseConfig({ ...GITHUB, comb: noStages }), { message: 'hive.config.json: "comb.stages" is required' });
  assert.throws(bad([]), { message: 'hive.config.json: "comb.stages" must be a non-empty array' });
  assert.throws(bad('x'), /"comb\.stages" must be a non-empty array/);
  assert.throws(bad([5]), /"comb\.stages\[0\]" must be an object/);
  assert.throws(bad([{ from: {} }]), /"comb\.stages\[0\]\.name" must be a non-empty string/);
  assert.throws(bad([{ name: 'a' }]), /"comb\.stages\[0\]\.from" must be an object keyed by source name/);
  assert.throws(bad([{ name: 'a', from: { board: [1] } }]), /comb\.stages\[0\]\.from/);
  assert.throws(bad([{ name: 'a', from: { board: ['x'] }, session: 'resume' }]), /"comb\.stages\[0\]\.session" must be one of: new, continue/);
  assert.throws(bad([{ name: 'a', from: { board: ['x'] }, prompt: 7 }]), /comb\.stages\[0\]\.prompt/);
  assert.throws(bad([{ name: 'a', from: { board: ['x'] }, onStart: { board: '' } }]), /comb\.stages\[0\]\.onStart/);
  assert.throws(bad([{ name: 'a', from: { board: ['x'] } }, { name: 'a', from: {} }]), { message: 'hive.config.json: "comb.stages[1].name" must be unique' });
  assert.throws(bad([{ name: 'a', from: {} }]), { message: 'hive.config.json: "comb.stages" must have at least one stage with "from.board"' });
});

test('comb.columns is refused with the rename, no migration: the message names comb.stages (#286)', () => {
  const { stages, ...comb } = GITHUB.comb as Record<string, unknown>;
  assert.throws(() => parseConfig({ ...GITHUB, comb: { ...comb, columns: stages } }), { message: 'hive.config.json: "comb.columns" was renamed to "comb.stages" (#286)' });
  assert.throws(() => parseConfig({ ...GITHUB, comb: { ...comb, columns: stages, stages } }), /"comb\.columns" was renamed/, 'even next to the new key');
});

test('comb.projects is refused with the rename, no migration: the message names comb.workspaces (#571)', () => {
  const { workspaces, ...comb } = GITHUB.comb as Record<string, unknown>;
  assert.throws(() => parseConfig({ ...GITHUB, comb: { ...comb, projects: workspaces } }), { message: 'hive.config.json: "comb.projects" was renamed to "comb.workspaces" (#571)' });
  assert.throws(() => parseConfig({ ...GITHUB, comb: { ...comb, workspaces, projects: workspaces } }), /"comb\.projects" was renamed/, 'even next to the new key');
});

const SHAPE = '{ "type": "move", "column": "<source column>" } or { "type": "archive" | "remove" | "close" | "delete" }';
const LIST = `must be a non-empty array of actions: [${SHAPE}, …] (#515)`;

// Two GitHub sources, board and notes, under one stage `dev`: what the action-list tests parse.
const twoSourceComb = (stage: Record<string, unknown>) => {
  const notes = { name: 'notes', qualifyId: false, ...GITHUB_SOURCE, number: 7, taskProps: FIXED };
  return parseConfig(combConfig({ sources: [sourceEntry(GITHUB_SOURCE), notes], stages: [{ name: 'dev', from: { board: ['Ready'], notes: ['todo'] }, ...stage }] })).comb;
};
const twoSourceStage = (stage: Record<string, unknown>) => twoSourceComb(stage).stages[0];
// #134: a pre-#134 onFinish is migrated into the stage's transition, whose sources hold the list
const twoSourceExit = (stage: Record<string, unknown>) => twoSourceComb(stage).transitions[0].sources;
const refusedStage = (stage: Record<string, unknown>, message: string) => assert.throws(() => twoSourceStage(stage), { message: `hive.config.json: ${message}` });

test('onStart / onFinish take source actions (#286): a non-list is refused naming the list shape; a GitHub source takes every action', () => {
  for (const type of ['archive', 'remove', 'close', 'delete'] as const) assert.deepEqual(twoSourceExit({ onFinish: { board: [{ type }] } }), { board: [{ type }] }, type);
  assert.deepEqual(twoSourceExit({ onFinish: { board: [{ type: 'close', reason: 'wontDo', duplicateOf: 3 }] } }), { board: [{ type: 'close' }] }, 'hive_stop\'s reason is no config key (#314)');
  const moves = { onStart: { board: [{ type: 'move', column: 'In progress' }] }, onFinish: { board: [{ type: 'move', column: 'In review' }], notes: [{ type: 'remove' }] } };
  assert.deepEqual(twoSourceStage(moves), { name: 'dev', from: { board: ['Ready'], notes: ['todo'] }, onStart: moves.onStart });
  assert.deepEqual(twoSourceExit(moves), moves.onFinish);
  refusedStage({ onFinish: { board: 'In review' } }, `"comb.transitions[0].sources.board" ${LIST}`);
  refusedStage({ onStart: { board: 'In progress' } }, `"comb.stages[0].onStart.board" ${LIST}`);
  refusedStage({ onFinish: { board: ['In review'] } }, `"comb.transitions[0].sources.board[0]" must be an object: ${SHAPE} (#286)`);
  refusedStage({ onFinish: { board: [{ type: 'nuke' }] } }, '"comb.transitions[0].sources.board[0].type" must be one of: move, archive, remove, close, delete');
  refusedStage({ onFinish: { board: [{ type: 'move' }] } }, '"comb.transitions[0].sources.board[0].column" must be a non-empty string');
});

test('each source takes an ordered list of actions: one of each type, a leaving action only last (#515)', () => {
  const done = { type: 'move', column: 'Done' };
  assert.deepEqual(twoSourceExit({ onFinish: { board: [done, { type: 'close' }] } }), { board: [done, { type: 'close' }] });
  assert.deepEqual(twoSourceExit({ onFinish: { board: [{ type: 'close' }, { type: 'archive' }] } }), { board: [{ type: 'close' }, { type: 'archive' }] });
  assert.deepEqual(twoSourceExit({ onFinish: { notes: [{ type: 'move', column: 'done' }, { type: 'remove' }] } }), { notes: [{ type: 'move', column: 'done' }, { type: 'remove' }] });
  refusedStage({ onFinish: { board: [] } }, `"comb.transitions[0].sources.board" ${LIST}`);
  refusedStage({ onFinish: { board: { type: 'close' } } }, `"comb.transitions[0].sources.board" ${LIST}`);
  refusedStage({ onFinish: { board: [{ type: 'close' }, { type: 'close' }] } }, '"comb.transitions[0].sources.board[1].type" "close" is already in the list');
  refusedStage({ onFinish: { board: [done, { type: 'move', column: 'Ready' }] } }, '"comb.transitions[0].sources.board[1].type" "move" is already in the list');
  const last = 'takes the task off its source, so it must be the last action';
  refusedStage({ onFinish: { board: [{ type: 'archive' }, { type: 'close' }] } }, `"comb.transitions[0].sources.board[0].type" "archive" ${last}`);
  refusedStage({ onFinish: { board: [{ type: 'archive' }, { type: 'delete' }] } }, `"comb.transitions[0].sources.board[0].type" "archive" ${last}`);
});

test('on start a list may move and close, never take the task off the source (#515)', () => {
  const start = [{ type: 'move', column: 'In progress' }, { type: 'close' }];
  assert.deepEqual(twoSourceStage({ onStart: { board: start } }).onStart, { board: start });
  for (const type of ['archive', 'remove', 'delete']) {
    refusedStage({ onStart: { board: [{ type }] } }, `"comb.stages[0].onStart.board[0].type" "${type}" cannot run on start: it would take the task off its source while its worker runs`);
  }
});

test('parseConfig reads a stage\'s maxWorkers as a non-negative integer, 0 included, keeps it absent when unset and refuses the rest (#475)', () => {
  const stage = (maxWorkers?: unknown) => ({ name: 'a', from: { board: ['x'] }, ...(maxWorkers === undefined ? {} : { maxWorkers }) });
  assert.equal('maxWorkers' in parseConfig(github({ stages: [stage()] })).comb.stages[0], false, 'absent stays absent: no stage cap');
  assert.equal(parseConfig(github({ stages: [stage(0)] })).comb.stages[0].maxWorkers, 0, '0 is kept: it pauses the stage');
  assert.equal(parseConfig(github({ stages: [stage(3)] })).comb.stages[0].maxWorkers, 3);
  for (const bad of [-1, 1.5, '2', null]) {
    assert.throws(() => parseConfig(github({ stages: [stage(bad)] })), { message: 'hive.config.json: "comb.stages[0].maxWorkers" must be a non-negative integer' }, JSON.stringify(bad));
  }
});

test('a usage rule may name a stage (#475): kept as written, refused next to a signal, when it names no stage of the Comb, or when it is not a non-empty string', () => {
  const stages = [{ name: 'spec', from: { board: ['Backlog'] } }, { name: 'build', from: { board: ['Ready'] } }];
  const parsed = (usageRules: unknown) => parseConfig(github({ stages, usageRules }));
  const rules = [{ source: 'week', percent: 90, maxWorkers: 2 }, { source: 'week', percent: 70, maxWorkers: 1, stage: 'build' }];
  assert.deepEqual(parsed(rules).usageRules, rules);
  assert.equal('stage' in parsed(rules).usageRules[0], false, 'a global rule has no stage key');
  const refused = (rule: Record<string, unknown>, message: string) => assert.throws(() => parsed([rules[0], rule]), { message: `hive.config.json: ${message}` }, JSON.stringify(rule));
  const signalled = '"usageRules[1].signal" cannot be combined with "stage": a stage rule only caps its workers';
  refused({ source: 'week', percent: 70, signal: 'red', stage: 'build' }, signalled);
  refused({ source: 'week', percent: 70, maxWorkers: 1, signal: 'yellow', stage: 'build' }, signalled);
  refused({ source: 'week', percent: 70, maxWorkers: 1, stage: 'deploy' }, '"usageRules[1].stage" must name a stage');
  refused({ source: 'week', percent: 70, maxWorkers: 1, stage: '' }, '"usageRules[1].stage" must be a non-empty string');
  refused({ source: 'week', percent: 70, maxWorkers: 1, stage: 3 }, '"usageRules[1].stage" must be a non-empty string');
});

test('parseConfig keeps a valid branch template, leaves it absent when unset or empty and rejects an unusable one naming the field', () => {
  const base = combConfig({ source: { type: 'github', owner: 'a', number: 1, filter: FILTER } });
  assert.equal(parseConfig({ ...base, branch: 'feat/{id}-{title}' }).branch, 'feat/{id}-{title}');
  assert.equal('branch' in parseConfig(base), false, 'absent stays absent: hive.config.json stays clean and the default applies');
  assert.equal('branch' in parseConfig({ ...base, branch: '' }), false, 'an empty field means the default, not an error');
  assert.throws(() => parseConfig({ ...base, branch: 'feat/{title}' }), /"branch" must contain \{id\} or \{slug\}/);
  assert.throws(() => parseConfig({ ...base, branch: 'hive/{id}^' }), /"branch" must render a valid git branch name/);
  assert.throws(() => parseConfig({ ...base, branch: 7 }), /"branch" must be a non-empty string/);
});

test('a github source requires auth.github and accepts only cli or api', () => {
  assert.equal(parseConfig({ ...GITHUB, auth: { github: 'cli' } }).auth?.github, 'cli');
  assert.equal(parseConfig({ ...GITHUB, auth: { github: 'api' } }).auth?.github, 'api');
  const message = 'hive.config.json: "auth.github" is required and must be one of: cli, api';
  const { auth: _dropped, ...noAuth } = GITHUB;
  assert.throws(() => parseConfig(noAuth), { message }, 'the key missing');
  assert.throws(() => parseConfig({ ...GITHUB, auth: {} }), { message }, 'auth without github');
  assert.throws(() => parseConfig({ ...GITHUB, auth: { github: 'gh' } }), { message }, 'an unknown transport');
  assert.throws(() => parseConfig({ ...GITHUB, auth: 'cli' }), { message }, 'auth that is not an object');
  assert.throws(() => parseConfig({ ...GITHUB, auth: null }), { message });
});

test('auth is optional without a github source: a Comb with no source parses without it, and one that is written is still checked', () => {
  const none = combConfig({ stages: LOCAL_STAGES, auth: undefined });
  assert.equal('auth' in parseConfig(none), false, 'absent stays absent: nothing logs in');
  assert.deepEqual(parseConfig({ ...none, auth: { github: 'api' } }).auth, { github: 'api' }, 'kept when written');
  assert.throws(() => parseConfig({ ...none, auth: { github: 'gh' } }), /"auth\.github" is required and must be one of: cli, api/);
});

test('a github source requires filter as an array of rules: missing, null or the old three-list object is refused naming #245', () => {
  const message = 'hive.config.json: "comb.sources[0].filter" must be an array of rules (the assignees/labels/milestones object is gone, see #245)';
  assert.throws(() => parseConfig(github({ source: { type: 'github', owner: '@me', number: 6 } })), { message }, 'missing');
  for (const filter of [null, {}, { assignees: [], labels: [], milestones: [] }]) {
    assert.throws(() => parseConfig(github({ source: { ...GITHUB_SOURCE, filter } })), { message }, JSON.stringify(filter));
  }
});

test('filter rules parse trimmed and in order, [] means no restriction (#245)', () => {
  const filter = [
    { field: 'assignee', op: 'any', values: [' @me '] },
    { field: 'label', op: 'none', values: ['blocked', 'wontfix'] },
    { field: 'repository', op: 'any', values: ['octo-org/app'] },
    { field: 'projectField', name: ' Priority ', op: 'any', values: ['P0', 'P1'] },
  ];
  assert.deepEqual(parseConfig(github({ source: { ...GITHUB_SOURCE, filter } })).comb.sources[0], sourceEntry({
    ...GITHUB_SOURCE, ...EPICS,
    filter: [{ field: 'assignee', op: 'any', values: ['@me'] }, filter[1], filter[2], { field: 'projectField', name: 'Priority', op: 'any', values: ['P0', 'P1'] }],
  }));
  assert.deepEqual(parseConfig(github()).comb.sources[0], sourceEntry({ ...GITHUB_SOURCE, ...EPICS }), '[] parses as []');
});

test('a bad filter rule is refused naming its index and key (#245)', () => {
  const at = (bad: unknown) => () => parseConfig(github({ source: { ...GITHUB_SOURCE, filter: [{ field: 'label', op: 'any', values: ['hive'] }, bad] } }));
  const key = (name: string): string => `hive.config.json: "comb.sources[0].filter[1].${name}"`;
  assert.throws(at('label'), { message: 'hive.config.json: "comb.sources[0].filter[1]" must be an object' });
  assert.throws(at({ field: 'author', op: 'any', values: ['ana'] }), { message: `${key('field')} must be one of: assignee, label, milestone, repository, projectField, blocked` });
  assert.throws(at({ field: 'label', op: 'all', values: ['x'] }), { message: `${key('op')} must be one of: any, none` });
  assert.throws(at({ field: 'label', op: 'any', values: [] }), { message: `${key('values')} must be a non-empty array of strings` }, 'a rule with no values means nothing');
  assert.throws(at({ field: 'label', op: 'any', values: ['  '] }), /"comb\.sources\[0\]\.filter\[1\]\.values" must be/, 'a blank value is a mistake, not "any"');
  assert.throws(at({ field: 'label', op: 'any', values: [1] }), /"comb\.sources\[0\]\.filter\[1\]\.values" must be/);
  assert.throws(at({ field: 'projectField', op: 'any', values: ['P0'] }), { message: `${key('name')} must be a non-empty string` });
  assert.throws(at({ field: 'projectField', name: '  ', op: 'any', values: ['P0'] }), { message: `${key('name')} must be a non-empty string` });
  assert.throws(at({ field: 'label', name: 'Priority', op: 'any', values: ['x'] }), { message: `${key('name')} is only allowed on a projectField rule` });
});

test('a blocked rule (#441) parses with its operator alone; values (even []) or name on it is refused naming the rule', () => {
  const filter = [{ field: 'label', op: 'any', values: ['hive'] }, { field: 'blocked', op: 'none' }];
  assert.deepEqual(parseConfig(github({ source: { ...GITHUB_SOURCE, filter } })).comb.sources[0], sourceEntry({ ...GITHUB_SOURCE, ...EPICS, filter }));
  const at = (bad: unknown) => () => parseConfig(github({ source: { ...GITHUB_SOURCE, filter: [filter[0], bad] } }));
  const key = (name: string): string => `hive.config.json: "comb.sources[0].filter[1].${name}"`;
  assert.throws(at({ field: 'blocked', op: 'none', values: ['yes'] }), { message: `${key('values')} is not allowed on a blocked rule` });
  assert.throws(at({ field: 'blocked', op: 'none', values: [] }), { message: `${key('values')} is not allowed on a blocked rule` }, 'a value key would read as meaning something');
  assert.throws(at({ field: 'blocked', op: 'any', name: 'Status' }), { message: `${key('name')} is only allowed on a projectField rule` });
  assert.throws(at({ field: 'blocked', op: 'all' }), { message: `${key('op')} must be one of: any, none` });
});

test('parseConfig reads a Comb with its prefix, its one workspace and its stages, with a source or without one', () => {
  assert.deepEqual(parseConfig(GITHUB).comb, { prefix: 'HIVE', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], sources: [sourceEntry({ ...GITHUB_SOURCE, ...EPICS })], ...chained(STAGES), commands: [], hiveSource: true, createIn: 'hive' });
  const bare = parseConfig(combConfig({ stages: LOCAL_STAGES, auth: undefined })).comb;
  assert.deepEqual(bare, { prefix: 'HIVE', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], sources: [], stages: LOCAL_STAGES, transitions: transitionsOf(LOCAL_STAGES), commands: [], hiveSource: true, createIn: 'hive' });
});

test('from, onStart and onFinish are maps keyed by source name: a key naming no source is refused, every source needs a from, and without sources no stage names one; auth.github is required when any source is GitHub (#180)', () => {
  const notes = { name: 'notes', qualifyId: false, ...GITHUB_SOURCE, number: 7, taskProps: FIXED };
  const parsed = (stage: Record<string, unknown>) =>
    parseConfig(combConfig({ sources: [sourceEntry(GITHUB_SOURCE), notes], stages: [{ name: 'dev', ...stage }] })).comb.stages[0];
  const full = { from: { board: ['Ready'], notes: ['todo'] }, onStart: { board: [move('In progress')] }, onFinish: { board: [move('In review')], notes: [move('review')] } };
  assert.deepEqual(parsed(full), { name: 'dev', from: full.from, onStart: full.onStart }); // #134: onFinish moved to the transitions
  assert.equal('onStart' in parsed({ from: full.from }), false, 'absent stays absent');
  const refused = (stage: Record<string, unknown>, message: string) => assert.throws(() => parsed(stage), { message: `hive.config.json: ${message}` });
  refused({ from: { board: ['Ready'], nope: ['x'] } }, '"comb.stages[0].from.nope" names no source');
  refused({ ...full, onStart: { nope: 'x' } }, '"comb.stages[0].onStart.nope" names no source');
  refused({ ...full, onFinish: { nope: 'x' } }, '"comb.transitions[0].sources.nope" names no source');
  refused({ from: ['Ready'] }, '"comb.stages[0].from" must be an object keyed by source name');
  refused({ ...full, onStart: 'In progress' }, '"comb.stages[0].onStart" must be an object keyed by source name');
  refused({ from: { board: 'Ready', notes: ['todo'] } }, '"comb.stages[0].from.board" must be an array of strings');
  refused({ ...full, onStart: { board: '' } }, `"comb.stages[0].onStart.board" ${LIST}`);
  refused({ from: { board: ['Ready'] } }, '"comb.stages" must have at least one stage with "from.notes"');
  const local = (stage: Record<string, unknown>) => () => parseConfig(combConfig({ stages: [{ name: 'fila', ...stage }], auth: undefined }));
  assert.doesNotThrow(local({ from: {} }), 'no sources: tasks enter by hand');
  assert.throws(local({ from: { board: ['Ready'] } }), { message: 'hive.config.json: "comb.stages[0].from.board" names no source' });
  const githubOnly = { sources: [notes], stages: [{ name: 'dev', from: { notes: ['todo'] } }], auth: undefined };
  assert.throws(() => parseConfig(combConfig(githubOnly)), { message: 'hive.config.json: "auth.github" is required and must be one of: cli, api' });
});

test('comb.sources holds named sources: a name like a workspace\'s but not "local" or "hive", unique, a boolean qualifyId and an optional prefix like comb.prefix; the source fields keep their rules under comb.sources[i]; a comb.source key is refused and opens the settings form (#180)', () => {
  const work = { name: 'work', qualifyId: true, prefix: 'W', ...GITHUB_SOURCE, taskProps: FIXED };
  const notes = { name: 'notes', qualifyId: false, ...GITHUB_SOURCE, number: 7, taskProps: FIXED };
  const stages = [{ name: 'dev', from: { work: ['Ready'], notes: ['todo'] } }];
  assert.deepEqual(parseConfig(combConfig({ sources: [work, notes], stages })).comb.sources, [{ ...work, ...EPICS, switchAt: 'dev' }, { ...notes, ...EPICS, switchAt: 'dev' }]);
  assert.equal('prefix' in parseConfig(combConfig({ sources: [work, notes], stages })).comb.sources[1], false, 'absent stays absent');
  const second = (patch: Record<string, unknown>) => () => parseConfig(combConfig({ sources: [work, { ...notes, ...patch }], stages }));
  const nameMessage = 'hive.config.json: "comb.sources[1].name" must be a letter or digit followed by up to 39 letters, digits, ".", "_" or "-"';
  for (const name of [undefined, '', '-x', 'a b', 'a:b', 'x'.repeat(41)]) assert.throws(second({ name }), { message: nameMessage }, JSON.stringify(name));
  for (const name of ['local', 'hive']) assert.throws(second({ name }), { message: 'hive.config.json: "comb.sources[1].name" cannot be "local" or "hive"' }, name);
  assert.throws(second({ name: 'work' }), { message: 'hive.config.json: "comb.sources[1].name" must be unique' });
  for (const qualifyId of [undefined, 'true', 1]) {
    assert.throws(second({ qualifyId }), { message: 'hive.config.json: "comb.sources[1].qualifyId" must be a boolean' }, JSON.stringify(qualifyId));
  }
  for (const prefix of ['', '1W', 'W-1', 'Abcdefghijk']) {
    assert.throws(second({ prefix }), { message: 'hive.config.json: "comb.sources[1].prefix" must be a letter followed by up to 9 letters or digits' }, prefix);
  }
  assert.throws(second({ number: undefined }), /"comb\.sources\[1\]\.number"/);
  assert.throws(second({ taskProps: { defaults: { workspace: 'nope', auto: true }, rules: [] } }), { message: 'hive.config.json: "comb.sources[1].taskProps.defaults.workspace" must name one of "comb.workspaces"' });
  assert.throws(() => parseConfig(combConfig({ sources: 'x' })), { message: 'hive.config.json: "comb.sources" must be an array' });
  const withOld = { ...GITHUB, comb: { ...(GITHUB.comb as Record<string, unknown>), board: GITHUB_SOURCE } };
  assert.throws(() => parseConfig(withOld), { message: 'hive.config.json: "comb.board" moved to "comb.sources"' });
  assert.equal(predatesComb(withOld), true, 'boot opens the settings form with that error');
});

test('comb.prefix is a letter then up to 9 letters or digits, and comb.workspaces holds one or more named absolute paths, names and paths unique (#179)', () => {
  for (const prefix of ['HIVE', 'h', 'T2', 'Abcdefghij']) assert.equal(parseConfig(github({ prefix })).comb.prefix, prefix, prefix);
  const prefixMessage = 'hive.config.json: "comb.prefix" must be a letter followed by up to 9 letters or digits';
  for (const prefix of ['', '1HIVE', 'HI-VE', 'HIVE_1', 'Abcdefghijk', 7, null]) {
    assert.throws(() => parseConfig(github({ prefix })), { message: prefixMessage }, JSON.stringify(prefix));
  }
  const two = [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'site.v2_x-1', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }];
  assert.deepEqual(parseConfig(github({ workspaces: two })).comb.workspaces, two);
  for (const workspaces of [[], 'x']) {
    assert.throws(() => parseConfig(github({ workspaces })), { message: 'hive.config.json: "comb.workspaces" must be a non-empty array' }, JSON.stringify(workspaces));
  }
  const nameMessage = 'hive.config.json: "comb.workspaces[1].name" must be a letter or digit followed by up to 39 letters, digits, ".", "_" or "-"';
  for (const name of [undefined, '', '-x', '.x', 'a b', 'a/b', 'x'.repeat(41), 7]) {
    assert.throws(() => parseConfig(github({ workspaces: [two[0], { name, path: '/b', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] })), { message: nameMessage }, JSON.stringify(name));
  }
  assert.doesNotThrow(() => parseConfig(github({ workspaces: [{ name: 'x'.repeat(40), path: '/b', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], source: { ...GITHUB_SOURCE, taskProps: { defaults: { workspace: 'x'.repeat(40), auto: true }, rules: [] } } })), '40 characters is the cap');
  const pathMessage = 'hive.config.json: "comb.workspaces[0].path" must be an absolute path';
  for (const path of ['relative/repo', '', undefined]) {
    assert.throws(() => parseConfig(github({ workspaces: [{ name: 'hive', path, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] })), { message: pathMessage }, JSON.stringify(path));
  }
  assert.throws(() => parseConfig(github({ workspaces: ['x'] })), { message: 'hive.config.json: "comb.workspaces[0]" must be an object' });
  assert.throws(() => parseConfig(github({ workspaces: [two[0], { name: 'hive', path: '/b', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] })), { message: 'hive.config.json: "comb.workspaces[1].name" must be unique' });
  assert.throws(() => parseConfig(github({ workspaces: [two[0], { name: 'b', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] })), { message: 'hive.config.json: "comb.workspaces[1].path" must be unique' });
});

test('comb.commands is required: named commands, names trimmed and unique in the Comb, each a line per workspace and an env of strings whose names a shell can export; [] and {} are fine (#300, #511, #755)', () => {
  const front = { name: 'Run Frontend', impls: [{ workspace: 'hive', command: 'pnpm run dev -- --port $PORT' }], menu: true, env: { PORT: '5173' } };
  const withCommands = (commands: unknown) => github({ commands });
  assert.deepEqual(
    parseConfig(withCommands([front, { name: ' Lint ', impls: [{ workspace: null, command: ' pnpm lint ' }], menu: false, env: {} }])).comb.commands,
    [front, { name: 'Lint', impls: [{ workspace: null, command: 'pnpm lint' }], menu: false, env: {} }],
  );
  assert.deepEqual(parseConfig(withCommands([])).comb.commands, []);
  const refused = (commands: unknown, rest: string) =>
    assert.throws(() => parseConfig(withCommands(commands)), { message: `hive.config.json: "comb.commands${rest}` }, rest);
  refused({}, '" must be an array');
  refused(['x'], '[0]" must be an object');
  refused([{ ...front, name: '  ' }], '[0].name" must be a non-empty string');
  refused([front, { ...front, name: ' Run Frontend ' }], '[1].name" must be unique');
  refused([{ ...front, impls: [{ workspace: 'hive', command: '' }] }], '[0].impls[0].command" must be a non-empty string');
  for (const env of [undefined, [], { PORT: 5173 }, 'PORT=1']) refused([{ ...front, env }], '[0].env" must be an object of strings');
  for (const name of ['1PORT', 'MY-PORT', 'A B', '']) {
    refused([{ ...front, env: { [name]: 'x' } }], `[0].env.${name}" must be a variable name: letters, digits and _, not starting with a digit`);
  }
});

test('a command\'s impls name existing workspaces once each, null at most once for the other workspaces, at least one line; menu is required; the old command and workspaces keys are refused naming impls and menu (#511, #755)', () => {
  const dev = { name: 'dev', impls: [{ workspace: 'hive', command: 'pnpm dev' }, { workspace: null, command: 'make dev' }], menu: false, env: {}, timeout: '10m' };
  const comb = (commands: unknown) => github({ commands });
  const noCommands = { ...GITHUB, comb: { ...(GITHUB.comb as object), commands: undefined } };
  assert.throws(() => parseConfig(noCommands), { message: 'hive.config.json: "comb.commands" must be an array' });
  assert.deepEqual(parseConfig(comb([dev])).comb.commands, [dev]);
  const refused = (commands: unknown, message: string) =>
    assert.throws(() => parseConfig(comb(commands)), { message: `hive.config.json: "comb.commands${message}` }, message);
  const list = '" must be a non-empty array of { "workspace", "command" }';
  refused([{ ...dev, impls: [] }], `[0].impls${list}`);
  refused([{ ...dev, impls: undefined }], `[0].impls${list}`);
  refused([{ ...dev, impls: ['x'] }], '[0].impls[0]" must be an object');
  refused([{ ...dev, impls: [{ workspace: 'nope', command: 'x' }] }], '[0].impls[0].workspace" must be a workspace of comb.workspaces, or null for the other workspaces');
  refused([{ ...dev, impls: [{ workspace: 'hive', command: 'a' }, { workspace: 'hive', command: 'b' }] }], '[0].impls[1].workspace" must be unique');
  refused([{ ...dev, impls: [{ workspace: null, command: 'a' }, { workspace: null, command: 'b' }] }], '[0].impls[1].workspace" must be unique');
  refused([{ ...dev, menu: undefined }], '[0].menu" must be true or false');
  const gone = '" is gone: a command holds "impls" (one { "workspace", "command" } per workspace, null for the other workspaces) and "menu"';
  refused([{ name: 'dev', command: 'pnpm dev', env: {}, workspaces: ['hive'] }], `[0].command${gone}`);
  refused([{ ...dev, workspaces: ['hive'] }], `[0].workspaces${gone}`);
  refused([{ ...dev, timeout: '2d' }], '[0].timeout" must be a timeout like "30s", "10m" or "1h", up to 24h');
  refused([dev, dev], '[1].name" must be unique');
});
test('comb.commands[].command and env values refuse a control character other than tab (#300): the line runs in a terminal, where one could act on it before the shell sees shellQuote\'s own quotes', () => {
  const front = { name: 'Run Frontend', impls: [{ workspace: 'hive', command: 'pnpm run dev -- --port $PORT' }], menu: true, env: { PORT: '5173' } };
  const withCommands = (commands: unknown) => github({ commands });
  const refused = (commands: unknown, rest: string) =>
    assert.throws(() => parseConfig(withCommands(commands)), { message: `hive.config.json: "comb.commands${rest}` }, rest);
  for (const char of ['\u0000', '\u0007', '\u001b', '\u007f', '\n']) {
    refused([{ ...front, impls: [{ workspace: 'hive', command: `pnpm run${char}dev` }] }], '[0].impls[0].command" must not contain control characters');
    refused([{ ...front, env: { PORT: `5173${char}` } }], '[0].env.PORT" must not contain control characters');
  }
  assert.doesNotThrow(() => parseConfig(withCommands([{ ...front, impls: [{ workspace: 'hive', command: 'pnpm\trun dev' }], env: { PORT: '5173\t' } }])), 'tab is not a control character here');
});

test('comb.workspaces[].env is required: an object of strings shared by the workspace\'s run commands, with a command env\'s rules — names a shell can export, no control character but tab in a value; {} is fine (#348)', () => {
  const withEnv = (env: unknown) => github({ workspaces: [{ name: 'hive', path: '/repo', env, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] });
  assert.deepEqual(parseConfig(withEnv({ NODE_ENV: 'development', PAD: '  x\t' })).comb.workspaces[0].env, { NODE_ENV: 'development', PAD: '  x\t' });
  assert.deepEqual(parseConfig(withEnv({})).comb.workspaces[0].env, {});
  const refused = (env: unknown, rest: string) =>
    assert.throws(() => parseConfig(withEnv(env)), { message: `hive.config.json: "comb.workspaces[0].env${rest}` }, rest);
  for (const env of [undefined, [], { PORT: 5173 }, 'PORT=1']) refused(env, '" must be an object of strings');
  for (const name of ['1PORT', 'MY-PORT', 'A B', '']) refused({ [name]: 'x' }, `.${name}" must be a variable name: letters, digits and _, not starting with a digit`);
  for (const char of ['\u0000', '\u001b', '\u007f', '\n']) refused({ PORT: `5173${char}` }, '.PORT" must not contain control characters');
});

test('a workspace env or a command env that sets a name the Hive sets is refused with its field; PATH and HISTFILE are the user\'s to set (#738)', () => {
  const front = { name: 'Run Frontend', impls: [{ workspace: 'hive', command: 'pnpm run dev' }], menu: true, env: {} };
  const withWorkspaceEnv = (env: Record<string, string>) => github({ workspaces: [{ name: 'hive', path: '/repo', env, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] });
  const withCommandEnv = (env: Record<string, string>) => github({ commands: [{ ...front, env }] });
  for (const name of RESERVED_ENV_NAMES) {
    assert.throws(() => parseConfig(withWorkspaceEnv({ [name]: 'x' })), { message: `hive.config.json: "comb.workspaces[0].env.${name}" is set by the Hive and cannot be overridden` }, name);
    assert.throws(() => parseConfig(withCommandEnv({ [name]: 'x' })), { message: `hive.config.json: "comb.commands[0].env.${name}" is set by the Hive and cannot be overridden` }, name);
  }
  const free = { PATH: '/opt/bin', HISTFILE: '/elsewhere/history' };
  assert.deepEqual(parseConfig(withWorkspaceEnv(free)).comb.workspaces[0].env, free);
  assert.deepEqual(parseConfig(withCommandEnv(free)).comb.commands[0].env, free);
});

test('comb.sources[i].taskProps is required, parsed at its path; the #293 workspace setting is refused; unnamedWorkspacePath spots a file from before names (#179, #688)', () => {
  const site: SourceTaskProps = { defaults: { workspace: 'site', auto: false }, rules: [] };
  assert.deepEqual(parseConfig(github({ workspaces: TWO, source: { ...GITHUB_SOURCE, taskProps: site } })).comb.sources[0], { name: 'board', qualifyId: false, ...GITHUB_SOURCE, ...EPICS, taskProps: site });
  assert.deepEqual(parseConfig(github({ workspaces: TWO, source: { ...GITHUB_SOURCE, taskProps: DYNAMIC } })).comb.sources[0].taskProps, DYNAMIC);
  const message = 'hive.config.json: "comb.sources[0].taskProps" must be an object like { "defaults": { "auto": true }, "rules": [] }';
  assert.throws(() => parseConfig(combConfig({ sources: [{ name: 'board', qualifyId: false, ...GITHUB_SOURCE }] })), { message }, 'required: no default');
  assert.throws(() => parseConfig(combConfig({ sources: [{ name: 'board', qualifyId: false, ...GITHUB_SOURCE, workspace: { mode: 'fixed', workspace: 'hive' } }] })), { message }, 'a file from #293');
  assert.throws(() => parseConfig(github({ source: { ...GITHUB_SOURCE, taskProps: site } })), { message: 'hive.config.json: "comb.sources[0].taskProps.defaults.workspace" must name one of "comb.workspaces"' });
  assert.equal(unnamedWorkspacePath(github({ workspaces: [{ path: '/old' }] })), '/old', 'a file from before #179');
  assert.equal(unnamedWorkspacePath(GITHUB), undefined);
  assert.equal(unnamedWorkspacePath('x'), undefined);
});

test('a top-level board or columns is a parse error naming where it went, and predatesComb spots such a file', () => {
  assert.throws(() => parseConfig({ ...GITHUB, columns: STAGES }), { message: 'hive.config.json: "columns" moved to "comb.columns"' });
  assert.throws(() => parseConfig({ ...GITHUB, board: GITHUB_SOURCE }), { message: 'hive.config.json: "board" moved to "comb.board"' });
  const before = { auth: { github: 'cli' }, board: GITHUB_SOURCE, columns: STAGES }; // a file from before #132
  assert.throws(() => parseConfig(before), /"board" moved to "comb\.board"/);
  assert.deepEqual(
    [predatesComb(before), predatesComb({ port: 0 }), predatesComb({ ...GITHUB, columns: STAGES }), predatesComb(GITHUB), predatesComb('x')],
    [true, true, true, false, false],
  );
});

test('workspaceByName finds a Comb workspace by its name', () => {
  const config = parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 70)' }] }));
  assert.deepEqual(workspaceByName(config, 'site'), { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 70)' });
  assert.equal(workspaceByName(config, 'nope'), undefined);
  assert.equal(workspaceByName(config, undefined), undefined);
});

test('taskWorkspace resolves a task against the config\'s workspaces and source default; workspaceScope takes each source\'s default workspace, none without one; requireWorkspace names why there is none (#179, #688)', () => {
  const config = parseConfig(github({ workspaces: TWO, source: { ...GITHUB_SOURCE, taskProps: { defaults: { workspace: 'site', auto: true }, rules: [] } } }));
  const task = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '', source: 'board' } };
  assert.deepEqual(taskWorkspace(config, task), { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 70)' }, 'the source default');
  assert.deepEqual(workspaceScope(config), { workspaces: ['hive', 'site'], sourceWorkspaces: { board: 'site' }, commands: { hive: [], site: [] }, workspaceColors: { hive: 'oklch(0.72 0.12 25)', site: 'oklch(0.72 0.12 70)' } });
  const routed = parseConfig(github({ workspaces: TWO, source: { ...GITHUB_SOURCE, taskProps: DYNAMIC } }));
  assert.deepEqual(workspaceScope(routed).sourceWorkspaces, {}, 'no default workspace: its rules route through the hint (#293)');
  const both = parseConfig(github({ workspaces: TWO, source: { ...GITHUB_SOURCE, taskProps: { ...DYNAMIC, defaults: { workspace: 'hive', auto: true } } } }));
  assert.deepEqual(workspaceScope(both).sourceWorkspaces, { board: 'hive' }, 'a default next to rules is still the fallback (#688)');
  assert.deepEqual(workspaceScope(parseConfig(GITHUB)), { workspaces: ['hive'], sourceWorkspaces: { board: 'hive' }, commands: { hive: [] }, workspaceColors: { hive: 'oklch(0.72 0.12 25)' } }, 'the default source is fixed on the Comb\'s only workspace');
  assert.deepEqual(workspaceScope(parseConfig(github({ commands: [FRONT] }))).commands, { hive: ['Run Frontend'] }, 'names only: never the line nor the env (#300)');
  assert.throws(() => requireWorkspace(config, { ...task, workspace: 'gone' }), { message: 'workspace gone is gone' });
  assert.throws(() => requireWorkspace(routed, task), { message: 'choose a workspace' });
});

test('workspaceScope lists, per workspace, only what the task menu offers there: menu on and a line that resolves, in comb.commands order (#511, #755)', () => {
  const cmd = (name: string, impls: { workspace: string | null; command: string }[], menu = true) => ({ name, impls, menu, env: {} });
  const commands = [
    cmd('x', [{ workspace: 'a', command: 'true' }]),
    cmd('y', [{ workspace: 'b', command: 'b' }, { workspace: null, command: 'true' }]),
    cmd('z', [{ workspace: null, command: 'true' }], false),
  ];
  const config = parseConfig(github({ workspaces: [{ name: 'a', path: '/a', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'b', path: '/b', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], source: { ...GITHUB_SOURCE, taskProps: { defaults: { workspace: 'a', auto: true }, rules: [] } }, commands }));
  assert.deepEqual(workspaceScope(config).commands, { a: ['x', 'y'], b: ['y'] });
});

test('a workspace keeps its worktree setup only when given; a setup that is not text is refused (#299)', () => {
  const workspace = { name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup: 'COPY .env\nRUN pnpm install' };
  assert.deepEqual(parseConfig(github({ workspaces: [workspace] })).comb.workspaces, [workspace]);
  assert.equal(parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup: 'FROM node' }] })).comb.workspaces[0].setup, 'FROM node', 'POST /settings parses the text, not the boot: a bad line never stops the Hive');
  assert.deepEqual(Object.keys(parseConfig(GITHUB).comb.workspaces[0]), ['name', 'path', 'env', 'fork', 'memoryCap', 'color', 'nestedRepos', 'notNestedRepos', 'benchmarkPrIn'], 'absent stays absent, never undefined');
  assert.throws(() => parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup: ['RUN a'] }] })), { message: 'hive.config.json: "comb.workspaces[0].setup" must be a string' });
});

test("a workspace's setupTimeout is a timeout text; absent stays absent; a bad one is refused by name (#511)", () => {
  const workspace = { name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup: 'RUN pnpm install', setupTimeout: '90s' };
  assert.deepEqual(parseConfig(github({ workspaces: [workspace] })).comb.workspaces, [workspace]);
  assert.equal('setupTimeout' in parseConfig(GITHUB).comb.workspaces[0], false);
  for (const timeout of ['5', '0m', '25h', ' 5m', 5]) {
    assert.throws(
      () => parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setupTimeout: timeout }] })),
      { message: 'hive.config.json: "comb.workspaces[0].setupTimeout" must be a timeout like "30s", "10m" or "1h", up to 24h' }, String(timeout),
    );
  }
});

test('parseConfig reads only comb.sources: a file that still has comb.boards fails naming the new key (#571)', () => {
  const { comb, ...rest } = combConfig() as { comb: Record<string, unknown> };
  const { sources, ...others } = comb;
  assert.throws(() => parseConfig({ ...rest, comb: { ...others, boards: sources } }), { message: 'hive.config.json: "comb.boards" was renamed to "comb.sources" (#571)' });
});

test("a workspace's teardown and teardownTimeout are parsed as setup and setupTimeout are: kept only when given, a teardown that is not text and a bad timeout refused by name (#654)", () => {
  const workspace = { name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', teardown: 'RUN docker compose down\nDEL tmp/', teardownTimeout: '2m' };
  assert.deepEqual(parseConfig(github({ workspaces: [workspace] })).comb.workspaces, [workspace]);
  assert.deepEqual(Object.keys(parseConfig(GITHUB).comb.workspaces[0]), ['name', 'path', 'env', 'fork', 'memoryCap', 'color', 'nestedRepos', 'notNestedRepos', 'benchmarkPrIn'], 'absent stays absent');
  assert.deepEqual(parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', teardownTimeout: '5m' }] })).comb.workspaces[0].teardownTimeout, '5m', 'a timeout without a teardown is accepted');
  assert.throws(() => parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', teardown: 7 }] })), { message: 'hive.config.json: "comb.workspaces[0].teardown" must be a string' });
  assert.throws(
    () => parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', teardownTimeout: '25h' }] })),
    { message: 'hive.config.json: "comb.workspaces[0].teardownTimeout" must be a timeout like "30s", "10m" or "1h", up to 24h' },
  );
});

test('parseConfig refuses a workspace that still carries conventions, {} included, naming the plugins view; one without it loads (#318)', () => {
  const at = (extra: Record<string, unknown>) => parseConfig(github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', ...extra }] })).comb.workspaces[0];
  const refusal = { message: 'hive.config.json: "comb.workspaces[0].conventions" moved to the plugins view (#318): set each value in its skill\'s variables' };
  assert.throws(() => at({ conventions: { specsDir: 'docs/specs' } }), refusal);
  assert.throws(() => at({ conventions: {} }), refusal);
  assert.equal('conventions' in at({}), false);
});

test('parseConfig requires the four sleep notice switches, booleans with no default (#672)', () => {
  const four = (c: Config): unknown[] => [c.sleepNotice, c.sleepAutoNotice, c.sleepIdleNotice, c.sleepAllNotice];
  assert.deepEqual(four(parseConfig(GITHUB)), [true, true, true, true], 'what combConfig writes: the form defaults');
  assert.deepEqual(four(parseConfig({ ...GITHUB, sleepNotice: false, sleepAutoNotice: false, sleepIdleNotice: false, sleepAllNotice: false })), [false, false, false, false]);
  for (const key of ['sleepNotice', 'sleepAutoNotice', 'sleepIdleNotice', 'sleepAllNotice']) {
    for (const bad of [undefined, 'true', 1, null]) {
      assert.throws(() => parseConfig({ ...GITHUB, [key]: bad }), { message: `hive.config.json: "${key}" must be true or false` }, `${key} ${JSON.stringify(bad)}`);
    }
  }
});

test('parseConfig requires closeTerminalTab (keep or sleep) and closeTerminalTabNotice (a boolean), with no default (#696)', () => {
  const parsed = parseConfig({ ...GITHUB, closeTerminalTab: 'keep', closeTerminalTabNotice: false });
  assert.deepEqual([parsed.closeTerminalTab, parsed.closeTerminalTabNotice], ['keep', false]);
  for (const bad of [undefined, 'end', true]) {
    assert.throws(() => parseConfig({ ...GITHUB, closeTerminalTab: bad }), { message: 'hive.config.json: "closeTerminalTab" must be one of: keep, sleep' }, JSON.stringify(bad));
  }
  assert.throws(() => parseConfig({ ...GITHUB, closeTerminalTabNotice: 'yes' }), { message: 'hive.config.json: "closeTerminalTabNotice" must be true or false' });
});

test('parseConfig requires fileIcons: set, scope and muted, each named when wrong, with no default (#754)', () => {
  assert.deepEqual(parseConfig(GITHUB).fileIcons, { set: 'material', scope: 'all', muted: true }, 'what combConfig writes: the form default');
  const icons = { set: 'vscode', scope: 'folders', muted: true };
  assert.deepEqual(parseConfig({ ...GITHUB, fileIcons: icons }).fileIcons, icons);
  assert.deepEqual(parseConfig({ ...GITHUB, fileIcons: { ...icons, set: 'none' } }).fileIcons.set, 'none');
  for (const bad of [undefined, null, 'material', []]) {
    assert.throws(() => parseConfig({ ...GITHUB, fileIcons: bad }), { message: 'hive.config.json: "fileIcons" must be an object with set, scope, muted' }, String(bad));
  }
  for (const set of [undefined, 'seti', 'Material']) {
    assert.throws(() => parseConfig({ ...GITHUB, fileIcons: { ...icons, set } }), { message: 'hive.config.json: "fileIcons.set" must be one of: material, vscode, none' }, String(set));
  }
  for (const scope of [undefined, 'files', 'Folders']) {
    assert.throws(() => parseConfig({ ...GITHUB, fileIcons: { ...icons, scope } }), { message: 'hive.config.json: "fileIcons.scope" must be one of: all, folders' }, String(scope));
  }
  for (const muted of [undefined, 'yes', 1]) {
    assert.throws(() => parseConfig({ ...GITHUB, fileIcons: { ...icons, muted } }), { message: 'hive.config.json: "fileIcons.muted" must be true or false' }, String(muted));
  }
});

test('parseConfig requires sidebarsPerView: left, right and rightTab, each a boolean named when wrong, with no default; rightTab is kept while right is off (#821)', () => {
  assert.deepEqual(parseConfig(GITHUB).sidebarsPerView, { left: true, right: true, rightTab: true }, 'what combConfig writes: the form default');
  const kept = { left: false, right: false, rightTab: true };
  assert.deepEqual(parseConfig({ ...GITHUB, sidebarsPerView: kept }).sidebarsPerView, kept, 'rightTab as written while right is off');
  for (const bad of [undefined, null, true, []]) {
    assert.throws(() => parseConfig({ ...GITHUB, sidebarsPerView: bad }), { message: 'hive.config.json: "sidebarsPerView" must be an object with left, right, rightTab' }, String(bad));
  }
  for (const field of ['left', 'right', 'rightTab'] as const) {
    for (const value of [undefined, 'yes', 1]) {
      assert.throws(() => parseConfig({ ...GITHUB, sidebarsPerView: { ...kept, [field]: value } }), { message: `hive.config.json: "sidebarsPerView.${field}" must be true or false` }, `${field} ${String(value)}`);
    }
  }
});

test('parseConfig requires notifications: waiting, approval, pr and failed, each a boolean named when wrong, with no default; an unknown field is dropped (#199)', () => {
  assert.deepEqual(parseConfig(GITHUB).notifications, { waiting: true, approval: true, pr: true, failed: true }, 'what combConfig writes: the form default');
  const some = { waiting: false, approval: true, pr: false, failed: true };
  assert.deepEqual(parseConfig({ ...GITHUB, notifications: { ...some, sound: 'ping' } }).notifications, some, 'an unknown field is ignored');
  for (const bad of [undefined, null, true, []]) {
    assert.throws(() => parseConfig({ ...GITHUB, notifications: bad }), { message: 'hive.config.json: "notifications" must be an object with waiting, approval, pr, failed' }, String(bad));
  }
  for (const field of ['waiting', 'approval', 'pr', 'failed'] as const) {
    for (const value of [undefined, 'yes', 1]) {
      assert.throws(() => parseConfig({ ...GITHUB, notifications: { ...some, [field]: value } }), { message: `hive.config.json: "notifications.${field}" must be true or false` }, `${field} ${String(value)}`);
    }
  }
});

test('parseConfig requires signals: green, yellow, red and onOpen, each field named when wrong, a boolean newTasks refused, green ≥ yellow ≥ red, no default (#727, #32)', () => {
  assert.deepEqual(parseConfig(GITHUB).signals, SIGNALS_DEFAULTS, 'what combConfig writes: the form default');
  const with_ = (signals: unknown) => parseConfig({ ...GITHUB, signals });
  for (const bad of [undefined, null, true, []]) {
    assert.throws(() => with_(bad), { message: 'hive.config.json: "signals" must be an object with green, yellow, red, onOpen' }, String(bad));
  }
  assert.throws(() => with_({ ...SIGNALS_DEFAULTS, green: undefined }), { message: 'hive.config.json: "signals.green" must be an object with newTasks' }, 'a missing green');
  assert.throws(() => with_({ ...SIGNALS_DEFAULTS, green: { newTasks: true } }), { message: 'hive.config.json: "signals.green.newTasks" must be one of: never, tree, always' });
  assert.throws(() => with_({ ...SIGNALS_DEFAULTS, yellow: 'x' }), { message: 'hive.config.json: "signals.yellow" must be an object with newTasks, started, workerless' });
  const red = (patch: Record<string, unknown>) => with_({ ...SIGNALS_DEFAULTS, red: { ...SIGNALS_DEFAULTS.red, ...patch } });
  assert.throws(() => red({ newTasks: false }), { message: 'hive.config.json: "signals.red.newTasks" must be one of: never, tree, always' }, 'a boolean is refused');
  assert.throws(() => red({ started: 'go' }), { message: 'hive.config.json: "signals.red.started" must be one of: stay, continueOnly, resumeAndContinue' });
  assert.throws(() => red({ workerless: 1 }), { message: 'hive.config.json: "signals.red.workerless" must be true or false' });
  assert.throws(() => with_({ ...SIGNALS_DEFAULTS, onOpen: 'blue' }), { message: 'hive.config.json: "signals.onOpen" must be one of: yellow, last, green' });
  assert.throws(() => red({ newTasks: 'always' }), { message: /^hive\.config\.json: "signals\.red" may not allow more than "signals\.yellow"/ });
  assert.throws(() => with_({ ...SIGNALS_DEFAULTS, green: { newTasks: 'never' } }), { message: /nor "signals\.yellow" more than "signals\.green": per behaviour, never < tree < always/ }, 'yellow over green');
  const custom = { green: { newTasks: 'tree' }, yellow: { newTasks: 'tree', started: 'continueOnly', workerless: false }, red: { newTasks: 'never', started: 'stay', workerless: false }, onOpen: 'last' };
  assert.deepEqual(with_(custom).signals, custom);
});

test('editor is required and parsed against the Comb\'s workspaces; workspaces[].format is refused; a refusal names the key (#780)', () => {
  const at = (extra: Record<string, unknown>) => parseConfig(github(extra));
  assert.deepEqual(at({}).editor, EDITOR_DEFAULTS);
  assert.throws(() => at({ editor: undefined }), { message: /^hive\.config\.json: editor is required/ });
  assert.throws(() => at({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', format: { onSave: true, formatters: {}, custom: [] } }] }),
    { message: 'hive.config.json: "comb.workspaces[0].format" moved to "editor" (#780): one config for every workspace' });
  assert.throws(() => at({ editor: { formatOnSave: { enabled: true, workspaces: ['gone'] }, languages: {} } }),
    { message: /^hive\.config\.json: editor\.formatOnSave\.workspaces names workspace gone, which is not in comb\.workspaces$/ });
});

test('reviewer is optional: absent, or a field left out, takes REVIEWER_DEFAULTS; an unknown field is dropped; each malformed field is refused naming its key (#328)', () => {
  const at = (reviewer: unknown) => parseConfig(github({ reviewer })).reviewer;
  assert.deepEqual(parseConfig(GITHUB).reviewer, REVIEWER_DEFAULTS, 'combConfig writes no reviewer: a file from before the key');
  assert.deepEqual(at({}), REVIEWER_DEFAULTS);
  assert.deepEqual(at({ when: 'type', agent: 'codex', stray: 1 }), { ...REVIEWER_DEFAULTS, when: 'type', agent: 'codex' });
  const full = { on: false, when: 'demand', agent: 'claude', model: 'claude-opus-4-1', version: 'strict' };
  assert.deepEqual(at(full), full);
  const shape = '"reviewer" must be an object with on, when, agent, model, version';
  const refused: [unknown, string][] = [
    [null, shape], [[], shape], [true, shape],
    [{ on: 'yes' }, '"reviewer.on" must be true or false'],
    [{ on: null }, '"reviewer.on" must be true or false'],
    [{ when: 'always' }, '"reviewer.when" must be one of: type, save, demand'],
    [{ agent: 'gemini' }, '"reviewer.agent" must be one of: claude, codex'],
    [{ model: '--help' }, '"reviewer.model" must be null or a model name'],
    [{ model: 7 }, '"reviewer.model" must be null or a model name'],
    [{ version: 'original' }, '"reviewer.version" must be null or a version name'],
    [{ version: '../x' }, '"reviewer.version" must be null or a version name'],
  ];
  for (const [reviewer, message] of refused) {
    assert.throws(() => at(reviewer), { message: `hive.config.json: ${message}` }, JSON.stringify(reviewer));
  }
});

test('parseConfig reads a wait-for-CI stage: which checks, the list only with list, the re-run switch and an optional wait; refuses each key without the action and every other action\'s key beside it (#834)', () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'ci', from: { board: ['CI'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  const ok = { action: 'waitForCi', ciChecks: 'list', checks: [' build ', 'e2e-*'], rerunOnce: true, timeout: '60m' };
  assert.deepEqual(parsed(ok), { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'list', checks: ['build', 'e2e-*'], rerunOnce: true, timeout: '60m' });
  assert.deepEqual(parsed({ action: 'waitForCi', ciChecks: 'required', rerunOnce: false }), { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'required', rerunOnce: false }, 'no timeout: no limit');
  const list = '"comb.stages[0].checks" must be a non-empty array of distinct check names or patterns';
  const which = '"comb.stages[0].ciChecks" must be "required", "all" or "list"';
  const wait = '"comb.stages[0].timeout" must be a timeout like "30s", "10m" or "1h", up to 24h';
  const refused: [Record<string, unknown>, string][] = [
    [{ ciChecks: 'all' }, '"comb.stages[0].ciChecks" needs "action": "waitForCi"'],
    [{ rerunOnce: true }, '"comb.stages[0].rerunOnce" needs "action": "waitForCi"'],
    [{ timeout: '1h' }, '"comb.stages[0].timeout" needs "action": "waitForCi"'],
    [{ action: 'commands', commands: ['build'], stopOnFailure: true, onMissing: 'fail', checks: ['x'] }, '"comb.stages[0].checks" needs "action": "waitForCi"'],
    [{ ...ok, ciChecks: 'some' }, which],
    [{ ...ok, ciChecks: undefined }, which],
    [{ ...ok, ciChecks: 'all' }, '"comb.stages[0].checks" needs "ciChecks": "list"'],
    [{ ...ok, checks: [] }, list],
    [{ ...ok, checks: ['build', ' build'] }, list],
    [{ ...ok, checks: ['build', ' '] }, list],
    [{ ...ok, checks: undefined }, list],
    [{ ...ok, rerunOnce: 'yes' }, '"comb.stages[0].rerunOnce" must be true or false'],
    [{ ...ok, timeout: '1d' }, wait],
    [{ ...ok, timeout: '25h' }, wait],
    [{ ...ok, prompt: '/x' }, '"comb.stages[0].action" cannot be combined with "prompt"'],
    [{ ...ok, approval: true }, '"comb.stages[0].approval" cannot be combined with "action"'],
    [{ ...ok, agent: 'claude' }, '"comb.stages[0].agent" cannot be combined with "action"'],
    [{ ...ok, handoff: true }, '"comb.stages[0].handoff" cannot be combined with "action"'],
    [{ ...ok, model: 'opus' }, '"comb.stages[0].model" cannot be combined with "action": "waitForCi"'],
    [{ ...ok, session: 'new' }, '"comb.stages[0].session" cannot be combined with "action": "waitForCi"'],
    [{ ...ok, commands: ['build'] }, '"comb.stages[0].commands" needs "action": "commands"'],
    [{ ...ok, stopOnFailure: true }, '"comb.stages[0].stopOnFailure" needs "action": "commands"'],
    [{ ...ok, onMissing: 'fail' }, '"comb.stages[0].onMissing" needs "action": "commands"'],
  ];
  for (const [extra, message] of refused) assert.throws(bad(extra), { message: `hive.config.json: ${message}` }, JSON.stringify(extra));
});

test('parseConfig reads an evaluate stage: reviewers with a focus, a judge with none, a 0..10 threshold and a rubric with a line; refuses each key without the action, a bad row and every other key beside it (#877)', () => {
  const stage = (extra: Record<string, unknown>) => ({ name: 'eval', from: { board: ['Eval'] }, ...extra });
  const parsed = (extra: Record<string, unknown>) => parseConfig(github({ stages: [stage(extra)] })).comb.stages[0];
  const bad = (extra: Record<string, unknown>) => () => parseConfig(github({ stages: [stage(extra)] }));
  const ok = {
    action: 'evaluate',
    reviewers: [{ agent: 'claude', specializedAgent: 'hive:security-reviewer', focus: ' security and data ' }, { agent: 'codex', model: 'gpt-5.6-terra', focus: 'the spec' }],
    judge: { agent: 'claude', model: 'opus' }, threshold: 7, rubric: 'Meets {result.spec}?\n\n  Tests cover it?  ',
  };
  assert.deepEqual(parsed(ok), {
    name: 'eval', from: { board: ['Eval'] }, action: 'evaluate',
    reviewers: [{ agent: 'claude', specializedAgent: 'hive:security-reviewer', focus: 'security and data' }, { agent: 'codex', model: 'gpt-5.6-terra', focus: 'the spec' }],
    judge: { agent: 'claude', model: 'opus' }, threshold: 7, rubric: 'Meets {result.spec}?\n\n  Tests cover it?  ',
  }, 'the rubric is kept as typed: rubricLines reads it');
  assert.deepEqual(parsed({ ...ok, reviewers: [], threshold: 0 }).reviewers, [], 'no reviewer: the judge reads the work alone');
  const f = (key: string) => `"comb.stages[0].${key}"`;
  const refused: [Record<string, unknown>, string][] = [
    [{ reviewers: [] }, `${f('reviewers')} needs "action": "evaluate"`],
    [{ judge: { agent: 'claude' } }, `${f('judge')} needs "action": "evaluate"`],
    [{ threshold: 7 }, `${f('threshold')} needs "action": "evaluate"`],
    [{ rubric: 'x' }, `${f('rubric')} needs "action": "evaluate"`],
    [{ ...ok, reviewers: undefined }, `${f('reviewers')} must be an array of reviewers`],
    [{ ...ok, judge: undefined }, `${f('judge')} must be an object`],
    [{ ...ok, reviewers: [{ agent: 'gemini', focus: 'x' }] }, `${f('reviewers[0].agent')} must be one of: claude, codex`],
    [{ ...ok, reviewers: [{ agent: 'claude', focus: '  ' }] }, `${f('reviewers[0].focus')} must be a non-empty string`],
    [{ ...ok, reviewers: [{ agent: 'claude', focus: 'x', model: '-rf' }] }, `${f('reviewers[0].model')} must be a model name`],
    [{ ...ok, reviewers: [{ agent: 'claude', focus: 'x', specializedAgent: 'reviewer' }] }, `${f('reviewers[0].specializedAgent')} must be hive:<name>, lowercase letters, digits and hyphens`],
    [{ ...ok, judge: { agent: 'claude', focus: 'x' } }, `${f('judge.focus')} is a reviewer's: the judge has none`],
    [{ ...ok, threshold: 11 }, `${f('threshold')} must be an integer from 0 to 10`],
    [{ ...ok, threshold: 6.5 }, `${f('threshold')} must be an integer from 0 to 10`],
    [{ ...ok, threshold: undefined }, `${f('threshold')} must be an integer from 0 to 10`],
    [{ ...ok, rubric: ' \n\t\n' }, `${f('rubric')} must hold at least one dimension: a non-blank line`],
    [{ ...ok, model: 'opus' }, `${f('model')} cannot be combined with "action": "evaluate"`],
    [{ ...ok, session: 'new' }, `${f('session')} cannot be combined with "action": "evaluate"`],
    [{ ...ok, prompt: '/x' }, `${f('action')} cannot be combined with "prompt"`],
    [{ ...ok, approval: true }, `${f('approval')} cannot be combined with "action"`],
    [{ ...ok, agent: 'claude' }, `${f('agent')} cannot be combined with "action"`],
    [{ ...ok, handoff: true }, `${f('handoff')} cannot be combined with "action"`],
    [{ ...ok, verdicts: ['x'] }, `${f('verdicts')} cannot be combined with "action": its verdicts are fixed`],
    [{ ...ok, specializedAgent: 'hive:x' }, `${f('specializedAgent')} needs a stage that runs an agent: a "prompt" or "action": "skill"`],
    [{ ...ok, commands: ['build'] }, `${f('commands')} needs "action": "commands"`],
    [{ ...ok, timeout: '1h' }, `${f('timeout')} needs "action": "waitForCi"`],
  ];
  for (const [extra, message] of refused) assert.throws(bad(extra), { message: `hive.config.json: ${message}` }, JSON.stringify(extra));
});

test('a workspace\'s nestedRepos and notNestedRepos are required lists of relative paths, each once, never .hive, never in both lists (#653)', () => {
  const at = (extra: Record<string, unknown>) => github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', ...extra }] });
  const workspace = (extra: Record<string, unknown>) => parseConfig(at(extra)).comb.workspaces[0];
  const refused = (extra: Record<string, unknown>, message: string) =>
    assert.throws(() => parseConfig(at(extra)), { message: `hive.config.json: ${message}` }, JSON.stringify(extra));
  const kept = workspace({ nestedRepos: ['docs', 'ee/core'], notNestedRepos: ['vendor'] });
  assert.deepEqual([kept.nestedRepos, kept.notNestedRepos], [['docs', 'ee/core'], ['vendor']]);
  refused({ nestedRepos: undefined }, '"comb.workspaces[0].nestedRepos" must be a list of relative paths');
  refused({ notNestedRepos: 'docs' }, '"comb.workspaces[0].notNestedRepos" must be a list of relative paths');
  for (const path of ['../docs', 'docs/../ee', '/abs/docs', 'docs/', './docs', 'a//b', '', 7]) {
    refused({ nestedRepos: [path] }, '"comb.workspaces[0].nestedRepos[0]" must be a relative path inside the workspace, with no "..", "." or trailing "/"');
  }
  for (const path of ['.hive', '.hive/worktrees']) refused({ notNestedRepos: [path] }, '"comb.workspaces[0].notNestedRepos[0]" cannot be .hive or inside it');
  refused({ nestedRepos: ['docs', 'docs'] }, '"comb.workspaces[0].nestedRepos[1]" repeats docs');
  refused({ nestedRepos: ['docs'], notNestedRepos: ['ee', 'docs'] }, '"comb.workspaces[0].notNestedRepos[1]" is docs, which nestedRepos lists');
});

test('a workspace\'s fork is required: null, false or the object; sync only with pr fork or ask and required there; the remote is a remote name and never origin; baseBranch is a branch, and empty drops it (#854)', () => {
  const at = (extra: Record<string, unknown>) => github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', ...extra }] });
  const workspace = (extra: Record<string, unknown>) => parseConfig(at(extra)).comb.workspaces[0];
  const refused = (extra: Record<string, unknown>, message: string) =>
    assert.throws(() => parseConfig(at(extra)), { message: `hive.config.json: ${message}` }, JSON.stringify(extra));
  assert.equal(workspace({ fork: null }).fork, null);
  assert.equal(workspace({ fork: false }).fork, false);
  assert.deepEqual(workspace({ fork: { remote: 'upstream', pr: 'original' } }).fork, { remote: 'upstream', pr: 'original' });
  for (const pr of ['fork', 'ask']) {
    for (const sync of ['github', 'local', 'manual']) assert.deepEqual(workspace({ fork: { remote: 'up-stream.2', pr, sync } }).fork, { remote: 'up-stream.2', pr, sync });
  }
  const shape = '"comb.workspaces[0].fork" must be null, false or { "remote", "pr" }';
  for (const extra of [{}, { fork: true }, { fork: 'upstream' }]) refused(extra, shape);
  for (const remote of ['origin', '', '-x', 'a b', 7, '.', '..', '...']) refused({ fork: { remote, pr: 'original' } }, '"comb.workspaces[0].fork.remote" must be a git remote name other than origin');
  refused({ fork: { remote: 'upstream', pr: 'mine' } }, '"comb.workspaces[0].fork.pr" must be "original", "fork" or "ask"');
  refused({ fork: { remote: 'upstream', pr: 'original', sync: 'github' } }, '"comb.workspaces[0].fork.sync" needs "pr": "fork" or "ask"');
  for (const sync of [undefined, 'often']) refused({ fork: { remote: 'upstream', pr: 'fork', sync } }, '"comb.workspaces[0].fork.sync" must be "github", "local" or "manual"');
  assert.equal(workspace({ fork: null, baseBranch: 'devtest' }).baseBranch, 'devtest');
  assert.equal('baseBranch' in workspace({ fork: null, baseBranch: '' }), false, 'the form\'s empty field drops it');
  refused({ fork: null, baseBranch: '-x' }, '"comb.workspaces[0].baseBranch" must be a branch name');
});

// #134: the flow of the spec's example, on the fixture's board source
const FLOW_STAGES = [
  { name: 'Spec', from: { board: ['Backlog'] }, prompt: '/hive:new-spec {url}', approval: true, verdicts: ['needs design', 'ready'] },
  { name: 'Build', from: { board: ['In progress'] }, prompt: '/hive:new-build' },
  { name: 'Checks', from: {}, action: 'waitForCi', ciChecks: 'all', rerunOnce: false },
  { name: 'PR', from: { board: ['Review'] }, approval: true },
];
const FULL = [
  { from: 'Spec', to: 'Spec', when: 'feedback', prompt: 'Revise a spec com este feedback:\n\n{feedback}', session: 'previous' },
  { from: 'Spec', to: 'Build', when: 'approved', session: 'new', sources: { board: [{ type: 'move', column: 'In progress' }] } },
  { from: 'Spec', to: 'Build', when: 'verdict', verdict: 'ready', label: 'pronta' },
  { from: 'Build', to: 'Checks', when: 'done' },
  { from: 'Checks', to: 'PR', when: 'verdict', verdict: 'passed' },
  { from: 'Checks', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 3, prompt: 'Os checks falharam:\n\n{verdict}', session: { continueOf: 'Build' } },
  { from: 'PR', to: 'Build', when: 'feedback', session: { continueOf: 'Build' } },
  { from: 'PR', to: 'end', when: 'approved', sources: { board: [{ type: 'close' }] } },
];
const withFlow = (transitions: unknown, stages: unknown[] = FLOW_STAGES) => parseConfig(github({ stages, transitions }));

test('parseConfig reads comb.transitions: required, [] allowed; prompts, sessions, tries, labels, sources and a prompt stage\'s verdicts kept as written (#134)', () => {
  assert.deepEqual(withFlow(FULL).comb.transitions, FULL);
  assert.deepEqual(withFlow([]).comb.transitions, []);
  assert.deepEqual(withFlow(FULL).comb.stages[0].verdicts, ['needs design', 'ready']);
  const raw = github({ stages: FLOW_STAGES, transitions: FULL });
  assert.throws(() => parseConfig({ ...raw, comb: { ...(raw.comb as Record<string, unknown>), transitions: undefined } }), { message: 'hive.config.json: "comb.transitions" is required' });
  assert.throws(() => withFlow({}), { message: 'hive.config.json: "comb.transitions" must be an array' });
});

test('parseConfig refuses a transition naming no stage, a bad trigger or verdict, a user trigger without approval, done after approval, a gate\'s feedback to itself, bad tries, a bad session, a bad label, bad sources and a repeated (from, when, verdict) (#134)', () => {
  const at = `hive.config.json: "comb.transitions[${FULL.length}]`;
  const refused: [Record<string, unknown>, string][] = [
    [{ from: 'Nope', to: 'Build', when: 'done' }, '.from" names no stage'],
    [{ from: 'Build', to: 'Nope', when: 'done' }, '.to" names no stage nor "end"'],
    [{ from: 'Build', to: 'PR', when: 'finished' }, '.when" must be "done", "approved", "feedback" or "verdict"'],
    [{ from: 'Build', to: 'PR', when: 'done', verdict: 'ok' }, '.verdict" needs "when": "verdict"'],
    [{ from: 'Checks', to: 'PR', when: 'verdict' }, '.verdict" is required with "when": "verdict"'],
    [{ from: 'Checks', to: 'PR', when: 'verdict', verdict: 'flaky' }, '.verdict" must be one of "Checks"\'s verdicts: passed, failed'],
    [{ from: 'Spec', to: 'PR', when: 'verdict', verdict: 'passed' }, '.verdict" must be one of "Spec"\'s verdicts: needs design, ready'],
    [{ from: 'Build', to: 'PR', when: 'verdict', verdict: 'ok' }, '.verdict" names a verdict "Build" cannot give: it has none'],
    [{ from: 'PR', to: 'Build', when: 'verdict', verdict: 'passed' }, '.verdict" names a verdict "PR" cannot give: it has none'],
    [{ from: 'Build', to: 'PR', when: 'approved' }, '.when" "approved" needs "Build" to have "approval"'],
    [{ from: 'Build', to: 'Spec', when: 'feedback' }, '.when" "feedback" needs "Build" to have "approval"'],
    [{ from: 'Spec', to: 'PR', when: 'done' }, '.when" "done" cannot leave "Spec", which has "approval": use "approved"'],
    [{ from: 'Checks', to: 'PR', when: 'done' }, '.when" "done" cannot leave "Checks", which ends with a verdict: use "verdict" with "passed" or "failed"'],
    [{ from: 'PR', to: 'PR', when: 'feedback' }, '.to" cannot be the gate itself: a gate runs nothing, so its feedback goes to another stage'],
    [{ from: 'Spec', to: 'Build', when: 'approved', maxTries: 2 }, '.maxTries" only goes with "when": "done" or "verdict": your transitions have no limit'],
    [{ from: 'Checks', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 0 }, '.maxTries" must be an integer ≥ 1'],
    [{ from: 'Checks', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 1.5 }, '.maxTries" must be an integer ≥ 1'],
    [{ from: 'Build', to: 'PR', when: 'done', session: 'continue' }, '.session" must be "previous", "new" or { "continueOf": "<stage>" }'],
    [{ from: 'Build', to: 'PR', when: 'done', session: { continueOf: 'Nope' } }, '.session.continueOf" names no stage'],
    [{ from: 'Build', to: 'PR', when: 'done', label: ' ' }, '.label" must be a non-empty string'],
    [{ from: 'Build', to: 'PR', when: 'done', prompt: 7 }, '.prompt" must be a non-empty string'],
    [{ from: 'Build', to: 'PR', when: 'done', sources: { nope: [] } }, '.sources.nope" names no source'],
    [{ from: 'Build', to: 'PR', when: 'done', sources: { board: [{ type: 'archive' }, { type: 'move', column: 'Done' }] } }, '.sources.board[0].type" "archive" takes the task off its source, so it must be the last action'],
  ];
  for (const [extra, message] of refused) assert.throws(() => withFlow([...FULL, extra]), { message: `${at}${message}` }, JSON.stringify(extra));
  assert.throws(() => withFlow([...FULL, { from: 'Build', to: 'PR', when: 'done' }]), { message: `${at}" repeats the "from", "when" and "verdict" of an earlier transition` });
  const clean = { name: 'Clean', from: {}, action: 'deleteActivity' };
  assert.deepEqual(withFlow([...FULL, { from: 'Clean', to: 'end', when: 'done' }], [...FLOW_STAGES, clean]).comb.transitions.at(-1), { from: 'Clean', to: 'end', when: 'done' }, 'a delete activity ends with done');
});

test('a transition from an evaluate stage takes verdict passed or failed with maxTries, and never done (#877)', () => {
  const evaluate = { name: 'eval', from: {}, action: 'evaluate', reviewers: [], judge: { agent: 'claude' }, threshold: 7, rubric: 'a' };
  const flow = (transitions: unknown[]) => () => withFlow(transitions, [...FLOW_STAGES, evaluate]);
  assert.doesNotThrow(flow([{ from: 'eval', when: 'verdict', verdict: 'failed', to: 'Build', maxTries: 3 }, { from: 'eval', when: 'verdict', verdict: 'passed', to: 'PR' }]));
  assert.throws(flow([{ from: 'eval', when: 'done', to: 'PR' }]), /"done" cannot leave "eval", which ends with a verdict/);
  assert.throws(flow([{ from: 'eval', when: 'verdict', verdict: 'approved', to: 'PR' }]), /must be one of "eval"'s verdicts: passed, failed/);
});

test('a stage\'s verdicts: prompt stages only, a non-empty list of distinct trimmed names; no stage may be named end (#134)', () => {
  const one = (stage: Record<string, unknown>) => () => parseConfig(github({ stages: [{ name: 'Build', from: { board: ['Ready'] }, ...stage }], transitions: [] }));
  const v = 'hive.config.json: "comb.stages[0].verdicts" ';
  assert.throws(one({ action: 'waitForCi', ciChecks: 'all', rerunOnce: false, verdicts: ['ok'] }), { message: `${v}cannot be combined with "action": its verdicts are fixed` });
  assert.throws(one({ approval: true, verdicts: ['ok'] }), { message: `${v}needs "prompt": a stage that runs nothing gives no verdict` });
  for (const verdicts of [[], ['ok', 'ok'], [' ok'], [''], 'ok', [1]]) {
    assert.throws(one({ prompt: '/b', verdicts }), { message: `${v}must be a non-empty array of distinct, trimmed names` }, JSON.stringify(verdicts));
  }
  assert.throws(() => parseConfig(github({ stages: [{ name: 'end', from: { board: ['Ready'] } }], transitions: [] })), { message: 'hive.config.json: "comb.stages[0].name" cannot be "end": it names the end of the flow' });
});

const WITH_REPO = { ...GITHUB_SOURCE, repository: 'acme/app' };

test('parseConfig reads comb.hiveSource, comb.createIn and a GitHub source\'s repository; an absent repository stays absent (#846)', () => {
  const config = parseConfig(github({ source: WITH_REPO, hiveSource: false, createIn: 'board' }));
  assert.deepEqual([config.comb.hiveSource, config.comb.createIn, config.comb.sources[0].repository], [false, 'board', 'acme/app']);
  assert.deepEqual([parseConfig(github()).comb.hiveSource, parseConfig(github()).comb.createIn], [true, 'hive']);
  assert.equal('repository' in parseConfig(github()).comb.sources[0], false);
});

test('parseConfig refuses each comb.createIn rule and a malformed repository, naming the key (#846)', () => {
  assert.throws(() => parseConfig(github({ hiveSource: 'yes' })), { message: 'hive.config.json: "comb.hiveSource" must be true or false' });
  assert.throws(() => parseConfig(github({ createIn: '' })), { message: 'hive.config.json: "comb.createIn" must be a non-empty string' });
  assert.throws(() => parseConfig(github({ createIn: 'nope' })), { message: 'hive.config.json: "comb.createIn" must be "hive" or a source\'s name' });
  assert.throws(() => parseConfig(github({ hiveSource: false })), { message: 'hive.config.json: "comb.createIn" is "hive" but "comb.hiveSource" is false' });
  assert.throws(() => parseConfig(github({ createIn: 'board' })), { message: 'hive.config.json: "comb.createIn" names a source without "repository"' });
  assert.throws(() => parseConfig(combConfig({ stages: LOCAL_STAGES, hiveSource: false })), { message: 'hive.config.json: "comb.hiveSource" can be false only with at least one source' });
  for (const repository of ['acme', 'acme/app/x', 'a b/c', 7]) {
    assert.throws(() => parseConfig(github({ source: { ...GITHUB_SOURCE, repository } })), /"comb\.sources\[0\]\.repository" must be a repository as owner\/name/, String(repository));
  }
});

test('a workspace\'s color is required: one of the 7 presets as written or a lowercase #rrggbb; anything else is refused naming the key (#78)', () => {
  const at = (color: unknown) => github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color }] });
  for (const color of [...WORKSPACE_PRESET_COLORS, '#a1b2c3']) assert.equal(parseConfig(at(color)).comb.workspaces[0].color, color, color);
  const message = 'hive.config.json: "comb.workspaces[0].color" must be one of the preset colours or a lowercase #rrggbb colour';
  for (const bad of [undefined, '#ABC123', '#abc', 'red', 'oklch(0.5 0.1 25)', 7]) assert.throws(() => parseConfig(at(bad)), { message }, String(bad));
});

test('a workspace\'s memoryCap is a required integer from 300 to 20000, refused naming the key and the range (#73)', () => {
  const at = (memoryCap: unknown) => github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap, color: 'oklch(0.72 0.12 25)', benchmarkPrIn: 'worktree' }] });
  assert.deepEqual([300, 20000].map((cap) => parseConfig(at(cap)).comb.workspaces[0].memoryCap), [300, 20000]);
  const message = 'hive.config.json: "comb.workspaces[0].memoryCap" must be an integer from 300 to 20000';
  for (const bad of [299, 20001, 4000.5, '4000', undefined]) assert.throws(() => parseConfig(at(bad)), { message }, String(bad));
});

test('a workspace\'s benchmarkPrIn is required: worktree or checkout, and a missing or other value is refused naming the key and its values (#477)', () => {
  const at = (extra: Record<string, unknown>) => github({ workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)', ...extra }] });
  for (const via of ['worktree', 'checkout'] as const) assert.equal(parseConfig(at({ benchmarkPrIn: via })).comb.workspaces[0].benchmarkPrIn, via);
  const message = 'hive.config.json: "comb.workspaces[0].benchmarkPrIn" must be one of: worktree, checkout';
  for (const benchmarkPrIn of [undefined, 'elsewhere', '', true]) assert.throws(() => parseConfig(at({ benchmarkPrIn })), { message }, String(benchmarkPrIn));
});

test('a codex stage, by its own agent or the default, refuses a Claude model naming the field, fable included; a Codex model passes and a claude stage keeps its aliases (#927, #257)', () => {
  const withStage = (extra: Record<string, unknown>, top: Record<string, unknown> = {}) => github({ stages: [{ ...STAGES[0], ...extra }], ...top });
  for (const model of ['fable', 'fable[1m]', 'opus', 'sonnet', 'haiku', 'sonnet[1m]', 'claude-sonnet-4']) {
    const message = `hive.config.json: "comb.stages[0].model" "${model}" is a Claude model; a codex stage needs a Codex model name`;
    assert.throws(() => parseConfig(withStage({ agent: 'codex', model })), { message }, model);
  }
  assert.throws(() => parseConfig(withStage({ model: 'opus' }, { defaultAgent: 'codex' })), /"comb\.stages\[0\]\.model" "opus" is a Claude model/, 'the default agent counts');
  assert.equal(parseConfig(withStage({ agent: 'codex', model: 'gpt-5.6-terra' })).comb.stages[0].model, 'gpt-5.6-terra');
  assert.equal(parseConfig(withStage({ model: 'opus' })).comb.stages[0].model, 'opus', 'a claude stage keeps its aliases');
});

test('parseConfig reads a month rule and a plan rule\'s agent; it refuses an unknown agent and an agent on a budget source (#929)', () => {
  const usageRules = [
    { source: 'month', percent: 40, signal: 'yellow', agent: 'codex' }, { source: 'week', percent: 90, signal: 'red', agent: 'claude' },
    { source: 'session', percent: 80, maxWorkers: 1 },
  ];
  assert.deepEqual(parseConfig({ ...GITHUB, usageRules }).usageRules, usageRules);
  const rules = (rule: unknown) => () => parseConfig({ ...GITHUB, usageRules: [rule] });
  assert.throws(rules({ source: 'week', percent: 90, signal: 'red', agent: 'gemini' }), { message: 'hive.config.json: "usageRules[0].agent" must be one of: claude, codex' });
  for (const source of ['hour', 'day']) {
    assert.throws(rules({ source, percent: 50, signal: 'red', agent: 'codex' }), { message: 'hive.config.json: "usageRules[0].agent" only applies to a plan source (session, week, month)' }, source);
  }
});

test('mcp is required: combConfig writes the defaults; a file without it, or with a locked tool in off, is refused naming the key (#333)', () => {
  assert.deepEqual(parseConfig(GITHUB).mcp, MCP_DEFAULTS);
  assert.throws(() => parseConfig(github({ mcp: undefined })), { message: 'hive.config.json: "mcp" must be an object with off and servers' });
  assert.throws(() => parseConfig(github({ mcp: { off: ['hive_done'], servers: [] } })), { message: /^hive\.config\.json: "mcp\.off" holds hive_done: only / });
});

test('an mcp server scoped to a workspace the Comb does not have fails the parse naming the server; one scoped to a Comb workspace parses (#333)', () => {
  const figma = { name: 'figma', url: 'http://127.0.0.1:3845/mcp', workspace: 'hive-site', on: false };
  assert.equal(parseConfig(github({ mcp: { off: [], servers: [{ ...figma, workspace: 'hive' }] } })).mcp.servers[0].workspace, 'hive');
  assert.throws(() => parseConfig(github({ mcp: { off: [], servers: [figma] } })), { message: 'hive.config.json: "mcp.servers": figma is scoped to hive-site, which no longer exists' });
});
