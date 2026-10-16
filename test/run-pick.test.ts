import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginSource } from '../src/hooks-settings.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { parseRunPick } from '../src/run-pick.js';
import type { Refusal } from '../src/server-tasks.js';
import type { AgentAvailability, AgentId, Item, Session, Stage, State, Task } from '../src/types.js';
import { withWork } from './fixtures/work.js';

// POST /tasks/:id/start's run picks (#290), checked against the task, its stage and this machine.
const ID = 'board:1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const CLAUDE_SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
const CODEX_SESSION = 'bbbbbbbb-2222-4222-8222-222222222222';
const AT = '2026-10-13T10:00:00.000Z';
const STAGES: Stage[] = [
  { name: 'Spec', from: { board: ['Backlog'] }, prompt: '/spec {url}' },
  { name: 'Build', from: { board: ['Ready'] }, prompt: '/build {url}' },
  { name: 'Clean', from: { board: ['Done'] }, action: 'deleteActivity' },
];
const BOTH: AgentAvailability[] = [{ agent: 'claude', available: true }, { agent: 'codex', available: true }];
const session = (id: string, agent: AgentId, stages = ['Spec']): Session => ({ id, startedAt: AT, stages, agent, lastUsedAt: AT });

// Task 1 in `column`'s stage, nothing running, its worktree on disk and `sessions` on its record
function stateWith(column: string, sessions: Session[] = []): State {
  const polled = reduce({ ...initialState(0), workspaces: ['hive'], syncs: { board: {} }, stages: STAGES, transitions: [] }, { type: 'poll', source: 'board', items: [{ item, column }] }).state;
  return withWork(polled, ID, { worktree: '/wt/hive-1-task-1' }, { sessions });
}
const taskIn = (state: State): Task => state.tasks.find((t) => t.item.itemId === ID)!;
const parse = (body: unknown, state: State, agents: AgentAvailability[] = BOTH) => parseRunPick(body, state, taskIn(state), agents, 'en', pluginSource());
const refused = (answer: ReturnType<typeof parse>): Refusal | undefined => ('status' in answer ? answer : undefined);

test('a body with no pick is no pick: today\'s start (#290)', () => {
  assert.deepEqual(parse({ base: null, local: false }, stateWith('Ready')), {});
  assert.deepEqual(parse(undefined, stateWith('Ready')), {});
});

test('a pick names the agent, the session and #257\'s launch; previous resumes the last stage run\'s session (#290)', () => {
  const state = stateWith('Ready', [session(CLAUDE_SESSION, 'claude')]);
  assert.deepEqual(parse({ agent: 'claude', session: 'previous', model: 'sonnet', args: ['--verbose'] }, state), { runPick: { agent: 'claude', resume: CLAUDE_SESSION, launch: { model: 'sonnet', args: ['--verbose'] } } });
  assert.deepEqual(parse({ session: 'new' }, state), { runPick: { resume: null } });
  assert.deepEqual(parse({ session: CLAUDE_SESSION }, state), { runPick: { resume: CLAUDE_SESSION } });
});

test('an agent the Hive does not know or this machine lacks is a 400 naming "agent" (#290)', () => {
  const state = stateWith('Ready');
  for (const agent of ['gemini', 7]) assert.match(refused(parse({ agent }, state))?.message ?? '', /"agent"/, String(agent));
  const lacking = parse({ agent: 'codex' }, state, [{ agent: 'claude', available: true }, { agent: 'codex', available: false }]);
  assert.equal(refused(lacking)?.status, 400);
});

test('a session the agent did not record, an unknown one, or previous with none is a 400 naming "session" (#925, #290)', () => {
  const state = stateWith('Ready', [session(CLAUDE_SESSION, 'claude'), session(CODEX_SESSION, 'codex')]);
  assert.match(refused(parse({ agent: 'codex', session: CLAUDE_SESSION }, state))?.message ?? '', /"session"/);
  assert.match(refused(parse({ session: CODEX_SESSION }, state))?.message ?? '', /"session"/, 'the stage\'s agent is claude');
  assert.match(refused(parse({ session: 'cccccccc-3333-4333-8333-333333333333' }, state))?.message ?? '', /"session"/);
  assert.match(refused(parse({ session: 'previous' }, stateWith('Ready')))?.message ?? '', /"session"/);
});

test('a Claude model on codex is refused as #257 refuses it (#290)', () => {
  assert.match(refused(parse({ agent: 'codex', model: 'opus' }, stateWith('Ready')))?.message ?? '', /"model"/);
});

test('picks on a continue or next to a handover are a 409; on a stage that runs no agent a 400 (#290, #134)', () => {
  const ran = stateWith('Ready', [session(CLAUDE_SESSION, 'claude', ['Build'])]); // Build already ran: Continue
  assert.equal(refused(parse({ session: 'new' }, ran))?.status, 409);
  const handed = withWork(stateWith('Ready'), ID, { handover: { prompt: 'from the transition' } });
  assert.equal(refused(parse({ session: 'new' }, handed))?.status, 409);
  assert.equal(refused(parse({ agent: 'claude' }, stateWith('Done')))?.status, 400);
});
