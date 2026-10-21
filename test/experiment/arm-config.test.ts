import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig } from '../../src/config.js';
import { migrateTransitions } from '../../src/config-migrate.js';
import { loadState } from '../../src/state-store.js';
import { ARM_COMMANDS, evalConfig, runConfig, runState, WORKSPACE_TEARDOWN, watchTasks, workspaceSetup } from '../../scripts/experiment/harness-config.js';
import type { Arm } from '../../scripts/experiment/types.js';
import { tempDir } from '../temp-dir.js';
import { BRANCH, PATHS, PREFIX, STAGES, TASKS, WORKSPACE } from './fixtures.js';
import { rulesOf } from './rules.js';

// Each arm's commands put back as placeholders: what is left must be the same config
const neutral = (config: unknown, arm: Arm): unknown =>
  JSON.parse(Object.entries(ARM_COMMANDS[arm]).reduce((text, [role, command]) => text.replaceAll(`/${command} `, `/<${role}> `), JSON.stringify(config)));
const firstWords = (config: Record<string, unknown>): string[] => (config.comb as { stages: { prompt?: string }[] }).stages.map((s) => s.prompt?.split(' ')[0] ?? '');

test('the configs of the two arms differ only in the three stage commands (#105)', () => {
  const a = runConfig(STAGES, 'a', BRANCH, WORKSPACE, PREFIX, PATHS);
  const b = runConfig(STAGES, 'b', BRANCH, WORKSPACE, PREFIX, PATHS);
  assert.notDeepEqual(a, b);
  assert.deepEqual(neutral(a, 'a'), neutral(b, 'b'));
  assert.deepEqual(firstWords(a).slice(0, 3), ['/hive-spec', '/hive-plan', '/hive-build']);
  assert.deepEqual(firstWords(b).slice(0, 3), ['/hive:new-spec', '/hive:new-plan', '/hive:new-build']);
});

test('runConfig fills {runBranch}, drops the roles, and parses as three workers, two in Build, one Merge, under the run prefix (#105)', () => {
  const raw = runConfig(STAGES, 'b', BRANCH, WORKSPACE, PREFIX, PATHS);
  const text = JSON.stringify(raw);
  for (const gone of ['{runBranch}', '{command}', '"role"']) assert.ok(!text.includes(gone), gone);
  assert.ok(text.includes('{title}') && text.includes('{body}'));
  const config = parseConfig(migrateTransitions(raw)); // the file loads through the migration, which chains the stages (#134)
  assert.deepEqual([config.baseBranch, config.comb.prefix, config.comb.sources], [BRANCH, PREFIX, []]);
  assert.deepEqual(config.comb.stages.map((s) => [s.name, s.maxWorkers, s.approval]), [
    ['Spec', 3, undefined], ['Plan', 3, undefined], ['Build', 2, undefined], ['Merge', 1, undefined], ['Done', undefined, undefined],
  ]);
  assert.deepEqual(config.comb.workspaces.map((w) => [w.name, w.path, w.setup, w.teardown]), [['agent-hive', WORKSPACE, workspaceSetup(BRANCH), WORKSPACE_TEARDOWN]]);
  const setup = workspaceSetup(BRANCH).split('\n');
  assert.deepEqual([setup[0], setup.at(-1)], ['COPY .claude/settings.local.json', 'RUN pnpm install --frozen-lockfile']);
  assert.ok(setup[1].endsWith(`"origin/${BRANCH}"; }`), 'a new docs branch starts from the docs run branch (#79)');
  assert.equal('port' in config, false, 'each daemon binds a free port of its own (#466): two homes never share one');
});

test('runConfig gives the workers the seed\'s rules plus the run\'s own: its push, its plugin copy, and the state folder denied (#105)', () => {
  const { agentArgs: { claude: claudeArgs } } = runConfig(STAGES, 'a', BRANCH, WORKSPACE, PREFIX, PATHS) as { agentArgs: { claude: string[] } };
  assert.deepEqual(rulesOf(claudeArgs, '--allowedTools'), ['Bash(git:*)', 'Read', 'Edit', 'Write', 'mcp__hive__*', `Bash(git push origin HEAD:${BRANCH}*)`, `Bash(git push origin *:${BRANCH}*)`, 'Read(//state/homes/abc123/plugins/**)']);
  assert.ok(rulesOf(claudeArgs, '--disallowedTools').includes('Read(//state/experiments/**)'));
  assert.deepEqual(STAGES.claudeArgs, ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(git:*) Read Edit Write mcp__hive__*'], 'the seed is left as it was');
});

test('evalConfig keeps the stage names with no prompt and no worker, in Portuguese, with two harmless run commands (#105)', () => {
  const config = parseConfig(migrateTransitions(evalConfig(STAGES, WORKSPACE)));
  assert.deepEqual([config.language, config.comb.prefix], ['pt', 'MON']);
  assert.deepEqual(config.comb.stages.map((s) => [s.name, s.prompt, s.maxWorkers]), [
    ['Spec', undefined, 0], ['Plan', undefined, 0], ['Build', undefined, 0], ['Merge', undefined, 0], ['Done', undefined, 0],
  ]);
  assert.deepEqual(config.comb.commands.map((c) => [c.name, c.impls, c.menu, c.timeout]), [
    ['hive test', [{ workspace: 'agent-hive', command: 'sleep 5 && echo ok' }], true, '1m'], ['falha', [{ workspace: 'agent-hive', command: 'sleep 2 && exit 1' }], true, '1m'],
  ]);

});

test('runState holds local tasks under the run prefix in the first stage, auto only when free of blockers, no blocker written; watchTasks is the graph (#105)', async (t) => {
  const home = await tempDir(t, 'arm-');
  await writeFile(join(home, 'state.json'), JSON.stringify(runState(TASKS, 'Spec', PREFIX)));
  const state = await loadState(home);
  assert.deepEqual(state.tasks.map((task) => [task.item.itemId, task.item.id, task.stage, task.auto]), [
    ['local:1', 'MABC123-1', 'Spec', true], ['local:2', 'MABC123-2', 'Spec', false], ['local:3', 'MABC123-3', 'Spec', true],
  ]);
  for (const task of state.tasks) {
    assert.equal(task.item.blockedBy, undefined, 'the harness releases the tasks');
    assert.deepEqual([task.created, task.workspace], [true, 'agent-hive']);
  }
  assert.deepEqual([state.localCount, state.activities, state.activityRecords], [3, [], []], 'no activity yet: the Hive makes a task\'s slug and worktree when it starts');
  assert.deepEqual(state.workers.map((w) => w.status), ['empty', 'empty', 'empty'], 'one free worker per MAX_CONCURRENT: a saved empty list would leave the daemon none to start a task with');
  assert.equal('auto' in state, false);
  assert.deepEqual(watchTasks(TASKS), [{ itemId: 'local:1', blockedBy: [] }, { itemId: 'local:2', blockedBy: ['local:1'] }, { itemId: 'local:3', blockedBy: [] }]);
});
