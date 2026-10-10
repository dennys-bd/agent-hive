import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchemaCatalog, parseCatalog, SCHEMA_CATALOG_URL } from '../src/json-schemas.js';

const PACKAGE = { name: 'package.json', url: 'https://json.schemastore.org/package.json', fileMatch: ['package.json'] };
const TSCONFIG = { name: 'tsconfig', url: 'https://json.schemastore.org/tsconfig.json', fileMatch: ['tsconfig.json', 'tsconfig.*.json'] };
const CATALOG = { schemas: [PACKAGE, TSCONFIG] };
const ASSOCIATIONS = [{ uri: PACKAGE.url, fileMatch: PACKAGE.fileMatch }, { uri: TSCONFIG.url, fileMatch: TSCONFIG.fileMatch }];

type Reply = () => Promise<Response>;
interface Call { url: string; signal: unknown }
const json = (body: unknown, status = 200): Reply => async () => new Response(JSON.stringify(body), { status });

// A fetch that answers each call with the next reply (the last one repeats) and records what it was asked
function stubFetch(...replies: Reply[]): { doFetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), signal: init?.signal });
    return replies[Math.min(calls.length, replies.length) - 1]();
  };
  return { doFetch, calls };
}

test('parseCatalog keeps an entry with an https url and file names, and drops the others one by one (#794)', () => {
  const raw = {
    schemas: [
      PACKAGE,
      { name: 'no fileMatch', url: 'https://x.org/a.json' },
      { url: 'https://x.org/b.json', fileMatch: [] },
      { url: 'http://x.org/c.json', fileMatch: ['c.json'] },
      { url: 'https://x.org/d.json', fileMatch: ['d.json', 4] },
      { url: 'not a url', fileMatch: ['e.json'] },
      'junk',
      TSCONFIG,
    ],
  };
  assert.deepEqual(parseCatalog(raw), ASSOCIATIONS);
});

test('parseCatalog returns nothing for a body without a schemas array (#794)', () => {
  for (const raw of [{}, { schemas: 'x' }, null, [], 'catalog']) assert.deepEqual(parseCatalog(raw), [], JSON.stringify(raw));
});

test('load fetches the catalog with a timeout signal and keeps one success for every later call, concurrent or not (#794)', async () => {
  const { doFetch, calls } = stubFetch(json(CATALOG));
  const catalog = createSchemaCatalog(doFetch);
  const [first, second] = await Promise.all([catalog.load(), catalog.load()]);
  assert.deepEqual([first, second], [{ associations: ASSOCIATIONS }, { associations: ASSOCIATIONS }]);
  assert.deepEqual(await catalog.load(), { associations: ASSOCIATIONS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SCHEMA_CATALOG_URL);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('load reports why the catalog is unavailable: HTTP status, invalid catalog, timeout, the network error code (#794)', async () => {
  const cases: [Reply, string][] = [
    [json({}, 503), 'HTTP 503'],
    [async () => new Response('<html>'), 'invalid catalog'],
    [json({ name: 'no schemas' }), 'invalid catalog'],
    [() => Promise.reject(new DOMException('aborted', 'TimeoutError')), 'timeout'],
    [() => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })), 'ENOTFOUND'],
  ];
  for (const [reply, failure] of cases) assert.deepEqual(await createSchemaCatalog(stubFetch(reply).doFetch).load(), { failure }, failure);
});

test('a failure is not kept: the next load fetches again (#794)', async () => {
  const { doFetch, calls } = stubFetch(json({}, 503), json(CATALOG));
  const catalog = createSchemaCatalog(doFetch);
  assert.deepEqual(await catalog.load(), { failure: 'HTTP 503' });
  assert.deepEqual(await catalog.load(), { associations: ASSOCIATIONS });
  assert.equal(calls.length, 2);
});
