import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/activities.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { Effect, Item, RunPick, Stage, State, Transition } from '../src/types.js';
import { withWork } from './fixtures/work.js';

// A manual start's run picks (#290), end to end through reduce: the run they start, and what the runs after it do.

const ID = 'board:1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const STAGES: Stage[] = [
  { name: 'Build', from: { board: ['Ready'] }, prompt: '/build {url}', model: 'opus' },
  { name: 'Review', from: { board: ['Review'] }, prompt: '/review {url}' },
];
const TO_REVIEW: Transition = { from: 'Build', to: 'Review', when: 'done' };
const SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
const AT = '2026-10-13T10:00:00.000Z';
const PICK: RunPick = { agent: 'codex', resume: null, launch: { model: 'gpt-5.6-terra', args: ['--verbose'] } };

// Task 1 polled into Build under red: it waits for a start by hand, which takes the one free worker
function queued(stages: Stage[] = STAGES): State {
  const red = reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, stages, transitions: [TO_REVIEW] }, { type: 'setSignal', signal: 'red' }).state;
  return reduce(red, { type: 'poll', source: 'board', items: [{ item, column: 'Ready' }] }).state;
}
const start = (state: State, runPick?: RunPick) => reduce(state, { type: 'start', itemId: ID, ...(runPick === undefined ? {} : { runPick }) });
const spawnOf = (effects: Effect[]): Extract<Effect, { type: 'spawn' }> | undefined =>
  effects.find((e): e is Extract<Effect, { type: 'spawn' }> => e.type === 'spawn');
// Green, then hive_done and its Stop: the picked run's stage ends
function stageEnd(state: State) {
  const green = reduce(state, { type: 'setSignal', signal: 'green' }).state;
  const ptyId = green.workers.find((w) => w.status !== 'empty')?.runId ?? '';
  return reduce(reduce(green, { type: 'done', ptyId }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
}

test('a start with picks runs the picked agent with its launch in a new session; the activity keeps no pick and the input is not mutated (#290)', () => {
  const before = queued();
  const frozen = structuredClone(before);
  const { state, effects } = start(before, PICK);
  const spawn = spawnOf(effects);
  assert.deepEqual([spawn?.worker.agent, spawn?.worker.launch, spawn?.session, spawn?.run], ['codex', PICK.launch, 'new', 'stage']);
  assert.equal('runPick' in (activityOf(state, ID) ?? {}), false);
  assert.equal('runPick' in (spawn?.activity ?? {}), false);
  assert.deepEqual(before, frozen);
});

test('a pick that resumes a session continues it with the stage prompt; with no launch the worker has none, so the stage\'s model stays (#290)', () => {
  const withSession = withWork(queued(), ID, {}, { sessions: [{ id: SESSION, startedAt: AT, stages: ['Build'], agent: 'claude', lastUsedAt: AT }] });
  const { state, effects } = start(withSession, { resume: SESSION });
  const spawn = spawnOf(effects);
  assert.deepEqual([spawn?.session, spawn?.run, spawn?.worker.agent, 'launch' in (spawn?.worker ?? {})], ['continue', 'stage', 'claude', false]);
  assert.equal(activityOf(state, ID)?.sessionId, SESSION);
});

test('a start with no picks runs as the stage says: its agent and no launch (#290)', () => {
  const spawn = spawnOf(start(queued()).effects);
  assert.equal(spawn?.worker.agent, 'claude');
  assert.equal('launch' in (spawn?.worker ?? {}), false);
});

test('a next stage that starts a new session spawns with the flow\'s agent and no launch: the pick is never stored for a later spawn (#290)', () => {
  const ended = stageEnd(start(queued(), { agent: 'codex', launch: { model: 'gpt-5.6-terra' } }).state);
  const spawn = spawnOf(ended.effects);
  assert.equal(spawn?.stage.name, 'Review');
  assert.deepEqual([spawn?.worker.agent, 'launch' in (spawn?.worker ?? {})], ['claude', false]);
});

test('a next stage that continues the session goes on in place, as every run does: the same process, its picks with it (#290)', () => {
  const ended = stageEnd(start(queued([STAGES[0], { ...STAGES[1], session: 'continue' }]), { launch: { model: 'sonnet' } }).state);
  assert.ok(ended.effects.some((e) => e.type === 'continue'));
  assert.equal(spawnOf(ended.effects), undefined);
  assert.deepEqual(ended.state.workers.find((w) => w.status !== 'empty')?.launch, { model: 'sonnet' });
});

test('a start never writes picks next to a handover: the handover decides the session and the prompt (#290, #134)', () => {
  const handed = withWork(queued(), ID, { handover: { prompt: 'from the transition' } });
  const { state, effects } = start(handed, PICK);
  const spawn = spawnOf(effects);
  assert.deepEqual([spawn?.prompt, spawn?.worker.agent, 'launch' in (spawn?.worker ?? {})], ['from the transition', 'claude', false]);
  assert.equal('runPick' in (activityOf(state, ID) ?? {}), false);
});
