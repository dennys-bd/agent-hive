import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(await exitEvent(undefined, RUN, env), plain);
});
