import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../src/orchestrator.js';
import { ItemNotOnSourceError, PartialWriteError } from '../src/field-values.js';
import { registerProjectRoutes, type ProjectRouteDeps } from '../src/server-project.js';
import type { FieldValue, FieldWrite, HiveEvent, ItemField, ProjectItem, ProjectView, Source, SourceItem, Stage, State } from '../src/types.js';

// Two stages let work's Ready and In review in; Todo is cited by none
const STAGES: Stage[] = [{ name: 'dev', from: { work: ['Ready'] }, prompt: 'x' }, { name: 'review', from: { work: ['In review'] }, prompt: 'y' }];
const VIEW: ProjectView = { statuses: [{ name: 'Todo' }, { name: 'Ready' }, { name: 'In review' }], fields: [], builtins: {}, items: [], truncated: false };
const LOW = { limit: 5000, remaining: 499, resetsAt: '2999-01-01T00:00:00.000Z', at: '2026-10-06T12:00:00.000Z' };

type ViewSource = Partial<Pick<Source, 'project' | 'fieldsOf' | 'setField' | 'settingsOptions'>>;

// The project routes alone over these sources and this state, answering the base URL; every dispatched event lands in `dispatched`
function routes(t: TestContext, sources: Record<string, ViewSource>, extra: Partial<State> = {}, dispatched: HiveEvent[] = [], rejecting = false, extraDeps: Pick<ProjectRouteDeps, 'refreshOptions'> = {}): string {
  const app = express();
  app.use(express.json());
  const state: State = { ...initialState(0), stages: STAGES, ...extra };
  registerProjectRoutes(app, {
    requireLive: () => ({ state, runtime: { sources: new Map(Object.entries(sources)) } }),
    dispatch: async (event) => { dispatched.push(event); if (rejecting) throw new Error('reducer failed'); },
    ...extraDeps,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const OPTION_NAMES = ['Todo', 'Ready', 'In review', 'Done'];
const ROW: ProjectItem = { itemId: 'work:PVTI_1', id: '1', title: 'T', body: '', url: 'https://github.com/acme/r/issues/1', status: 'Ready', labels: [], assignees: [], fields: { Priority: 'P0' }, pullRequests: [] };
const ENTRY: SourceItem = { item: { itemId: 'work:PVTI_1', id: '1', title: 'T', body: '', url: ROW.url, source: 'work' }, column: 'Ready' };
const FIELDS: ItemField[] = [
  { name: 'Priority', type: 'singleSelect', value: 'P1', options: ['P0', 'P1'] },
  { name: 'Repository', type: 'repository', value: 'acme/r', readOnly: true },
];
const WRITTEN: FieldWrite = { fields: [{ ...FIELDS[0], value: 'P0' }, FIELDS[1]], row: ROW, entry: ENTRY };
// A source with FIELDS whose writes land in `writes` as `<itemId> <field>=<json value>`, answering `answer`
const editable = (writes: string[], answer: FieldWrite = WRITTEN): ViewSource => ({
  fieldsOf: async () => FIELDS,
  setField: async (itemId: string, field: string, value: FieldValue) => { writes.push(`${itemId} ${field}=${JSON.stringify(value)}`); return answer; },
});
const fieldsUrl = (base: string, name = 'work', itemId = 'work:PVTI_1'): string => `${base}/sources/${name}/items/${encodeURIComponent(itemId)}/fields`;

test('GET /sources/:name/project answers the native view with the stage each Status option enters; an option no stage cites has none (#756)', async (t) => {
  const base = routes(t, { work: { project: async () => VIEW } });
  const res = await fetch(`${base}/sources/work/project`);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as ProjectView).statuses, [{ name: 'Todo' }, { name: 'Ready', stage: 'dev' }, { name: 'In review', stage: 'review' }]);
});

test('GET /sources/:name/project is a 404 for an unknown source or one without a native view, and a 502 with the source\'s words on a failed read (#756)', async (t) => {
  const base = routes(t, { bare: {}, broken: { project: async () => { throw new Error('Bad credentials'); } } });
  for (const name of ['nope', 'bare']) {
    const res = await fetch(`${base}/sources/${name}/project`);
    assert.deepEqual([res.status, await res.json()], [404, { error: 'source has no native view' }], name);
  }
  const failed = await fetch(`${base}/sources/broken/project`);
  assert.deepEqual([failed.status, await failed.json()], [502, { error: 'Bad credentials' }]);
});

test('GET /sources/:name/project is a 429 with the reset inside the source\'s quota backoff; with no reading yet, or a reset already past, it reads (#756)', async (t) => {
  let reads = 0;
  const work = { project: async () => { reads += 1; return VIEW; } };
  const refused = await fetch(`${routes(t, { work }, { syncs: { work: { quota: LOW } } })}/sources/work/project`);
  assert.deepEqual([refused.status, await refused.json()], [429, { error: 'GitHub quota is low', resetsAt: LOW.resetsAt }]);
  assert.equal(reads, 0, 'refused before the read');
  assert.equal((await fetch(`${routes(t, { work })}/sources/work/project`)).status, 200);
  const past = routes(t, { work }, { syncs: { work: { quota: { ...LOW, resetsAt: '2020-01-01T00:00:00.000Z' } } } });
  assert.equal((await fetch(`${past}/sources/work/project`)).status, 200);
  assert.equal(reads, 2);
});

test('GET …/items/:itemId/fields answers the item\'s fields, asked with its namespaced id (#686)', async (t) => {
  const asked: string[] = [];
  const base = routes(t, { work: { ...editable([]), fieldsOf: async (itemId) => { asked.push(itemId); return FIELDS; } } });
  const res = await fetch(fieldsUrl(base));
  assert.deepEqual([res.status, await res.json(), asked], [200, { fields: FIELDS }, ['work:PVTI_1']]);
});

test('POST …/items/:itemId/fields writes the checked value through setField, dispatches itemRead with the re-read entry and answers the fields and the row (#686)', async (t) => {
  const writes: string[] = [];
  const dispatched: HiveEvent[] = [];
  const base = routes(t, { work: editable(writes) }, {}, dispatched);
  const res = await post(fieldsUrl(base), { field: 'Priority', value: 'P0' });
  assert.deepEqual([res.status, await res.json()], [200, { fields: WRITTEN.fields, row: ROW }]);
  assert.deepEqual(writes, ['work:PVTI_1 Priority="P0"']);
  assert.deepEqual(dispatched, [{ type: 'itemRead', source: 'work', itemId: 'work:PVTI_1', entry: ENTRY }]);
});

test('POST …/items/:itemId/fields: an item the re-read finds out of the listing dispatches itemRead with no entry (#686)', async (t) => {
  const dispatched: HiveEvent[] = [];
  const { entry: _entry, ...unlisted } = WRITTEN;
  const base = routes(t, { work: editable([], unlisted) }, {}, dispatched);
  assert.equal((await post(fieldsUrl(base), { field: 'Priority', value: null })).status, 200);
  assert.deepEqual(dispatched, [{ type: 'itemRead', source: 'work', itemId: 'work:PVTI_1' }]);
});

test('the fields routes refuse: 404 without fieldsOf and setField, 400 for another source\'s item, an unknown field, a bad value or a read-only field, 502 with the source\'s words; none dispatches (#686)', async (t) => {
  const dispatched: HiveEvent[] = [];
  const refusing: ViewSource = { ...editable([]), setField: async () => { throw new Error('Resource not accessible by integration'); } };
  const broken: ViewSource = { ...editable([]), fieldsOf: async () => { throw new Error('Bad credentials'); } };
  const base = routes(t, { work: editable([]), refusing, broken, bare: { project: async () => VIEW } }, {}, dispatched);
  const answer = async (url: string, body?: unknown): Promise<unknown[]> => {
    const res = body === undefined ? await fetch(url) : await post(url, body);
    return [res.status, await res.json()];
  };
  const noFields = [404, { error: 'source has no editable fields' }];
  assert.deepEqual(await answer(fieldsUrl(base, 'bare', 'bare:PVTI_1')), noFields);
  assert.deepEqual(await answer(fieldsUrl(base, 'nope', 'nope:PVTI_1'), { field: 'Priority', value: 'P0' }), noFields);
  assert.deepEqual(await answer(fieldsUrl(base, 'work', 'notes:PVTI_1')), [400, { error: 'itemId must be an item of this source' }]);
  assert.deepEqual(await answer(fieldsUrl(base), { field: 'Nope', value: 'x' }), [400, { error: "field must be one of the item's fields" }]);
  assert.deepEqual(await answer(fieldsUrl(base), { value: 'x' }), [400, { error: "field must be one of the item's fields" }]);
  assert.deepEqual(await answer(fieldsUrl(base), { field: 'Priority', value: 'P9' }), [400, { error: '"Priority" takes one of its options' }]);
  assert.deepEqual(await answer(fieldsUrl(base), { field: 'Repository', value: 'acme/x' }), [400, { error: '"Repository" is read only' }]);
  assert.deepEqual(await answer(fieldsUrl(base, 'refusing', 'refusing:PVTI_1'), { field: 'Priority', value: 'P0' }), [502, { error: 'Resource not accessible by integration' }]);
  assert.deepEqual(await answer(fieldsUrl(base, 'broken', 'broken:PVTI_1')), [502, { error: 'Bad credentials' }]);
  assert.deepEqual(dispatched, []);
});

test('the fields routes are a 429 with the reset inside the source\'s quota backoff, before any read (#686)', async (t) => {
  let reads = 0;
  const work: ViewSource = { ...editable([]), fieldsOf: async () => { reads += 1; return FIELDS; } };
  const base = routes(t, { work }, { syncs: { work: { quota: LOW } } });
  for (const res of [await fetch(fieldsUrl(base)), await post(fieldsUrl(base), { field: 'Priority', value: 'P0' })]) {
    assert.deepEqual([res.status, await res.json()], [429, { error: 'GitHub quota is low', resetsAt: LOW.resetsAt }]);
  }
  assert.equal(reads, 0);
});

test('POST /sources/:name/project/status writes any Status option through setField, uncited Done included, dispatches itemRead and answers the fields and the row; no poll (#756, #686)', async (t) => {
  const writes: string[] = [];
  const dispatched: HiveEvent[] = [];
  const base = routes(t, { work: { settingsOptions: async () => OPTION_NAMES, ...editable(writes) } }, {}, dispatched);
  const res = await post(`${base}/sources/work/project/status`, { itemId: 'work:PVTI_1', status: 'Done' });
  assert.deepEqual([res.status, await res.json()], [200, { fields: WRITTEN.fields, row: ROW }]);
  assert.deepEqual(writes, ['work:PVTI_1 Status="Done"']);
  assert.deepEqual(dispatched, [{ type: 'itemRead', source: 'work', itemId: 'work:PVTI_1', entry: ENTRY }]);
});

test('POST /sources/:name/project/status: 400 for an option the Status lacks or an item of another source, 404 without setField, 502 on the source\'s refusal; none of them dispatches (#756, #686)', async (t) => {
  const dispatched: HiveEvent[] = [];
  const work: ViewSource = { settingsOptions: async () => OPTION_NAMES, setField: async () => { throw new Error('Resource not accessible by integration'); } };
  const base = routes(t, { work, bare: { project: async () => VIEW } }, {}, dispatched);
  const answer = async (name: string, body: unknown): Promise<unknown[]> => {
    const res = await post(`${base}/sources/${name}/project/status`, body);
    return [res.status, await res.json()];
  };
  const badStatus = [400, { error: "status must be one of the source's Status options" }];
  assert.deepEqual(await answer('work', { itemId: 'work:PVTI_1', status: 'Blocked' }), badStatus);
  assert.deepEqual(await answer('work', { itemId: 'work:PVTI_1' }), badStatus);
  assert.deepEqual(await answer('work', { itemId: 'notes:PVTI_1', status: 'Done' }), [400, { error: 'itemId must be an item of this source' }]);
  assert.deepEqual(await answer('work', { status: 'Done' }), [400, { error: 'itemId must be an item of this source' }]);
  assert.deepEqual(await answer('bare', { itemId: 'bare:PVTI_1', status: 'Done' }), [404, { error: 'source has no native view' }]);
  assert.deepEqual(await answer('work', { itemId: 'work:PVTI_1', status: 'Done' }), [502, { error: 'Resource not accessible by integration' }]);
  assert.deepEqual(dispatched, []);
});

test('a write that failed midway answers the 502 with the re-read fields and row and dispatches itemRead, so the UI resyncs (#686)', async (t) => {
  const dispatched: HiveEvent[] = [];
  const partial: ViewSource = { ...editable([]), setField: async () => { throw new PartialWriteError('Resource not accessible by integration', WRITTEN); } };
  const base = routes(t, { work: partial }, {}, dispatched);
  const res = await post(fieldsUrl(base), { field: 'Priority', value: 'P0' });
  assert.deepEqual([res.status, await res.json()], [502, { error: 'Resource not accessible by integration', fields: WRITTEN.fields, row: ROW }]);
  assert.deepEqual(dispatched, [{ type: 'itemRead', source: 'work', itemId: 'work:PVTI_1', entry: ENTRY }]);
  const status = routes(t, { work: { settingsOptions: async () => OPTION_NAMES, ...partial } }, {}, []);
  const again = await post(`${status}/sources/work/project/status`, { itemId: 'work:PVTI_1', status: 'Ready' });
  assert.deepEqual([again.status, ((await again.json()) as { row?: ProjectItem }).row], [502, ROW]);
});

test('a dispatch that rejects after a good write still answers 200 with the fields and the row (#686)', async (t) => {
  const base = routes(t, { work: { settingsOptions: async () => OPTION_NAMES, ...editable([]) } }, {}, [], true);
  for (const res of [await post(fieldsUrl(base), { field: 'Priority', value: 'P0' }), await post(`${base}/sources/work/project/status`, { itemId: 'work:PVTI_1', status: 'Ready' })]) {
    assert.deepEqual([res.status, await res.json()], [200, { fields: WRITTEN.fields, row: ROW }]);
  }
});

test('an item the source does not have is a 404 in both write routes, not a 502 (#686)', async (t) => {
  const gone: ViewSource = { settingsOptions: async () => OPTION_NAMES, ...editable([]), setField: async () => { throw new ItemNotOnSourceError('work:PVTI_1'); } };
  const base = routes(t, { work: gone });
  const fieldsRes = await post(fieldsUrl(base), { field: 'Priority', value: 'P0' });
  assert.deepEqual([fieldsRes.status, await fieldsRes.json()], [404, { error: 'item work:PVTI_1 is not on the source' }]);
  const statusRes = await post(`${base}/sources/work/project/status`, { itemId: 'work:PVTI_1', status: 'Ready' });
  assert.equal(statusRes.status, 404);
});

test('POST …/fields checks the value against a fresh read: an option made on GitHub a minute ago passes (#282)', async (t) => {
  const asked: unknown[] = [];
  const base = routes(t, { work: { ...editable([]), fieldsOf: async (_itemId, options) => { asked.push(options); return FIELDS; } } });
  assert.equal((await post(fieldsUrl(base), { field: 'Priority', value: 'P0' })).status, 200);
  assert.deepEqual(asked, [{ fresh: true }]);
});

test('GET /sources/:name/project?fresh=1 asks the source fresh, then the option scopes of the view\'s repositories; a plain open asks neither (#282)', async (t) => {
  const asked: unknown[] = [];
  const refreshed: string[][] = [];
  const items = [{ ...ROW, repository: 'acme/r' }, { ...ROW, itemId: 'work:PVTI_2', repository: 'acme/r' }, { ...ROW, itemId: 'work:PVTI_3', repository: 'acme/site' }];
  const work: ViewSource = { project: async (options) => { asked.push(options); return { ...VIEW, items }; } };
  const base = routes(t, { work }, {}, [], false, { refreshOptions: async (repositories) => { refreshed.push(repositories); } });
  assert.equal((await fetch(`${base}/sources/work/project`)).status, 200);
  assert.equal((await fetch(`${base}/sources/work/project?fresh=1`)).status, 200);
  assert.deepEqual([asked, refreshed], [[{}, { fresh: true }], [['acme/r', 'acme/site']]]);
});

test('inside the quota backoff a stored view and stored fields still answer; a fresh view, a write and any read of a source with no read model are refused (#282)', async (t) => {
  const low = { syncs: { work: { quota: LOW } } };
  const work: ViewSource = { project: async () => VIEW, ...editable([]) };
  const stored = routes(t, { work }, low, [], false, { refreshOptions: async () => undefined });
  assert.equal((await fetch(`${stored}/sources/work/project`)).status, 200);
  assert.equal((await fetch(fieldsUrl(stored))).status, 200);
  assert.equal((await fetch(`${stored}/sources/work/project?fresh=1`)).status, 429);
  assert.equal((await post(fieldsUrl(stored), { field: 'Priority', value: 'P0' })).status, 429);
  const live = routes(t, { work }, low);
  assert.equal((await fetch(`${live}/sources/work/project`)).status, 429);
  assert.equal((await fetch(fieldsUrl(live))).status, 429);
});
