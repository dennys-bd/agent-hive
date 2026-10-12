import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghRest, nextOf, parseHttp } from '../../src/read-model/rest.js';

const RESET = 1_791_234_567;
const QUOTA_HEADERS = ['X-Ratelimit-Limit: 5000', 'X-Ratelimit-Remaining: 4990', 'X-Ratelimit-Used: 10', `X-Ratelimit-Reset: ${RESET}`];
const QUOTA = { limit: 5000, remaining: 4990, used: 10, resetsAt: new Date(RESET * 1000).toISOString() };
const PATH = 'repos/acme/hive/issues?per_page=100';
const OUTSIDE = 'github rest: next page outside the repository';
// gh ends the status line in \n and the headers in \r\n (the spike's probe log, #765)
const http = (status: string, headers: string[], body = ''): string => `HTTP/2.0 ${status}\n${[...headers, '', body].join('\r\n')}`;
const next = (url: string): string => `<${url}>; rel="next"`;

test('parseHttp reads a 304 and a 200 with mixed line endings, their status, headers and body (#178)', () => {
  const notModified = parseHttp(http('304 Not Modified', QUOTA_HEADERS));
  assert.deepEqual([notModified.status, notModified.headers.get('x-ratelimit-remaining'), notModified.body], [304, '4990', '']);
  const ok = parseHttp(http('200 OK', ['Etag: W/"abc"'], '[1]'));
  assert.deepEqual([ok.status, ok.headers.get('etag'), ok.body], [200, 'W/"abc"', '[1]']);
});

test('ghRest sends the ETag as If-None-Match and reads a 200: its JSON, its ETag, the next page and the quota (#178)', async () => {
  const calls: string[][] = [];
  const link = `${next('https://api.github.com/repositories/1/issues?per_page=100&page=2')}, <https://api.github.com/repositories/1/issues?page=3>; rel="last"`;
  const rest = ghRest(async (args) => {
    calls.push(args);
    return http('200 OK', ['Etag: W/"abc"', `Link: ${link}`, ...QUOTA_HEADERS], '[{"node_id":"I_1"}]');
  });
  const answer = await rest(PATH, 'W/"old"');
  assert.deepEqual(calls, [['api', '-i', '-H', 'If-None-Match: W/"old"', PATH]]);
  assert.deepEqual(answer, { status: 200, body: [{ node_id: 'I_1' }], etag: 'W/"abc"', next: 'repositories/1/issues?per_page=100&page=2', quota: QUOTA });
});

test('a 304 carries its quota; a 404 is gone; with no ETag no header is sent (#178)', async () => {
  const calls: string[][] = [];
  const answers = [http('304 Not Modified', QUOTA_HEADERS), http('404 Not Found', [])];
  const rest = ghRest(async (args) => {
    calls.push(args);
    return answers[calls.length - 1];
  });
  assert.deepEqual(await rest(PATH, 'W/"e"'), { status: 304, quota: QUOTA });
  assert.deepEqual(await rest('repos/acme/hive/issues/9'), { status: 404 });
  assert.deepEqual(calls[1], ['api', '-i', 'repos/acme/hive/issues/9']);
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

test('an unexpected status, a body that is no JSON and output with no status line throw without quoting the body (#178)', async () => {
  await assert.rejects(ghRest(async () => http('500 Internal Server Error', [], 'body text'))('p'), { message: 'github rest: HTTP 500' });
  await assert.rejects(ghRest(async () => http('200 OK', [], 'not json'))('p'), { message: 'github rest: invalid JSON body' });
  await assert.rejects(ghRest(async () => 'garbage')('p'), { message: 'github rest: no HTTP status line' });
});
