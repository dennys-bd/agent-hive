import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activityOf, localActivityId } from '../src/activities.js';
import { transcriptDir } from '../src/agents/claude-transcript.js';
import { parseConfig } from '../src/config.js';
import { initialState } from '../src/orchestrator.js';
import { exitEvent } from '../src/server-exit.js';
import type { Activity, Item, State, Worker } from '../src/types.js';
import { taskDir } from '../src/worktree.js';
import { combConfig, LOCAL_STAGES, WORKSPACE } from './fakes.js';
import { withLocal, withWork } from './fixtures/work.js';
import { type AfterHost, tempDir } from './temp-dir.js';

const REPO = '/repo';
const config = parseConfig(combConfig({ path: REPO, stages: LOCAL_STAGES })); // no source: exitEvent reads only the workspaces
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000586';
const RUN = 'run-586';
const ITEM: Item = { itemId: 'board:item1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };

// One task's stage run, in a state that holds its task, its activity (the spawn set its sessionId) and its record; `fields` override the
// worker, `work` the activity
function withRun(fields: Partial<Worker> = {}, work: Partial<Activity> = { sessionId: SESSION }): State {
  const worker: Worker = { id: 'w1', runId: RUN, activityId: 'a-board:item1', status: 'working', startedAt: '2026-11-03T12:00:00.000Z', sessionId: SESSION, agent: 'claude', ...fields };
  return withWork({ ...initialState(1), tasks: [{ item: ITEM, stage: 'spec', boardColumn: 'Backlog', auto: true, workspace: WORKSPACE }], workers: [worker] }, ITEM.itemId, work);
}

const live = (state: State) => ({ state, runtime: { config } });
// A Claude config dir of the test's own: the check never reads the real ~/.claude
const claudeEnv = async (t: AfterHost): Promise<NodeJS.ProcessEnv> => ({ CLAUDE_CONFIG_DIR: await tempDir(t, 'claude-') });

test('exitEvent flags a task run whose session has no transcript in its worktree\'s transcript dir, and not one that has it (#586)', async (t) => {
  const env = await claudeEnv(t);
  const state = withRun();
  const flagged = { type: 'exit', ptyId: RUN, noTranscript: true };
  assert.deepEqual(await exitEvent(live(state), RUN, env), flagged);
  assert.deepEqual(await exitEvent(live(withRun({ sessionId: undefined })), RUN, env), flagged, 'stopped before its SessionStart: the activity\'s id, which the spawn set');
  const dir = transcriptDir(taskDir(REPO, activityOf(state, ITEM.itemId)!), env);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SESSION}.jsonl`), '{}\n');
  assert.deepEqual(await exitEvent(live(state), RUN, env), { type: 'exit', ptyId: RUN });
});

test('exitEvent never flags a run it has nothing to check on: a terminal, a captured agent, a local run, a run with no session id, a Hive not live (#586)', async (t) => {
  const env = await claudeEnv(t);
  const plain = { type: 'exit', ptyId: RUN };
  assert.deepEqual(await exitEvent(live(withRun()), 'terminal-1', env), { type: 'exit', ptyId: 'terminal-1' }, 'no worker runs it');
  assert.deepEqual(await exitEvent(live(withRun({ terminalId: 'terminal-1' })), RUN, env), plain, 'its cwd is wherever the user typed it');
  assert.deepEqual(await exitEvent(live(withLocal(withRun({ activityId: localActivityId(WORKSPACE) }), WORKSPACE)), RUN, env), plain, 'forgetUnopenedLocal\'s (#587)');
  assert.deepEqual(await exitEvent(live(withRun({ sessionId: undefined }, {})), RUN, env), plain, 'Codex before its first SessionStart');
  assert.deepEqual(await exitEvent(live(withRun({ sessionId: 'not-a-uuid' }, { sessionId: 'not-a-uuid' })), RUN, env), plain, 'no session id of the Hive\'s: nothing to look up');
  assert.deepEqual(await exitEvent(undefined, RUN, env), plain);
});

test('exitEvent finds a transcript written under the resolved cwd of a workspace reached through a symbolic link (#586)', async (t) => {
  const env = await claudeEnv(t);
  const real = await realpath(await tempDir(t, 'repo-'));
  const link = join(await tempDir(t, 'link-'), 'repo');
  await symlink(real, link);
  const linked = { state: withRun(), runtime: { config: parseConfig(combConfig({ path: link, stages: LOCAL_STAGES })) } };
  const cwd = taskDir(link, activityOf(linked.state, ITEM.itemId)!);
  await mkdir(cwd, { recursive: true });
  const dir = transcriptDir(await realpath(cwd), env); // where an agent that resolves its cwd writes it
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SESSION}.jsonl`), '{}\n');
  assert.deepEqual(await exitEvent(linked, RUN, env), { type: 'exit', ptyId: RUN });
});

test('exitEvent never flags a run whose transcript dir it cannot look into: a check that cannot run never forgets a session (#586)', { skip: process.getuid?.() === 0 }, async (t) => {
  const root = await tempDir(t, 'claude-');
  const projects = join(root, 'projects');
  await mkdir(projects);
  await chmod(projects, 0o000); // stat answers EACCES, never ENOENT
  t.after(() => chmod(projects, 0o700)); // registered after tempDir's removal, so it runs first
  assert.deepEqual(await exitEvent(live(withRun()), RUN, { CLAUDE_CONFIG_DIR: root }), { type: 'exit', ptyId: RUN });
});
