import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { taskOfWorker } from '../src/activities.js';
import { parseConfig } from '../src/config.js';
import type { LegacyStage } from '../src/config-migrate.js';
import { initialState } from '../src/orchestrator.js';
import { shouldPoll } from '../src/polling.js';
import { createServer, type HiveServer } from '../src/server.js';
import { createSources } from '../src/source.js';
import { SourceRateLimitError } from '../src/source-errors.js';
import type { ItemField, Source, SourceItem, SourceSpec } from '../src/types.js';
import { HOUR_MS } from '../src/usage.js';
import { combConfig, fakeSpawn, GITHUB_ENTRY, goneItem, move, OPTIONS, tempHive, WORKSPACE } from './fakes.js';
import { SECRET } from './secret-client.js';

// #812: two sources of no GitHub shape (no quota()), work and notes. A listing throws the fake's limited; every write its writeLimited, else
// a move or an action records itself
interface Fake { listed: SourceItem[]; limited?: SourceRateLimitError; writeLimited?: SourceRateLimitError; writes: string[] }
interface Harness { base: string; server: HiveServer; work: Fake; notes: Fake }

const STAGES: LegacyStage[] = [{ name: 'fila', from: { work: ['Ready'], notes: ['Ready'] }, onStart: { work: [move('In progress')] }, onFinish: { work: [{ type: 'close' }] }, prompt: 'x' }];
const FIELDS: ItemField[] = [{ name: 'Priority', type: 'singleSelect', value: 'P1', options: ['P0', 'P1'] }];
const inMs = (ms: number): string => new Date(Date.now() + ms).toISOString();
const listing = (id: string): SourceItem => ({ item: { itemId: id, id, title: `Task ${id}`, body: '', url: '' }, column: 'Ready' });

function fakeSource(fake: Fake): Source {
  const write = (what: string): void => { if (fake.writeLimited) throw fake.writeLimited; fake.writes.push(what); };
  const limitedOnly = (): Error => fake.writeLimited ?? new Error('this fake answers a write only with its rate limit');
  return {
    item: goneItem, resolveFields: async () => {}, settingsOptions: async () => OPTIONS,
    listItems: async () => { if (fake.limited) throw fake.limited; return [...fake.listed]; },
    setColumn: async (itemId, column) => write(`${itemId}→${column}`),
    apply: async (itemId, action) => write(`${itemId} ${action.type}`),
    fieldsOf: async () => FIELDS,
    setField: async () => { throw limitedOnly(); },
    relate: async () => { throw limitedOnly(); },
    create: async () => { throw limitedOnly(); },
  };
}

async function start(t: TestContext, cap = 0): Promise<Harness> {
  const { home, repo } = await tempHive(t, cap);
  const fakes: Record<string, Fake> = { work: { listed: [], writes: [] }, notes: { listed: [], writes: [] } };
  const factory = (spec: SourceSpec): Source => fakeSource(fakes[spec.source.name]);
  const sources = [{ ...GITHUB_ENTRY, name: 'work', repository: 'acme/app' }, { ...GITHUB_ENTRY, name: 'notes', number: 8 }];
  const config = parseConfig(combConfig({ sources, stages: STAGES, path: repo }));
  const server = createServer({
    secret: SECRET, home, sourceFactory: factory, launchPty: fakeSpawn().spawn, exec: async () => ({ stdout: '' }),
    runtime: { config, sources: createSources(config, factory) }, state: { ...initialState(cap), workspaces: [WORKSPACE] },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  await server.dispatch({ type: 'setStages', flows: config.comb.flows }); // an injected runtime brings no flow into the state
  await server.poll(); // settle the boot's own poll on the empty listings
  return { base: `http://127.0.0.1:${port}`, server, work: fakes.work, notes: fakes.notes };
}

test('a listing the source rate limits puts that source alone in backoff with its error beside the wait; the other keeps polling, and the next good poll clears both (#812)', async (t) => {
  const h = await start(t, 1); // a free worker: the timer polls a source that is not waiting
  const until = inMs(HOUR_MS);
  h.notes.limited = new SourceRateLimitError(until);
  await h.server.poll();
  const state = h.server.getState()!;
  assert.deepEqual([state.syncs.notes.backoffUntil, state.syncs.notes.error], [until, h.notes.limited.message]);
  assert.equal(state.syncs.notes.quota, undefined, 'no quota(): never the quota backoff (decision 12)');
  assert.deepEqual([state.syncs.work.backoffUntil, state.syncs.work.error], [undefined, undefined]);
  const now = Date.now();
  assert.deepEqual([shouldPoll(state, 'notes', now), shouldPoll(state, 'work', now)], [false, true], 'the timer\'s own check skips notes alone');
  h.notes.limited = undefined;
  await h.server.poll(); // a manual refresh bypasses shouldPoll, as it bypasses the quota backoff
  const cleared = h.server.getState()!.syncs.notes;
  assert.deepEqual([cleared.backoffUntil, cleared.error], [undefined, undefined]);
});

test('a move the source rate limits puts the source in backoff, then fails as before: the error bar names the write, nothing is written (#812)', async (t) => {
  const h = await start(t, 1);
  h.work.writeLimited = new SourceRateLimitError(inMs(HOUR_MS));
  h.work.listed.push(listing('12'));
  await h.server.dispatch({ type: 'setSignal', signal: 'green' });
  await h.server.poll(); // the task starts, and its onStart moves it on the source
  const state = h.server.getState()!;
  assert.equal(state.syncs.work.backoffUntil, h.work.writeLimited.retryAt);
  assert.equal(state.error, `source.setColumn(In progress): ${h.work.writeLimited.message}`);
  assert.deepEqual(h.work.writes, []);
});

test('a source action the source rate limits puts the source in backoff and is refused as before (#812)', async (t) => {
  const h = await start(t, 1);
  h.work.listed.push(listing('12'));
  await h.server.dispatch({ type: 'setSignal', signal: 'green' });
  await h.server.poll();
  h.work.writeLimited = new SourceRateLimitError(inMs(HOUR_MS));
  const current = h.server.getState()!;
  const ptyId = current.workers.find((s) => taskOfWorker(current, s)?.item.itemId === 'work:12')!.runId!;
  await h.server.dispatch({ type: 'done', ptyId });
  await h.server.dispatch({ type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } }); // onFinish: the close
  assert.equal(h.server.getState()!.syncs.work.backoffUntil, h.work.writeLimited.retryAt);
  assert.deepEqual(h.work.writes, ['12→In progress'], 'the close was never written');
});

test('reportRetry, the read model loop\'s path, puts a source in backoff as a poll does, and an earlier time never shortens it (#812)', async (t) => {
  const h = await start(t, 1);
  const until = inMs(HOUR_MS);
  await h.server.reportRetry('notes', until);
  await h.server.reportRetry('notes', inMs(60_000));
  const state = h.server.getState()!;
  assert.equal(state.syncs.notes.backoffUntil, until);
  assert.deepEqual([shouldPoll(state, 'notes', Date.now()), shouldPoll(state, 'work', Date.now())], [false, true]);
});
