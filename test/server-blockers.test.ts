import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState, reduce } from '../src/orchestrator.js';
import { ItemNotOnSourceError } from '../src/field-values.js';
import { blockingTypesOf, canRelateItem, refsOf, registerBlockerRoutes, relateItem } from '../src/server-blockers.js';
import { BadBlockerRefError, BadRelationTypeError, BlockerRefNotFoundError, RelationRereadError, SelfBlockerError } from '../src/blocker-errors.js';
import type { BlockerChange, HiveEvent, ItemBlockers, Relation, RelationChange, Source, SourceConfig, SourceItem, State, Task } from '../src/types.js';
import { namespaced } from '../src/source.js';
import { SourceRateLimitError } from '../src/source-errors.js';
import { fakeLog, GITHUB_ENTRY, JIRA_ENTRY } from './fakes.js';
import { adapter, end, fakeJira, inward, issue, outward, read, RELATES } from './sources/jira-fakes.js';

type RelateSource = Partial<Pick<Source, 'relate' | 'findBlockers' | 'linkTypes' | 'setRelation'>>;
const LOW = { limit: 5000, remaining: 499, resetsAt: '2999-01-01T00:00:00.000Z', at: '2026-10-06T12:00:00.000Z' };
const hive = (n: number, blockers?: ItemBlockers): Task =>
  ({ item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `T${n}`, body: '', url: '', ...(blockers ? { blockers } : {}) }, stage: 'dev', boardColumn: '', created: true, auto: false });
const GH_TASK: Task = { item: { itemId: 'work:PVTI_1', id: '12', title: 'Pager', body: '', url: 'https://github.com/acme/site/issues/12', source: 'work' }, stage: 'dev', boardColumn: '', auto: false };
const NONE: ItemBlockers = { blockedBy: [], blocking: [] };
const SEVEN: ItemBlockers = { blockedBy: [{ id: '7', title: 'T7', state: 'open' }], blocking: [] };
const ENTRY: SourceItem = { item: GH_TASK.item, column: 'Ready' };

interface Harness { base: string; dispatched: HiveEvent[]; lines: string[]; retries: string[]; state(): State }
// The blocker route alone over these sources and tasks; blockerSet runs through the real reducer, every event lands in `dispatched`
function routes(t: TestContext, sources: Record<string, RelateSource>, tasks: Task[] = [], extra: Partial<State> = {}, configs: SourceConfig[] = []): Harness {
  let state: State = { ...initialState(0), tasks, ...extra };
  const dispatched: HiveEvent[] = [];
  const retries: string[] = [];
  const { log, lines } = fakeLog();
  const app = express();
  app.use(express.json());
  registerBlockerRoutes(app, {
    requireLive: () => ({ state, runtime: { sources: new Map(Object.entries(sources)) } }),
    dispatch: async (event) => { dispatched.push(event); if (event.type === 'blockerSet') state = reduce(state, event).state; },
    latest: () => state,
    reportRetry: async (source, until) => { retries.push(`${source} ${until}`); },
    log,
    blockingLinkTypes: (name) => blockingTypesOf(configs, name),
  });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dispatched, lines, retries, state: () => state };
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
    bad: new BadBlockerRefError('x', '12, #12, owner/repo#12'), gone: new BlockerRefNotFoundError('99'), self: new SelfBlockerError(), other: new ItemNotOnSourceError('PVTI_9'),
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
  assert.deepEqual(await post(h.base, 'low', 'low:PVTI_1', add('bad')), [429, { error: 'GitHub quota is low', resetsAt: LOW.resetsAt }], 'refused before relate, as the fields route');
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

async function search(base: string, source: string, itemId: string, q?: string): Promise<[number, unknown]> {
  const query = q === undefined ? '' : `?q=${encodeURIComponent(q)}`;
  const res = await fetch(`${base}/sources/${source}/items/${encodeURIComponent(itemId)}/blockers/candidates${query}`);
  return [res.status, await res.json()];
}

test('GET …/blockers/candidates on hive answers the other hive tasks whose id or title holds q, case-blind, at most 8, never the item or a source\'s task (#57)', async (t) => {
  const titled = (n: number, title: string): Task => ({ ...hive(n), item: { ...hive(n).item, title } });
  const h = routes(t, {}, [titled(1, 'Pager'), titled(2, 'pager rewrite'), titled(3, 'Docs'), { ...GH_TASK, item: { ...GH_TASK.item, title: 'Pager' } }]);
  assert.deepEqual(await search(h.base, 'hive', 'local:1', 'PAGER'), [200, { candidates: [{ id: 'HIVE-2', title: 'pager rewrite', state: 'open' }] }]);
  assert.deepEqual(await search(h.base, 'hive', 'local:1', 'hive-3'), [200, { candidates: [{ id: 'HIVE-3', title: 'Docs', state: 'open' }] }]);
  const many = routes(t, {}, Array.from({ length: 12 }, (_, i) => hive(i + 1)));
  const [, body] = await search(many.base, 'hive', 'local:1', 'T');
  assert.equal((body as { candidates: unknown[] }).candidates.length, 8);
  assert.deepEqual(h.dispatched, []);
});

test('the candidates route on a source asks its findBlockers with the namespaced id and the trimmed text; a missing or too long q is a 400, no findBlockers a 404, the backoff a 429 (#57)', async (t) => {
  const asked: string[] = [];
  const findBlockers: NonNullable<RelateSource['findBlockers']> = async (itemId, text) => { asked.push(`${itemId} ${text}`); return SEVEN.blockedBy; };
  const h = routes(t, { work: { findBlockers }, bare: {}, low: { findBlockers } }, [], { syncs: { low: { quota: LOW } } });
  assert.deepEqual(await search(h.base, 'work', 'work:PVTI_1', ' pager '), [200, { candidates: SEVEN.blockedBy }]);
  assert.deepEqual(codeOf(await search(h.base, 'work', 'work:PVTI_1')), [400, 'blockers.badRequest']);
  assert.deepEqual(codeOf(await search(h.base, 'work', 'work:PVTI_1', ' ')), [400, 'blockers.badRequest']);
  assert.deepEqual(codeOf(await search(h.base, 'work', 'work:PVTI_1', 'x'.repeat(201))), [400, 'blockers.badRequest']);
  assert.deepEqual(codeOf(await search(h.base, 'bare', 'bare:PVTI_1', 'pager')), [404, 'blockers.unknownItem'], 'no findBlockers');
  assert.deepEqual(codeOf(await search(h.base, 'work', 'notes:PVTI_1', 'pager')), [404, 'blockers.unknownItem'], 'another source\'s item');
  assert.equal((await search(h.base, 'low', 'low:PVTI_1', 'pager'))[0], 429);
  assert.deepEqual(asked, ['work:PVTI_1 pager'], 'every refusal comes before the search');
});

test('a refused search answers 502 refused without the source\'s words, which go to the log (#57)', async (t) => {
  const h = routes(t, { work: { findBlockers: async () => { throw new Error('Resource not accessible by integration'); } } });
  const [status, body] = await search(h.base, 'work', 'work:PVTI_1', 'pager');
  assert.deepEqual([status, (body as { code?: unknown }).code], [502, 'blockers.refused']);
  assert.equal(JSON.stringify(body).includes('Resource not accessible'), false, 'GitHub\'s words stay out of the answer');
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('Resource not accessible by integration')), 'and go to the log');
});

test('relateItem writes as the route does, the path picked by the item\'s own source; a backoff and no live Hive are refusals (#294)', async () => {
  const low: Task = { ...GH_TASK, item: { ...GH_TASK.item, itemId: 'low:PVTI_1', source: 'low' } };
  let state: State = { ...initialState(0), tasks: [hive(1), hive(2), GH_TASK, low], syncs: { low: { quota: LOW } } };
  const dispatched: HiveEvent[] = [];
  const deps = { dispatch: async (event: HiveEvent) => { dispatched.push(event); if (event.type === 'blockerSet') state = reduce(state, event).state; }, latest: () => state, reportRetry: async () => {} };
  const work: RelateSource = { relate: async () => ({ blockers: SEVEN, entry: ENTRY }) };
  const live = () => ({ state, runtime: { sources: new Map(Object.entries({ work, low: work })) } });
  assert.deepEqual(await relateItem(deps, live(), 'local:1', add('HIVE-2')), { blockers: { blockedBy: [{ id: 'HIVE-2', title: 'T2', state: 'open' }], blocking: [] } });
  assert.deepEqual(await relateItem(deps, live(), 'work:PVTI_1', add('#7')), { blockers: SEVEN });
  assert.deepEqual(dispatched.map((e) => e.type), ['blockerSet', 'itemRead']);
  assert.deepEqual(await relateItem(deps, live(), 'local:1', add('HIVE-1')), { refusal: { status: 400, error: 'an item cannot block itself', code: 'blockers.self' } });
  assert.deepEqual(await relateItem(deps, live(), 'low:PVTI_1', add('7')), { refusal: { status: 429, error: 'GitHub quota is low', resetsAt: LOW.resetsAt } });
  assert.deepEqual(await relateItem(deps, undefined, 'local:1', add('HIVE-2')), { refusal: { status: 404, error: 'no such item on this source', code: 'blockers.unknownItem' } });
});

test('canRelateItem: a hive task always, a source\'s task when its adapter relates; an unknown item never (#294)', () => {
  const bare: Task = { ...GH_TASK, item: { ...GH_TASK.item, itemId: 'bare:PVTI_1', source: 'bare' } };
  const sources = new Map<string, RelateSource>([['work', { relate: async () => ({ blockers: NONE }) }], ['bare', {}]]);
  const live = { state: { ...initialState(0), tasks: [hive(1), GH_TASK, bare] }, runtime: { sources } };
  assert.deepEqual(['local:1', 'work:PVTI_1', 'bare:PVTI_1', 'local:9'].map((id) => canRelateItem(live, id)), [true, true, false, false]);
});

test('refsOf reads hive_stop\'s block as the route\'s refs: positive integers and trimmed strings up to 200, 1 to 10 of them (#294)', () => {
  assert.deepEqual(refsOf([12, ' #13 ', 'acme/site#14', 'HIVE-2']), ['12', '#13', 'acme/site#14', 'HIVE-2']);
  const bad: (number | string)[][] = [[], [0], [-3], [1.5], [' '], ['x'.repeat(201)], Array.from({ length: 11 }, (_, i) => i + 1)];
  for (const block of bad) assert.equal(refsOf(block), undefined, JSON.stringify(block).slice(0, 40));
});

test('a source whose refs read ABC-12 gets ABC-12 at relate and its blockers back unchanged; its BadBlockerRefError answers 400 with its own words (#810)', async (t) => {
  const asked: string[] = [];
  const ABC: ItemBlockers = { blockedBy: [{ id: 'ABC-12', title: 'T12', state: 'open' }], blocking: [] };
  const jira: RelateSource = {
    relate: async (_itemId, change) => {
      if (change.ref === 'acme/r12') throw new BadBlockerRefError(change.ref, 'ABC-12');
      asked.push(change.ref);
      return { blockers: ABC };
    },
  };
  const h = routes(t, { jira });
  assert.deepEqual(await post(h.base, 'jira', 'jira:J1', add('ABC-12')), [200, { blockers: ABC }]);
  assert.deepEqual(asked, ['ABC-12']);
  assert.deepEqual(await post(h.base, 'jira', 'jira:J1', add('acme/r12')), [400, { error: '"acme/r12" is no ref: write ABC-12 or a task id', code: 'blockers.badRequest' }]);
  assert.deepEqual(h.dispatched, []);
});

const TYPES = [{ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, { name: 'Relates', inward: 'relates to', outward: 'relates to' }];
async function linkTypes(base: string, source: string, query = ''): Promise<[number, unknown]> {
  const res = await fetch(`${base}/sources/${source}/link-types${query}`);
  return [res.status, await res.json()];
}

test('GET /sources/:name/link-types answers a jira source\'s types with their phrases, [] for a github source, 404 for an unknown name; a rate limit is a 429, any other failure a 502 (#828)', async (t) => {
  const tickets = namespaced(JIRA_ENTRY, adapter({ call: fakeJira({ 'GET /issueLinkType': [{ issueLinkTypes: TYPES }] }).call }));
  const until = '2999-01-01T00:00:00.000Z';
  const h = routes(t, {
    tickets, work: { relate: async () => ({ blockers: NONE }) },
    limited: { linkTypes: async () => { throw new SourceRateLimitError(until); } },
    broken: { linkTypes: async () => { throw new Error('jira api: HTTP 500'); } },
  });
  assert.deepEqual(await linkTypes(h.base, 'tickets'), [200, { linkTypes: TYPES }]);
  assert.deepEqual(await linkTypes(h.base, 'work'), [200, { linkTypes: [] }]);
  assert.deepEqual(await linkTypes(h.base, 'nope'), [404, { error: 'no such source' }]);
  assert.deepEqual(await linkTypes(h.base, 'limited'), [429, { error: `rate limited until ${until}`, resetsAt: until }]);
  assert.deepEqual(h.retries, [`limited ${until}`]);
  assert.deepEqual(await linkTypes(h.base, 'broken'), [502, { error: 'jira api: HTTP 500' }]);
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('jira api: HTTP 500')));
});

test('POST …/blockers on a jira task adds and removes a blocker by its key and answers the re-read relations, dispatching each listed entry (#828)', async (t) => {
  const linked = read(issue(1, 'To Do', { issuelinks: [inward('20001', end(2))] }));
  const fake = fakeJira({
    'GET /issue/10001': [read(issue(1, 'To Do')), linked, linked, read(issue(1, 'To Do'))],
    'GET /issue/ABC-2': [read(issue(2, 'To Do')), read(issue(2, 'To Do'))],
    'POST /issueLink': [undefined], 'DELETE /issueLink/20001': [undefined],
  });
  const h = routes(t, { tickets: namespaced(JIRA_ENTRY, adapter({ call: fake.call })) });
  const two = { blockedBy: [{ id: 'ABC-2', title: 'Issue 2', state: 'open' }], blocking: [] };
  assert.deepEqual(await post(h.base, 'tickets', 'tickets:10001', add('ABC-2')), [200, { blockers: two }]);
  assert.deepEqual(await post(h.base, 'tickets', 'tickets:10001', { action: 'remove', kind: 'blockedBy', ref: 'ABC-2' }), [200, { blockers: NONE }]);
  assert.deepEqual(fake.bodies, [{ type: { name: 'Blocks' }, inwardIssue: { key: 'ABC-2' }, outwardIssue: { key: 'ABC-1' } }]);
  assert.deepEqual(h.dispatched.map((e) => [e.type, 'itemId' in e && e.itemId]), [['itemRead', 'tickets:10001'], ['itemRead', 'tickets:10001']]);
});

async function postRelation(base: string, source: string, itemId: string, body: unknown): Promise<[number, unknown]> {
  const res = await fetch(`${base}/sources/${source}/items/${encodeURIComponent(itemId)}/relations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}
const relAdd = (ref: string): RelationChange => ({ action: 'add', type: 'Relates', direction: 'outward', ref });
const TWO_RELATES: Relation = { id: 'ABC-2', title: 'Issue 2', state: 'open', type: 'Relates', direction: 'outward', phrase: 'relates to' };

test('POST …/relations on a jira task adds and removes a relation by its key and answers { relations }, dispatching each listed entry under the listed ids (#829)', async (t) => {
  const linked = read(issue(1, 'To Do', { issuelinks: [outward('20001', end(2), RELATES)] }));
  const fake = fakeJira({
    'GET /issue/10001': [read(issue(1, 'To Do')), linked, linked, read(issue(1, 'To Do'))],
    'GET /issue/ABC-2': [read(issue(2, 'To Do')), read(issue(2, 'To Do'))],
    'POST /issueLink': [undefined], 'DELETE /issueLink/20001': [undefined],
  });
  const h = routes(t, { tickets: namespaced(JIRA_ENTRY, adapter({ call: fake.call })) });
  assert.deepEqual(await postRelation(h.base, 'tickets', 'tickets:10001', relAdd('ABC-2')), [200, { relations: [TWO_RELATES] }]);
  assert.deepEqual(await postRelation(h.base, 'tickets', 'tickets:10001', { ...relAdd('ABC-2'), action: 'remove' }), [200, { relations: [] }]);
  assert.deepEqual(h.dispatched.map((e) => [e.type, e.type === 'itemRead' && e.entry?.item.itemId]), [['itemRead', 'tickets:10001'], ['itemRead', 'tickets:10001']]);
});

test('POST …/relations refuses with a code: a github source, hive and another source\'s item are unknownItem; a bad body and a blocking type badRequest; the source\'s words stay in the log (#829)', async (t) => {
  const thrown: Record<string, Error> = {
    blocks: new BadRelationTypeError('Blocks'), gone: new BlockerRefNotFoundError('ABC-9'), self: new SelfBlockerError(), raw: new Error('jira api: HTTP 400'),
  };
  const setRelation: NonNullable<RelateSource['setRelation']> = async (_itemId, change) => { throw thrown[change.ref] ?? new Error(`no answer for ${change.ref}`); };
  const h = routes(t, { tickets: { setRelation }, work: { relate: async () => ({ blockers: NONE }) } }, [hive(1), hive(2)]);
  const code = async (source: string, itemId: string, body: unknown) => codeOf(await postRelation(h.base, source, itemId, body));
  assert.deepEqual(await code('work', 'work:PVTI_1', relAdd('ABC-2')), [404, 'blockers.unknownItem'], 'a github source has no setRelation');
  assert.deepEqual(await code('hive', 'local:1', relAdd('HIVE-2')), [404, 'blockers.unknownItem'], 'hive tasks have no relations');
  assert.deepEqual(await code('tickets', 'work:PVTI_1', relAdd('ABC-2')), [404, 'blockers.unknownItem'], 'another source\'s item');
  const bad = [
    { ...relAdd('ABC-2'), action: 'link' }, { ...relAdd('ABC-2'), type: ' ' }, { ...relAdd('ABC-2'), type: 'x'.repeat(201) },
    { ...relAdd('ABC-2'), direction: 'both' }, relAdd(' '), { action: 'add', kind: 'blockedBy', ref: 'ABC-2' },
  ];
  for (const body of bad) assert.deepEqual(await code('tickets', 'tickets:10001', body), [400, 'blockers.badRequest'], JSON.stringify(body).slice(0, 60));
  assert.deepEqual(await postRelation(h.base, 'tickets', 'tickets:10001', relAdd('blocks')),
    [400, { error: '"Blocks" is a blocking link type: the blockers section edits it', code: 'blockers.badRequest' }]);
  assert.deepEqual(await code('tickets', 'tickets:10001', relAdd('gone')), [404, 'blockers.unknownRef']);
  assert.deepEqual(await code('tickets', 'tickets:10001', relAdd('self')), [400, 'blockers.self']);
  const [status, body] = await postRelation(h.base, 'tickets', 'tickets:10001', relAdd('raw'));
  assert.deepEqual([status, (body as { code?: unknown }).code], [502, 'blockers.refused']);
  assert.equal(JSON.stringify(body).includes('HTTP 400'), false, 'Jira\'s words stay out of the answer');
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('jira api: HTTP 400')), 'and go to the log');
  assert.deepEqual(h.dispatched, []);
});

test('a relation written whose re-read failed answers 200 with the relations read, or 502 refused when none were read (#829)', async (t) => {
  const h = routes(t, {
    read: { setRelation: async () => { throw new RelationRereadError('timeout', undefined, [TWO_RELATES]); } },
    none: { setRelation: async () => { throw new RelationRereadError('timeout'); } },
  });
  assert.deepEqual(await postRelation(h.base, 'read', 'read:1', relAdd('ABC-2')), [200, { relations: [TWO_RELATES] }]);
  assert.deepEqual(codeOf(await postRelation(h.base, 'none', 'none:1', relAdd('ABC-2'))), [502, 'blockers.refused']);
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('relations of read:1 written')));
});

test('blockingTypesOf reads a jira entry\'s blocking types and none for a github or unknown one (#829)', () => {
  assert.deepEqual([blockingTypesOf([JIRA_ENTRY, GITHUB_ENTRY], JIRA_ENTRY.name), blockingTypesOf([JIRA_ENTRY, GITHUB_ENTRY], GITHUB_ENTRY.name), blockingTypesOf([], JIRA_ENTRY.name)], [['Blocks'], [], []]);
});

test('GET …/link-types?relations=1 leaves out the source\'s blocking types; without the flag it answers them all (#829)', async (t) => {
  const tickets = namespaced(JIRA_ENTRY, adapter({ call: fakeJira({ 'GET /issueLinkType': [{ issueLinkTypes: TYPES }, { issueLinkTypes: TYPES }] }).call }));
  const h = routes(t, { tickets }, [], {}, [JIRA_ENTRY]);
  assert.deepEqual(await linkTypes(h.base, 'tickets', '?relations=1'), [200, { linkTypes: [TYPES[1]] }]);
  assert.deepEqual(await linkTypes(h.base, 'tickets'), [200, { linkTypes: TYPES }]);
});
