import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghRest } from '../../src/read-model/rest.js';

const RESET = 1_791_234_567;
const QUOTA_HEADERS = ['X-Ratelimit-Limit: 5000', 'X-Ratelimit-Remaining: 4990', 'X-Ratelimit-Used: 10', `X-Ratelimit-Reset: ${RESET}`];
const QUOTA = { limit: 5000, remaining: 4990, used: 10, resetsAt: new Date(RESET * 1000).toISOString() };
const http = (status: string, headers: string[], body = ''): string => [`HTTP/2.0 ${status}`, ...headers, '', body].join('\r\n');

test('ghRest sends the ETag as If-None-Match and reads a 200: its JSON, its ETag, the next page and the quota (#765)', async () => {
  const calls: string[][] = [];
  const link = 'Link: <https://api.github.com/repositories/1/issues?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=3>; rel="last"';
  const rest = ghRest(async (args) => { calls.push(args); return http('200 OK', ['Etag: W/"abc"', link, ...QUOTA_HEADERS], '[{"node_id":"I_1"}]'); });
  const answer = await rest('repos/acme/hive/issues?per_page=100', 'W/"old"');
  assert.deepEqual(calls, [['api', '-i', '-H', 'If-None-Match: W/"old"', 'repos/acme/hive/issues?per_page=100']]);
  assert.deepEqual(answer, { status: 200, body: [{ node_id: 'I_1' }], etag: 'W/"abc"', next: 'repositories/1/issues?per_page=100&page=2', quota: QUOTA });
});

test('a 304 and a 404 carry no body; with no ETag no header is sent; a Link off api.github.com is not followed (#765)', async () => {
  const calls: string[][] = [];
  const answers = [http('304 Not Modified', QUOTA_HEADERS), http('404 Not Found', []), http('200 OK', ['Link: <https://example.com/x?page=2>; rel="next"'], '[]')];
  const rest = ghRest(async (args) => { calls.push(args); return answers[calls.length - 1]; });
  assert.deepEqual(await rest('p1', 'W/"e"'), { status: 304, quota: QUOTA });
  assert.deepEqual(await rest('p2'), { status: 404 });
  assert.deepEqual(await rest('p3'), { status: 200, body: [] });
  assert.deepEqual(calls[1], ['api', '-i', 'p2']);
});

test('gh prints the status line with a bare newline and the headers with CRLF; both parse (#765)', async () => {
  const raw = 'HTTP/2.0 304 Not Modified\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4990\r\nX-Ratelimit-Used: 10\r\nX-Ratelimit-Reset: 1791234567\r\n\r\n';
  assert.deepEqual(await ghRest(async () => raw)('p'), { status: 304, quota: QUOTA });
});

test('an unexpected status, a body that is no JSON and output with no status line throw without quoting the body (#765)', async () => {
  await assert.rejects(ghRest(async () => http('500 Internal Server Error', [], 'body text'))('p'), { message: 'github rest: HTTP 500' });
  await assert.rejects(ghRest(async () => http('200 OK', [], 'not json'))('p'), { message: 'github rest: invalid JSON body' });
  await assert.rejects(ghRest(async () => 'garbage')('p'), { message: 'github rest: no HTTP status line' });
});
