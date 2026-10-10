import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/orchestrator.js';
import { createEvent, createTask, HIVE_OFF_MESSAGE, notInFlowNotice, noColumnMessage, noCreateMessage, UNKNOWN_SOURCE_MESSAGE, WORKSPACE_ON_SOURCE_MESSAGE, type CreateDeps } from '../src/create-task.js';
import { GITHUB_ENTRY } from './fakes.js';
import type { Source, State, Task } from '../src/types.js';

const STATE: State = { ...initialState(0), stages: [{ name: 'fila', from: {}, prompt: 'x' }], workspaces: ['hive'] };
const SOURCES = ['roadmap'];
const BASE = { title: 'Fix login', body: 'steps', stage: 'fila', auto: false };
const URL = 'https://github.com/acme/r/issues/12';
const URL_MESSAGE = { status: 400, message: 'url precisa ser um link https de até 2 KB' };
const ORIGIN_MESSAGE = { status: 400, message: 'origin precisa ser o item de uma source configurada' };

test('createEvent carries an https url and the origin of a configured source onto the createTask; without them it is the plain create (#756)', () => {
  assert.deepEqual(
    createEvent(STATE, 'HIVE', { ...BASE, url: URL, origin: 'roadmap:PVTI_12' }, SOURCES),
    { type: 'createTask', title: 'Fix login', body: 'steps', stage: 'fila', prefix: 'HIVE', auto: false, url: URL, origin: 'roadmap:PVTI_12' },
  );
  assert.deepEqual(createEvent(STATE, 'HIVE', BASE, SOURCES), { type: 'createTask', title: 'Fix login', body: 'steps', stage: 'fila', prefix: 'HIVE', auto: false });
});

test('createEvent refuses a url that is not https or passes 2 KB, and an origin of no configured source: 400, naming it (#756)', () => {
  for (const url of ['http://github.com/acme/r/issues/12', 'javascript:alert(1)', 7, `https://x.dev/${'a'.repeat(2048)}`]) {
    assert.deepEqual(createEvent(STATE, 'HIVE', { ...BASE, url }, SOURCES), URL_MESSAGE, String(url).slice(0, 40));
  }
  for (const origin of ['notes:PVTI_12', 'local:3', 'PVTI_12', 12]) {
    assert.deepEqual(createEvent(STATE, 'HIVE', { ...BASE, origin }, SOURCES), ORIGIN_MESSAGE, String(origin));
  }
  assert.deepEqual(createEvent(STATE, 'HIVE', { ...BASE, origin: 'roadmap:PVTI_12' }), ORIGIN_MESSAGE, 'no sources handed (hive_create_task): no origin');
});

test('createEvent answers 409 when a task already has that origin (#756)', () => {
  const made: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'x', body: '', url: URL, origin: 'roadmap:PVTI_12' }, stage: 'fila', boardColumn: '', auto: false, created: true };
  assert.deepEqual(createEvent({ ...STATE, tasks: [made] }, 'HIVE', { ...BASE, origin: 'roadmap:PVTI_12' }, SOURCES), { status: 409, message: 'já existe uma tarefa criada desse item' });
});

const ROADMAP = { ...GITHUB_ENTRY, name: 'roadmap', repository: 'acme/app' };
const COMB = { prefix: 'HIVE', hiveSource: true, createIn: 'hive', sources: [ROADMAP, { ...GITHUB_ENTRY, name: 'notes' }] };
const ON_SOURCE: State = { ...STATE, stages: [{ name: 'fila', from: { roadmap: ['Todo'] }, prompt: 'x' }, { name: 'later', from: {} }] };
const MADE: Task = { item: { itemId: 'roadmap:PVTI_9', id: '9', title: 'Fix login', body: '', url: '', source: 'roadmap' }, stage: 'fila', boardColumn: 'Todo', auto: true };

function fakeDeps(comb = COMB, { listed = true, fail, pollFails }: { listed?: boolean; fail?: string; pollFails?: string } = {}) {
  const made: unknown[] = []; const polled: string[][] = []; const events: string[] = [];
  let state = ON_SOURCE;
  const deps: CreateDeps = {
    state: ON_SOURCE, config: { comb },
    sources: new Map<string, Pick<Source, 'create'>>([['roadmap', { create: async (f) => { if (fail) throw new Error(fail); made.push(f); return 'roadmap:PVTI_9'; } }], ['notes', {}]]),
    dispatch: async (e) => { events.push(e.type); return []; },
    poll: async (names) => { polled.push(names); if (pollFails) throw new Error(pollFails); if (listed) state = { ...state, tasks: [MADE] }; },
    latest: () => state,
  };
  return { deps, made, polled, events };
}

test('createTask: no source goes to comb.createIn; hive dispatches createTask, a source creates in the stage\'s first column, polls it and answers its task (#846)', async () => {
  const hive = fakeDeps();
  assert.deepEqual(await createTask(hive.deps, { title: 'Fix login', stage: 'fila' }), { id: 'HIVE-1', itemId: 'local:1' });
  assert.deepEqual([hive.events, hive.made], [['createTask'], []]);
  const named = fakeDeps();
  assert.deepEqual(await createTask(named.deps, { title: 'Fix login', body: 'steps', stage: 'fila', source: 'roadmap' }), { id: '9', itemId: 'roadmap:PVTI_9' });
  assert.deepEqual([named.made, named.polled, named.events], [[{ title: 'Fix login', body: 'steps', column: 'Todo' }], [['roadmap']], []]);
  const byDefault = fakeDeps({ ...COMB, createIn: 'roadmap' });
  assert.deepEqual(await createTask(byDefault.deps, { title: 'Fix login', stage: 'fila' }), { id: '9', itemId: 'roadmap:PVTI_9' });
  assert.deepEqual(await createTask(fakeDeps({ ...COMB, createIn: 'roadmap' }).deps, { title: 'x', stage: 'fila', source: 'hive' }), { id: 'HIVE-1', itemId: 'local:1' }, 'hive by name while on');
});

test('createTask refuses hive when off, an unknown source, one without a repository, a workspace on a source and a stage with no column there (#846)', async () => {
  const off = { ...COMB, hiveSource: false, createIn: 'roadmap' };
  assert.deepEqual(await createTask(fakeDeps(off).deps, { title: 'x', stage: 'fila', source: 'hive' }), { status: 409, message: HIVE_OFF_MESSAGE });
  for (const source of ['nope', 7, '']) assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'fila', source }), { status: 400, message: UNKNOWN_SOURCE_MESSAGE }, String(source));
  assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'fila', source: 'notes' }), { status: 400, message: noCreateMessage('notes') });
  assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'fila', source: 'roadmap', workspace: 'hive' }), { status: 400, message: WORKSPACE_ON_SOURCE_MESSAGE });
  assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'later', source: 'roadmap' }), { status: 400, message: noColumnMessage('later', 'roadmap') });
  assert.deepEqual(await createTask(fakeDeps().deps, { title: ' ', stage: 'fila', source: 'roadmap' }), { status: 400, message: 'título obrigatório' });
});

test('createTask answers a notice when the poll leaves the new item out, and 502 with the source\'s words when the create fails (#846)', async () => {
  assert.deepEqual(await createTask(fakeDeps(COMB, { listed: false }).deps, { title: 'x', stage: 'fila', source: 'roadmap' }), { itemId: 'roadmap:PVTI_9', notice: notInFlowNotice('roadmap', 'roadmap:PVTI_9') });
  assert.deepEqual(await createTask(fakeDeps(COMB, { fail: 'no access' }).deps, { title: 'x', stage: 'fila', source: 'roadmap' }), { status: 502, message: 'no access' });
});

test('createTask answers the notice, not an error, when the poll throws after the item exists: the issue is not lost to a retry (#846)', async () => {
  const failing = fakeDeps(COMB, { pollFails: 'rate limited' });
  assert.deepEqual(await createTask(failing.deps, { title: 'x', stage: 'fila', source: 'roadmap' }), { itemId: 'roadmap:PVTI_9', notice: notInFlowNotice('roadmap', 'roadmap:PVTI_9') });
  assert.equal(failing.made.length, 1);
});

test('the not-in-flow notice names the item and does not blame the filter alone, since a failed poll lands there too (#846)', () => {
  const notice = notInFlowNotice('roadmap', 'roadmap:PVTI_9');
  assert.match(notice, /roadmap:PVTI_9/);
  assert.match(notice, /not in the flow yet/);
  assert.match(notice, /filter may leave it out, or the next poll will bring it in/);
});
