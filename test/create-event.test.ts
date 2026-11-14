import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, isUuid, reduce } from '../src/orchestrator.js';
import { createEvent, createTask, HIVE_ISSUE_FIELDS_MESSAGE, LABELS_MESSAGE, STATUS_MESSAGE, STATUS_OR_STAGE_MESSAGE, HIVE_OFF_MESSAGE, NO_STAGE_ON_SOURCE_MESSAGE, notInFlowNotice, offProjectNotice, noColumnMessage, noCreateMessage, PR_HIVE_ONLY_MESSAGE, PR_TAKEN_MESSAGE, PR_URL_MESSAGE, UNKNOWN_SOURCE_MESSAGE, UNKNOWN_STAGE_MESSAGE, WORKSPACE_ON_SOURCE_MESSAGE, type CreateDeps } from '../src/create-task.js';
import { CreateRefusedError, IssuePlacementError } from '../src/source-create.js';
import { taskOfPr } from '../src/activities.js';
import { GITHUB_ENTRY } from './fakes.js';
import type { HiveEvent, Source, SourceConfig, State, Task } from '../src/types.js';
import { flowed } from './fixtures/main-flow.js';

const STATE: State = { ...initialState(0), ...flowed([{ name: 'fila', from: {}, prompt: 'x' }]), workspaces: ['hive'] };
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
const ON_SOURCE: State = { ...STATE, ...flowed([{ name: 'fila', from: { roadmap: ['Todo'] }, prompt: 'x' }, { name: 'later', from: {} }]) };
const REF = { id: '9', url: 'https://github.com/acme/app/issues/9' };
const MADE: Task = { item: { itemId: 'roadmap:PVTI_9', id: '9', title: 'Fix login', body: '', url: '', source: 'roadmap' }, stage: 'fila', boardColumn: 'Todo', auto: true };

function fakeDeps(comb = COMB, { listed = true, fail, pollFails, offProject = false }: { listed?: boolean; fail?: Error; pollFails?: string; offProject?: boolean } = {}) {
  const made: unknown[] = []; const polled: string[][] = []; const events: string[] = [];
  let state = ON_SOURCE;
  const deps: CreateDeps = {
    state: ON_SOURCE, config: { comb },
    sources: new Map<string, Pick<Source, 'create'>>([['roadmap', { create: async (f) => { if (fail) throw fail; made.push(f); return offProject ? { ref: REF } : { itemId: 'roadmap:PVTI_9', ref: REF }; } }], ['notes', {}]]),
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
  assert.deepEqual(await createTask(named.deps, { title: 'Fix login', body: 'steps', stage: 'fila', source: 'roadmap' }), { id: '9', itemId: 'roadmap:PVTI_9', ref: REF, stage: 'fila' });
  assert.deepEqual([named.made, named.polled, named.events], [[{ title: 'Fix login', body: 'steps', column: 'Todo', labels: [] }], [['roadmap']], []]);
  const byDefault = fakeDeps({ ...COMB, createIn: 'roadmap' });
  assert.deepEqual(await createTask(byDefault.deps, { title: 'Fix login', stage: 'fila' }), { id: '9', itemId: 'roadmap:PVTI_9', ref: REF, stage: 'fila' });
  assert.deepEqual(await createTask(fakeDeps({ ...COMB, createIn: 'roadmap' }).deps, { title: 'x', stage: 'fila', source: 'hive' }), { id: 'HIVE-1', itemId: 'local:1' }, 'hive by name while on');
});

test('createTask refuses hive when off, an unknown source, one without a repository, a workspace on a source and a stage with no column there (#846)', async () => {
  const off = { ...COMB, hiveSource: false, createIn: 'roadmap' };
  assert.deepEqual(await createTask(fakeDeps(off).deps, { title: 'x', stage: 'fila', source: 'hive' }), { status: 409, message: HIVE_OFF_MESSAGE });
  for (const source of ['nope', 7, '']) assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'fila', source }), { status: 400, message: UNKNOWN_SOURCE_MESSAGE }, String(source));
  assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'fila', source: 'notes' }), { status: 400, message: noCreateMessage({ name: 'notes', type: 'github' }) });
  assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'fila', source: 'roadmap', workspace: 'hive' }), { status: 400, message: WORKSPACE_ON_SOURCE_MESSAGE });
  assert.deepEqual(await createTask(fakeDeps().deps, { title: 'x', stage: 'later', source: 'roadmap' }), { status: 400, message: noColumnMessage('later', 'roadmap') });
  assert.deepEqual(await createTask(fakeDeps().deps, { title: ' ', stage: 'fila', source: 'roadmap' }), { status: 400, message: 'título obrigatório' });
});

// #811: a type SourceFields does not have yet, with no repository: only an injected predicate lets it create
const TRACKER = { ...GITHUB_ENTRY, name: 'tracker', type: 'tracker' } as unknown as SourceConfig;
const TRACKER_REF = { id: 'T-1', url: 'https://tracker.example/T-1' };

function trackerDeps(can?: CreateDeps['canCreate']) {
  const made: unknown[] = [];
  const deps: CreateDeps = {
    state: STATE, config: { comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', sources: [TRACKER] } },
    sources: new Map<string, Pick<Source, 'create'>>([['tracker', { create: async (f) => { made.push(f); return { itemId: 'tracker:T-1', ref: TRACKER_REF }; } }]]),
    dispatch: async () => [], poll: async () => {}, latest: () => STATE, ...(can === undefined ? {} : { canCreate: can }),
  };
  return { deps, made };
}

test('createTask creates in a source of another type with no repository when the predicate accepts it, and answers its ref (#811)', async () => {
  const run = trackerDeps(() => true);
  assert.deepEqual(await createTask(run.deps, { title: 'Fix', source: 'tracker', status: 'Todo' }), { itemId: 'tracker:T-1', ref: TRACKER_REF, notice: notInFlowNotice('tracker', 'tracker:T-1') });
  assert.deepEqual(run.made, [{ title: 'Fix', body: '', column: 'Todo', labels: [] }]);
});

test('a source the predicate refuses answers 400: neutral for another type, the repository hint kept for GitHub (#811)', async () => {
  const run = trackerDeps(() => false);
  assert.deepEqual(await createTask(run.deps, { title: 'x', source: 'tracker', status: 'Todo' }), { status: 400, message: 'source tracker cannot create tasks' });
  assert.deepEqual(run.made, []);
  assert.equal(noCreateMessage({ name: 'notes', type: 'github' }), 'source notes cannot create tasks: it has no repository for new issues');
});

test('createTask answers a notice when the poll leaves the new item out, and 502 with the source\'s words when the create fails (#846)', async () => {
  assert.deepEqual(await createTask(fakeDeps(COMB, { listed: false }).deps, { title: 'x', stage: 'fila', source: 'roadmap' }), { itemId: 'roadmap:PVTI_9', ref: REF, notice: notInFlowNotice('roadmap', 'roadmap:PVTI_9') });
  assert.deepEqual(await createTask(fakeDeps(COMB, { fail: new Error('no access') }).deps, { title: 'x', stage: 'fila', source: 'roadmap' }), { status: 502, message: 'no access' });
});

test('createTask answers the notice, not an error, when the poll throws after the item exists: the issue is not lost to a retry (#846)', async () => {
  const failing = fakeDeps(COMB, { pollFails: 'rate limited' });
  assert.deepEqual(await createTask(failing.deps, { title: 'x', stage: 'fila', source: 'roadmap' }), { itemId: 'roadmap:PVTI_9', ref: REF, notice: notInFlowNotice('roadmap', 'roadmap:PVTI_9') });
  assert.equal(failing.made.length, 1);
});

test('createTask: an issue created off the Project answers the issue and a notice naming its url, with no poll, no id and no itemId (#767)', async () => {
  const off = fakeDeps(COMB, { offProject: true });
  assert.deepEqual(await createTask(off.deps, { title: 'x', stage: 'fila', source: 'roadmap' }), { ref: REF, notice: offProjectNotice(REF.url) });
  assert.deepEqual(off.polled, []);
  assert.equal(offProjectNotice(REF.url), 'created https://github.com/acme/app/issues/9 off the Project: no source lists it');
});

test('the not-in-flow notice names the item and does not blame the filter alone, since a failed poll lands there too (#846)', () => {
  const notice = notInFlowNotice('roadmap', 'roadmap:PVTI_9');
  assert.match(notice, /roadmap:PVTI_9/);
  assert.match(notice, /not in the flow yet/);
  assert.match(notice, /filter may leave it out, or the next poll will bring it in/);
});

const PR = 'https://github.com/acme/app/pull/7';

// The hive path with the real reducer behind dispatch (#67): what taskOfPr reads after the create; the roadmap source is a spy that must stay untouched
function reducingDeps(comb = COMB, state: State = STATE) {
  const made: unknown[] = []; const events: HiveEvent[] = [];
  let current = state;
  const deps: CreateDeps = {
    state, config: { comb },
    sources: new Map<string, Pick<Source, 'create'>>([['roadmap', { create: async (f) => { made.push(f); return { itemId: 'roadmap:PVTI_9', ref: REF }; } }]]),
    dispatch: async (e) => { events.push(e); current = reduce(current, e).state; return []; },
    poll: async () => undefined,
    latest: () => current,
  };
  return { deps, made, events, latest: () => current };
}

test('createTask with pr creates a hive task whose record holds the PR, its url the PR link; taskOfPr then resolves it; no source is written, even with createIn on a source (#67)', async () => {
  const run = reducingDeps({ ...COMB, createIn: 'roadmap' });
  assert.deepEqual(await createTask(run.deps, { title: 'The PR', stage: 'fila', auto: false, pr: PR }), { id: 'HIVE-1', itemId: 'local:1' });
  const [event] = run.events;
  assert.ok(event.type === 'createTask' && event.pr !== undefined && isUuid(event.pr.recordId), 'the route draws the record id');
  assert.equal(event.pr.url, PR);
  const state = run.latest();
  assert.equal(taskOfPr(state, PR)?.item.itemId, 'local:1');
  assert.equal(state.tasks.find((c) => c.item.itemId === 'local:1')?.item.url, PR, 'url defaults to the PR link');
  assert.deepEqual(state.activities, [], 'no activity');
  assert.deepEqual(run.made, [], 'no Source.create');
  assert.deepEqual(await createTask(reducingDeps().deps, { title: 'The PR', stage: 'fila', pr: PR, source: 'hive' }), { id: 'HIVE-1', itemId: 'local:1' }, 'hive by name');
});

test('createTask with pr refuses a source, a link that is no GitHub PR and a PR a task already holds, and follows hive off; none dispatches (#67)', async () => {
  const first = reducingDeps();
  await createTask(first.deps, { title: 'The PR', stage: 'fila', pr: PR });
  const again = reducingDeps(COMB, first.latest());
  assert.deepEqual(await createTask(again.deps, { title: 'x', stage: 'fila', pr: PR }), { status: 409, message: PR_TAKEN_MESSAGE });
  const sourced = reducingDeps();
  assert.deepEqual(await createTask(sourced.deps, { title: 'x', stage: 'fila', pr: PR, source: 'roadmap' }), { status: 400, message: PR_HIVE_ONLY_MESSAGE });
  for (const pr of ['https://github.com/acme/app/issues/7', 'http://github.com/acme/app/pull/7', 'https://github.com/acme/app/pull/7/files', 'https://x.dev/pull/7', '', 7, null]) {
    assert.deepEqual(await createTask(reducingDeps().deps, { title: 'x', stage: 'fila', pr }), { status: 400, message: PR_URL_MESSAGE }, String(pr));
  }
  const off = reducingDeps({ ...COMB, hiveSource: false });
  assert.deepEqual(await createTask(off.deps, { title: 'x', stage: 'fila', pr: PR }), { status: 409, message: HIVE_OFF_MESSAGE });
  assert.deepEqual([again.events, sourced.events, off.events, sourced.made], [[], [], [], []]);
});

test('createEvent without a stage is a task outside the flow, its origin kept; a stage it names must still exist (#566)', () => {
  const { stage: _stage, ...loose } = BASE;
  assert.deepEqual(createEvent(STATE, 'HIVE', loose, SOURCES), { type: 'createTask', title: 'Fix login', body: 'steps', prefix: 'HIVE', auto: false });
  assert.deepEqual(createEvent(STATE, 'HIVE', { ...loose, origin: 'roadmap:PVTI_12' }, SOURCES), { type: 'createTask', title: 'Fix login', body: 'steps', prefix: 'HIVE', auto: false, origin: 'roadmap:PVTI_12' });
  for (const stage of ['nope', 7, null]) assert.deepEqual(createEvent(STATE, 'HIVE', { ...BASE, stage }), { status: 400, message: UNKNOWN_STAGE_MESSAGE }, String(stage));
});

test('createTask without a stage on a source answers 400 naming the rule and never calls Source.create; in hive it creates one outside the flow (#566)', async () => {
  const sourced = fakeDeps();
  assert.deepEqual(await createTask(sourced.deps, { title: 'x', source: 'roadmap' }), { status: 400, message: NO_STAGE_ON_SOURCE_MESSAGE });
  assert.deepEqual([sourced.made, sourced.polled], [[], []]);
  assert.equal(NO_STAGE_ON_SOURCE_MESSAGE, 'a task outside the flow is created only in hive');
  const hive = reducingDeps();
  assert.deepEqual(await createTask(hive.deps, { title: 'Loose' }), { id: 'HIVE-1', itemId: 'local:1' });
  assert.equal(hive.latest().tasks.find((c) => c.item.itemId === 'local:1')?.stage, undefined);
});

test('createTask with labels and a status creates the issue in that Status option with those labels, and answers the task, its issue and its stage (#767)', async () => {
  const run = fakeDeps();
  assert.deepEqual(await createTask(run.deps, { title: 'Fix login', source: 'roadmap', labels: ['bug', 'docs'], status: 'Todo' }), { id: '9', itemId: 'roadmap:PVTI_9', ref: REF, stage: 'fila' });
  assert.deepEqual([run.made, run.polled], [[{ title: 'Fix login', body: '', column: 'Todo', labels: ['bug', 'docs'] }], [['roadmap']]]);
});

test('createTask with labels and a stage creates the issue in the stage\'s first column with those labels (#767)', async () => {
  const run = fakeDeps();
  await createTask(run.deps, { title: 'x', stage: 'fila', source: 'roadmap', labels: ['bug'] });
  assert.deepEqual(run.made, [{ title: 'x', body: '', column: 'Todo', labels: ['bug'] }]);
});

test('createTask with status null creates the issue off the Project: no poll, the issue and the url notice, no id or itemId (#767)', async () => {
  const run = fakeDeps(COMB, { offProject: true });
  assert.deepEqual(await createTask(run.deps, { title: 'x', source: 'roadmap', status: null }), { ref: REF, notice: offProjectNotice(REF.url) });
  assert.deepEqual([run.made, run.polled], [[{ title: 'x', body: '', column: null, labels: [] }], []]);
});

test('createTask refuses bad labels, labels or status in hive, status with stage and a status that is no name, and never calls Source.create (#767)', async () => {
  const run = fakeDeps();
  const ask = (body: Record<string, unknown>) => createTask(run.deps, { title: 'x', ...body });
  const many = Array.from({ length: 21 }, (_, i) => `l${i}`);
  for (const labels of ['bug', [''], [7], ['a'.repeat(51)], ['bug', 'bug'], many]) {
    assert.deepEqual(await ask({ source: 'roadmap', status: 'Todo', labels }), { status: 400, message: LABELS_MESSAGE }, JSON.stringify(labels).slice(0, 40));
  }
  for (const body of [{ source: 'hive', labels: ['bug'] }, { source: 'hive', status: null }, { stage: 'fila', status: 'Todo' }, { pr: PR, labels: [] }]) {
    assert.deepEqual(await ask(body), { status: 400, message: HIVE_ISSUE_FIELDS_MESSAGE }, JSON.stringify(body));
  }
  assert.deepEqual(await ask({ source: 'roadmap', stage: 'fila', status: 'Todo' }), { status: 400, message: STATUS_OR_STAGE_MESSAGE });
  assert.deepEqual(await ask({ source: 'roadmap', status: 7 }), { status: 400, message: STATUS_MESSAGE });
  assert.deepEqual([run.made, run.events], [[], []]);
  const edge = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(50, 'x'));
  await ask({ source: 'roadmap', status: 'Todo', labels: edge });
  assert.equal(run.made.length, 1, '20 distinct names of 50 characters pass');
});

test('createTask answers a create refusal 400, a placement failure 502 with the issue, and any other failure 502 with no issue (#767)', async () => {
  const body = { title: 'x', source: 'roadmap', status: 'Todo' };
  const refused = new CreateRefusedError('"nope" not a label of acme/app: bug, docs');
  assert.deepEqual(await createTask(fakeDeps(COMB, { fail: refused }).deps, body), { status: 400, message: refused.message });
  const placement = new IssuePlacementError(`issue ${REF.url} was created but not labeled or placed on the Project: down`, REF);
  assert.deepEqual(await createTask(fakeDeps(COMB, { fail: placement }).deps, body), { status: 502, message: placement.message, ref: REF });
  assert.deepEqual(await createTask(fakeDeps(COMB, { fail: new Error('no access') }).deps, body), { status: 502, message: 'no access' });
});
