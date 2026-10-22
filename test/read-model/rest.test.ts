import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpRest, nextOf } from '../../src/read-model/rest.js';

const RESET = 1_791_234_567;
const QUOTA_HEADERS = { 'X-Ratelimit-Limit': '5000', 'X-Ratelimit-Remaining': '4990', 'X-Ratelimit-Used': '10', 'X-Ratelimit-Reset': String(RESET) };
const QUOTA = { limit: 5000, remaining: 4990, used: 10, resetsAt: new Date(RESET * 1000).toISOString() };
const PATH = 'repos/acme/hive/issues?per_page=100';
const OUTSIDE = 'github rest: next page outside the repository';
const TOKEN = `test-${randomUUID()}`; // built at runtime: no token in a fixture
const next = (url: string): string => `<${url}>; rel="next"`;
const respond = (status: number, headers: Record<string, string> = {}, body: string | null = null): Response => new Response(body, { status, headers });

interface Call { url: string; init: RequestInit; headers: Record<string, string> }

/** A fetch answering `answers` in order, recording every call. */
function fakeFetch(...answers: Response[]): { doFetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, headers: init.headers as Record<string, string> });
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error('no answer left');
    return answer;
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}
const restOver = (doFetch: typeof fetch, onUnauthorized?: () => void) => httpRest({ token: async () => TOKEN, fetch: doFetch, onUnauthorized });

test('httpRest sends the bearer and the ETag as If-None-Match, no redirect, and reads a 200: its JSON, ETag, next page and quota (#503)', async () => {
  const link = `${next('https://api.github.com/repositories/1/issues?per_page=100&page=2')}, <https://api.github.com/repositories/1/issues?page=3>; rel="last"`;
  const { doFetch, calls } = fakeFetch(respond(200, { ETag: 'W/"abc"', Link: link, ...QUOTA_HEADERS }, '[{"node_id":"I_1"}]'));
  const answer = await restOver(doFetch)(PATH, 'W/"old"');
  assert.deepEqual(answer, { status: 200, body: [{ node_id: 'I_1' }], etag: 'W/"abc"', next: 'repositories/1/issues?per_page=100&page=2', quota: QUOTA });
  assert.equal(calls[0]?.url, `https://api.github.com/${PATH}`);
  assert.deepEqual(calls[0]?.headers, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'If-None-Match': 'W/"old"' });
  assert.equal(calls[0]?.init.redirect, 'manual', 'a 301 stays the moved answer, and the bearer never follows it');
  assert.ok(calls[0]?.init.signal, 'a timeout, not an open-ended call');
});

test('a 304 carries its quota; 301, 404 and 410 are gone with no quota invented; with no ETag no header is sent (#503)', async () => {
  const { doFetch, calls } = fakeFetch(respond(304, QUOTA_HEADERS), respond(301), respond(404, {}, '{}'), respond(410));
  const rest = restOver(doFetch);
  assert.deepEqual(await rest(PATH, 'W/"e"'), { status: 304, quota: QUOTA });
  assert.deepEqual(await rest('repos/acme/hive/issues/9'), { status: 301 }, 'an absent header is no 0 quota');
  assert.deepEqual(await rest('repos/acme/hive/issues/9'), { status: 404 });
  assert.deepEqual(await rest('repos/acme/hive/issues/9'), { status: 410 });
  assert.ok(!('If-None-Match' in (calls[1]?.headers ?? {})));
});

test('an unexpected status and a body that is no JSON throw without the body or the token (#503)', async () => {
  for (const [res, message] of [[respond(500, {}, TOKEN), 'github rest: HTTP 500'], [respond(200, {}, `not json ${TOKEN}`), 'github rest: invalid JSON body']] as const) {
    const err = await restOver(fakeFetch(res).doFetch)('p').then(() => undefined, (e: Error) => e);
    assert.equal(err?.message, message);
    assert.ok(!err?.message.includes(TOKEN));
  }
});

test('a 401 calls onUnauthorized and throws its status; any other failure does not call it (#503)', async () => {
  let dropped = 0;
  const onUnauthorized = (): void => {
    dropped += 1;
  };
  await assert.rejects(restOver(fakeFetch(respond(401)).doFetch, onUnauthorized)(PATH), { message: 'github rest: HTTP 401' });
  await assert.rejects(restOver(fakeFetch(respond(403)).doFetch, onUnauthorized)(PATH), { message: 'github rest: HTTP 403' });
  assert.equal(dropped, 1);
});

test('a 200 whose next page leaves the repository throws (#503)', async () => {
  const off = respond(200, { Link: next('https://api.github.com/repos/acme/other/issues?page=2') }, '[]');
  await assert.rejects(restOver(fakeFetch(off).doFetch)(PATH), { message: OUTSIDE });
});

test('nextOf follows the same repository, by name or by id, and rejects any other Link (#178)', () => {
  assert.equal(nextOf(undefined, PATH), undefined);
  assert.equal(nextOf('<https://api.github.com/repos/acme/hive/issues?page=1>; rel="prev"', PATH), undefined);
  assert.equal(nextOf(next('https://api.github.com/repos/acme/hive/issues?page=2'), PATH), 'repos/acme/hive/issues?page=2');
  assert.equal(nextOf(next('https://api.github.com/repositories/1/issues?page=2'), PATH), 'repositories/1/issues?page=2');
  assert.equal(nextOf(next('https://api.github.com/repositories/1/issues?page=3'), 'repositories/1/issues?page=2'), 'repositories/1/issues?page=3');
  const rejected = [
    ['https://example.com/repos/acme/hive/issues?page=2', PATH],
    ['https://api.github.com/repos/acme/other/issues?page=2', PATH],
    ['https://api.github.com/repositories/2/issues?page=3', 'repositories/1/issues?page=2'],
    ['https://api.github.com/user/issues?page=2', PATH],
  ] as const;
  for (const [url, from] of rejected) assert.throws(() => nextOf(next(url), from), { message: OUTSIDE }, url);
});
