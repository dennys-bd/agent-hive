import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/activities.js';
import { citedColumns, slugFor } from '../src/tasks.js';
import { parseConfig, workspaceScope } from '../src/config.js';
import { migrateConfig } from '../src/config-migrate.js';
import { loadState } from '../src/state-store.js';
import { BOARD_COLUMNS, FIXTURE_DIR, materializeTestConfig, readBoardEnv, readFixture, stopTestHive, testWorktrees } from '../scripts/test-home.js';
import { tempDir } from './temp-dir.js';

const VALUES = { workspace: '/repo/worktree', owner: 'octo-org', number: 7 };
const STAGES = ['Backlog', 'Plan', 'Dev', 'In Review', 'Done'];

test('the test home config, materialized, parses with no free worker, prefix TEST, the real five stages and the given workspace, owner and number; its stages cite exactly the columns the seed creates (HIVE-6)', async () => {
  const config = parseConfig(migrateConfig(materializeTestConfig(await readFixture('hive.config.json'), VALUES))); // as boot reads it: the fixture predates #516
  assert.deepEqual([config.comb.prefix, config.auth], ['TEST', { github: 'cli' }]);
  assert.equal('port' in config, false, 'the test Hive binds a free port of its own (#466)');
  assert.deepEqual(config.comb.workspaces.map((p) => [p.name, p.path]), [['agent-hive', '/repo/worktree']]);
  const [source] = config.comb.sources;
  assert.ok(source.type === 'github');
  assert.deepEqual([source.name, source.owner, source.number, source.taskProps, source.qualifyId], ['test', 'octo-org', 7, { defaults: { workspace: 'agent-hive', auto: true }, rules: [] }, false]);
  assert.deepEqual(config.comb.stages.map((s) => s.name), STAGES);
  assert.deepEqual(
    [...new Set(citedColumns(config.comb.stages, config.comb.transitions, 'test').map((c) => c.column))].sort(), [...BOARD_COLUMNS].sort(),
    'a stage citing a column the seed does not create would fail resolveFields on boot',
  );
});

test('materializeTestConfig leaves the fixture as it was, and its output holds none of the placeholders (HIVE-6)', async () => {
  const fixture = await readFixture('hive.config.json');
  const before = structuredClone(fixture);
  const out = JSON.stringify(materializeTestConfig(fixture, VALUES));
  assert.deepEqual(fixture, before);
  for (const placeholder of ['/path/to/project', '"@me"', '"number":0']) assert.ok(!out.includes(placeholder), placeholder);
});

test('loadState keeps every fixture task and every variant the board draws differently; each task sits in a config stage with its own slug, and localCount covers the highest TEST-n (HIVE-6)', async () => {
  const raw = (await readFixture('state.json')) as { tasks: unknown[] };
  const config = parseConfig(migrateConfig(await readFixture('hive.config.json')));
  const state = await loadState(FIXTURE_DIR, workspaceScope(config)); // #629: the scope boot passes, which the migration places activities by
  assert.equal(state.maxConcurrent, 0);
  assert.equal(state.tasks.length, raw.tasks.length, 'loadState drops a bad task, or the whole file, silently');
  const stages = config.comb.stages.map((s) => s.name);
  for (const task of state.tasks) {
    assert.ok(stages.includes(task.stage), `${task.item.id} sits in ${task.stage}`);
    assert.equal(activityOf(state, task.item.itemId)?.slug ?? slugFor(task.item), slugFor(task.item), task.item.id); // #629: its activity's, when it has one
    assert.deepEqual([task.created, task.workspace], [true, 'agent-hive'], task.item.id);
  }
  assert.deepEqual([...new Set(state.tasks.map((c) => c.stage))], STAGES, 'tasks in every stage');
  const highest = Math.max(...state.tasks.map((c) => Number(c.item.id.replace('TEST-', ''))));
  assert.ok(state.localCount >= highest, 'a task created in the test Hive must not reuse a fixture id');
  const has = (what: string, pick: (c: (typeof state.tasks)[number]) => unknown): void => assert.ok(state.tasks.some(pick), what);
  // #629: the run fields are on the migrated activity
  has('awaiting approval', (c) => activityOf(state, c.item.itemId)?.approval);
  has('stopped', (c) => activityOf(state, c.item.itemId)?.stopped);
  has('blocked', (c) => (c.item.blockedBy ?? []).length > 0);
  has('worktree gone', (c) => activityOf(state, c.item.itemId)?.worktreeGone); // #629: on the migrated activity
});

test('readBoardEnv returns the owner and the number; an owner that is not a GitHub login or a number that is not a positive integer throws naming its variable (HIVE-6)', () => {
  assert.deepEqual(readBoardEnv({ HIVE_TEST_BOARD_OWNER: 'octo-org', HIVE_TEST_BOARD_NUMBER: '7' }), { owner: 'octo-org', number: 7 });
  for (const owner of [undefined, '', '  ', '-R', 'a/b']) {
    assert.throws(() => readBoardEnv({ HIVE_TEST_BOARD_OWNER: owner, HIVE_TEST_BOARD_NUMBER: '7' }), /HIVE_TEST_BOARD_OWNER/, String(owner));
  }
  for (const number of [undefined, '', '0', '-3', '1.5', '7abc', 'seven']) {
    assert.throws(() => readBoardEnv({ HIVE_TEST_BOARD_OWNER: 'octo-org', HIVE_TEST_BOARD_NUMBER: number }), /HIVE_TEST_BOARD_NUMBER/, String(number));
  }
});

test('stopTestHive skips a home with no config, which never booted a Hive; with a config it stops (HIVE-6)', async (t) => {
  const home = await tempDir(t, 'test-home-');
  const stopped: string[] = [];
  const stop = async (h: string): Promise<boolean> => { stopped.push(h); return true; };
  assert.equal(await stopTestHive(home, stop), false);
  assert.deepEqual(stopped, []);
  await writeFile(join(home, 'hive.config.json'), '{}');
  assert.equal(await stopTestHive(home, stop), true);
  assert.deepEqual(stopped, [home]);
});

test('testWorktrees picks only the worktrees on a hive/TEST- branch, prunable or not, and skips a detached one', () => {
  const porcelain = [
    'worktree /repo\nHEAD aaa\nbranch refs/heads/main',
    'worktree /repo/.hive/worktrees/hive-456/.hive/worktrees/hive-test-1\nHEAD bbb\nbranch refs/heads/hive/TEST-1-dark-theme',
    'worktree /gone/hive-test-7\nHEAD ccc\nbranch refs/heads/hive/TEST-7-group\nprunable gitdir file points to non-existent location',
    'worktree /repo/.hive/worktrees/hive-456\nHEAD ddd\nbranch refs/heads/hive/456-left-panel',
    'worktree /detached\nHEAD eee\ndetached',
  ].join('\n\n');
  assert.deepEqual(testWorktrees(`${porcelain}\n`), [
    { path: '/repo/.hive/worktrees/hive-456/.hive/worktrees/hive-test-1', branch: 'hive/TEST-1-dark-theme' },
    { path: '/gone/hive-test-7', branch: 'hive/TEST-7-group' },
  ]);
});
