import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState, reduce } from '../src/orchestrator.js';
import { ItemNotOnSourceError } from '../src/field-values.js';
import { registerBlockerRoutes } from '../src/server-blockers.js';
import { BadBlockerRefError, BlockerRefNotFoundError, RelationRereadError, SelfBlockerError } from '../src/sources/github-blockers.js';
import type { BlockerChange, HiveEvent, ItemBlockers, Source, SourceItem, State, Task } from '../src/types.js';
import { fakeLog } from './fakes.js';

type RelateSource = Partial<Pick<Source, 'relate'>>;
const LOW = { limit: 5000, remaining: 499, resetsAt: '2999-01-01T00:00:00.000Z', at: '2026-10-06T12:00:00.000Z' };
const hive = (n: number, blockers?: ItemBlockers): Task =>
  ({ item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `T${n}`, body: '', url: '', ...(blockers ? { blockers } : {}) }, stage: 'dev', boardColumn: '', created: true, auto: false });
const GH_TASK: Task = { item: { itemId: 'work:PVTI_1', id: '12', title: 'Pager', body: '', url: 'https://github.com/acme/site/issues/12', source: 'work' }, stage: 'dev', boardColumn: '', auto: false };
const NONE: ItemBlockers = { blockedBy: [], blocking: [] };
const SEVEN: ItemBlockers = { blockedBy: [{ id: '7', title: 'T7', state: 'open' }], blocking: [] };
const ENTRY: SourceItem = { item: GH_TASK.item, column: 'Ready' };

interface Harness { base: string; dispatched: HiveEvent[]; lines: string[]; state(): State }
// The blocker route alone over these sources and tasks; blockerSet runs through the real reducer, every event lands in `dispatched`
function routes(t: TestContext, sources: Record<string, RelateSource>, tasks: Task[] = [], extra: Partial<State> = {}): Harness {
  let state: State = { ...initialState(0), tasks, ...extra };
  const dispatched: HiveEvent[] = [];
  const { log, lines } = fakeLog();
  const app = express();
  app.use(express.json());
  registerBlockerRoutes(app, {
    requireLive: () => ({ state, runtime: { sources: new Map(Object.entries(sources)) } }),
    dispatch: async (event) => { dispatched.push(event); if (event.type === 'blockerSet') state = reduce(state, event).state; },
    latest: () => state,
    log,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dispatched, lines, state: () => state };
}

async function post(base: string, source: string, itemId: string, body: unknown): Promise<[number, unknown]> {
  const res = await fetch(`${base}/sources/${source}/items/${encodeURIComponent(itemId)}/blockers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}
const codeOf = ([status, body]: [number, unknown]): [number, unknown] => [status, (body as { code?: unknown }).code];
const add = (ref: string, kind: BlockerChange['kind'] = 'blockedBy'): BlockerChange => ({ action: 'add', kind, ref });

test('POST /sources/hive/items/:itemId/blockers dispatches blockerSet and answers the task\'s blockers; the other task gets the mirror (#56)', async (t) => {
  const h = routes(t, {}, [hive(1), hive(2)]);
  assert.deepEqual(await post(h.base, 'hive', 'local:1', add('HIVE-2')), [200, { blockers: { blockedBy: [{ id: 'HIVE-2', title: 'T2', state: 'open' }], blocking: [] } }]);
  assert.deepEqual(h.dispatched, [{ type: 'blockerSet', itemId: 'local:1', change: add('HIVE-2') }]);
  assert.deepEqual(h.state().tasks[1].item.blockers, { blockedBy: [], blocking: [{ id: 'HIVE-1', title: 'T1', state: 'open' }] });
  assert.deepEqual(await post(h.base, 'hive', 'local:1', { action: 'remove', kind: 'blockedBy', ref: 'HIVE-2' }), [200, { blockers: NONE }]);
});

test('the hive path refuses with a code: a bad body, an unknown or non-hive item, an unknown ref, another source\'s item, self and the reverse relation; none dispatches (#56)', async (t) => {
  const first = hive(1, { blockedBy: [], blocking: [{ id: 'HIVE-2', title: 'T2', state: 'open' }] });
  const second = hive(2, { blockedBy: [{ id: 'HIVE-1', title: 'T1', state: 'open' }], blocking: [] });
  const h = routes(t, {}, [first, second, GH_TASK]);
  const code = async (itemId: string, body: unknown) => codeOf(await post(h.base, 'hive', itemId, body));
  assert.deepEqual(await code('local:1', { action: 'link', kind: 'blockedBy', ref: 'HIVE-2' }), [400, 'blockers.badRequest']);
  assert.deepEqual(await code('local:1', { action: 'add', kind: 'blockedBy', ref: ' ' }), [400, 'blockers.badRequest']);
  assert.deepEqual(await code('local:9', add('HIVE-2')), [404, 'blockers.unknownItem']);
  assert.deepEqual(await code('work:PVTI_1', add('HIVE-2')), [404, 'blockers.unknownItem']);
  assert.deepEqual(await code('local:1', add('HIVE-9')), [404, 'blockers.unknownRef']);
  assert.deepEqual(await code('local:1', add('12')), [400, 'blockers.crossSource']);
  assert.deepEqual(await code('local:1', add('HIVE-1')), [400, 'blockers.self']);
  assert.deepEqual(await code('local:1', add('HIVE-2')), [409, 'blockers.cycle'], 'HIVE-2 is already blocked by HIVE-1');
  assert.deepEqual(h.dispatched, []);
});

test('a source\'s item goes through relate with its namespaced id; an entry is dispatched as itemRead, none dispatches nothing (#56)', async (t) => {
  const asked: string[] = [];
  const work: RelateSource = { relate: async (itemId, change) => { asked.push(`${itemId} ${change.action} ${change.kind} ${change.ref}`); return { blockers: SEVEN, entry: ENTRY }; } };
  const quiet: RelateSource = { relate: async () => ({ blockers: NONE }) };
  const h = routes(t, { work, quiet });
  assert.deepEqual(await post(h.base, 'work', 'work:PVTI_1', add('#7')), [200, { blockers: SEVEN }]);
  assert.deepEqual(asked, ['work:PVTI_1 add blockedBy #7']);
  assert.deepEqual(await post(h.base, 'quiet', 'quiet:PVTI_1', add('7')), [200, { blockers: NONE }]);
  assert.deepEqual(h.dispatched, [{ type: 'itemRead', source: 'work', itemId: 'work:PVTI_1', entry: ENTRY }]);
});

test('the source path refuses with a code and never answers GitHub\'s words, which go to the log; inside the quota backoff it is a 429 (#56)', async (t) => {
  const thrown: Record<string, Error> = {
    bad: new BadBlockerRefError('x'), gone: new BlockerRefNotFoundError('99'), self: new SelfBlockerError(), other: new ItemNotOnSourceError('PVTI_9'),
    raw: new Error('Resource not accessible by integration'),
  };
  const relate: NonNullable<RelateSource['relate']> = async (_itemId, change) => { throw thrown[change.ref]; };
  const h = routes(t, { work: { relate }, bare: {}, low: { relate } }, [], { syncs: { low: { quota: LOW } } });
  const code = async (source: string, itemId: string, ref: string) => codeOf(await post(h.base, source, itemId, add(ref)));
  assert.deepEqual(await code('bare', 'bare:PVTI_1', 'bad'), [404, 'blockers.unknownItem'], 'no relate');
  assert.deepEqual(await code('nope', 'nope:PVTI_1', 'bad'), [404, 'blockers.unknownItem'], 'no such source');
  assert.deepEqual(await code('work', 'notes:PVTI_1', 'bad'), [404, 'blockers.unknownItem'], 'another source\'s item');
  assert.deepEqual(await code('work', 'work:PVTI_1', 'bad'), [400, 'blockers.badRequest']);
  assert.deepEqual(await code('work', 'work:PVTI_1', 'gone'), [404, 'blockers.unknownRef']);
  assert.deepEqual(await code('work', 'work:PVTI_1', 'self'), [400, 'blockers.self']);
  assert.deepEqual(await code('work', 'work:PVTI_1', 'other'), [404, 'blockers.unknownItem']);
  const [status, body] = await post(h.base, 'work', 'work:PVTI_1', add('raw'));
  assert.deepEqual([status, (body as { code?: unknown }).code], [502, 'blockers.refused']);
  assert.equal(JSON.stringify(body).includes('Resource not accessible'), false, 'GitHub\'s words stay out of the answer');
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('Resource not accessible by integration')), 'and go to the log');
  assert.equal((await post(h.base, 'low', 'low:PVTI_1', add('bad')))[0], 429, 'refused before relate, as the fields route');
  assert.deepEqual(h.dispatched, []);
});

test('a source write whose relations could not be re-read answers 502 refused, so the UI never shows it as gone (#56)', async (t) => {
  const h = routes(t, { work: { relate: async () => { throw new RelationRereadError('timeout'); } } });
  const [status, body] = await post(h.base, 'work', 'work:PVTI_1', add('7'));
  assert.deepEqual([status, (body as { code?: unknown }).code], [502, 'blockers.refused']);
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('timeout')));
});

test('a source write whose re-read failed answers 200 with the relations read, logs the failure and dispatches nothing (#56)', async (t) => {
  const h = routes(t, { work: { relate: async () => { throw new RelationRereadError('timeout', SEVEN); } } });
  assert.deepEqual(await post(h.base, 'work', 'work:PVTI_1', add('7')), [200, { blockers: SEVEN }]);
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('timeout')));
  assert.deepEqual(h.dispatched, []);
});
