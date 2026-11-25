import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitlabHttpError, gitlabApi, listAll, projectPath } from '../../src/gitlab/api.js';
import { SourceNotConnectedError, SourceRateLimitError } from '../../src/source-errors.js';

const HOST = 'gitlab.example.test';
const NOW = Date.parse('2026-05-01T12:00:00.000Z');
const TOKEN = `glpat-test-${randomUUID()}`; // built at runtime: no token in a fixture
const RESET = 1_791_234_567;
const QUOTA_HEADERS = { 'RateLimit-Limit': '600', 'RateLimit-Remaining': '590', 'RateLimit-Reset': String(RESET) };
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
const apiOver = (doFetch: typeof fetch, token = TOKEN) => gitlabApi({ host: HOST, token: async () => token, fetch: doFetch, now: () => NOW });
const refusing = async (run: Promise<unknown>): Promise<Error> => {
  const err = await run.then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof Error, 'it threw');
  assert.ok(!err.message.includes(TOKEN), 'the message holds no token');
  return err;
};

test('get sends the token as a bearer header only, to the given host\'s API root, with no redirect and a timeout', async () => {
  const { doFetch, calls } = fakeFetch(respond(200, QUOTA_HEADERS, '[{"iid":1}]'));
  const answer = await apiOver(doFetch).get('projects/7/merge_requests?state=opened');
  assert.deepEqual(answer.body, [{ iid: 1 }]);
  assert.equal(calls[0]?.url, `https://${HOST}/api/v4/projects/7/merge_requests?state=opened`);
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!calls[0]?.url.includes(TOKEN), 'never in the URL');
  assert.equal(calls[0]?.init.method, 'GET');
  assert.equal(calls[0]?.init.redirect, 'manual');
  assert.ok(calls[0]?.init.signal, 'a timeout, not an open-ended call');
  assert.equal(Object.keys(calls[0]?.headers ?? {}).some((name) => name.toLowerCase() === 'if-none-match'), false, 'a 304 counts against GitLab\'s limit too');
});

test('post and put send their JSON body with its content type, delete sends none, and an empty 204 answers undefined', async () => {
  const { doFetch, calls } = fakeFetch(respond(201, {}, '{"id":9}'), respond(200, {}, '{"id":9}'), respond(204));
  const api = apiOver(doFetch);
  assert.deepEqual((await api.post('projects/7/merge_requests', { title: 'x' })).body, { id: 9 });
  await api.put('projects/7/merge_requests/1', { title: 'y' });
  const gone = await api.delete('projects/7/merge_requests/1/notes/2');
  assert.equal(gone.body, undefined);
  assert.deepEqual(calls.map((call) => call.init.method), ['POST', 'PUT', 'DELETE']);
  assert.equal(calls[0]?.init.body, '{"title":"x"}');
  assert.equal(calls[1]?.init.body, '{"title":"y"}');
  assert.equal(calls[0]?.headers['Content-Type'], 'application/json');
  assert.equal(calls[2]?.init.body, undefined);
  assert.equal(calls[2]?.headers['Content-Type'], undefined);
});

test('projectPath encodes group/subgroup/project as one path segment', () => {
  assert.equal(projectPath('group/sub/project'), 'group%2Fsub%2Fproject');
  assert.equal(projectPath('solo'), 'solo');
});

test('a nested project path reaches the API as one encoded segment', async () => {
  const { doFetch, calls } = fakeFetch(respond(200, {}, '{}'));
  await apiOver(doFetch).get(`projects/${projectPath('group/subgroup/project')}`);
  assert.equal(calls[0]?.url, `https://${HOST}/api/v4/projects/group%2Fsubgroup%2Fproject`);
});

test('RateLimit-* headers become the quota, with the reset as an ISO time and `at` as now; any one missing or not a number gives none', async () => {
  const { doFetch } = fakeFetch(
    respond(200, QUOTA_HEADERS, '[]'),
    respond(200, {}, '[]'),
    respond(200, { 'RateLimit-Limit': '600', 'RateLimit-Remaining': '590' }, '[]'),
    respond(200, { ...QUOTA_HEADERS, 'RateLimit-Remaining': 'many' }, '[]'),
  );
  const api = apiOver(doFetch);
  assert.deepEqual((await api.get('a')).quota, { limit: 600, remaining: 590, resetsAt: new Date(RESET * 1000).toISOString(), at: new Date(NOW).toISOString() });
  assert.equal((await api.get('a')).quota, undefined, 'absent is not a spent quota');
  assert.equal((await api.get('a')).quota, undefined, 'no reset');
  assert.equal((await api.get('a')).quota, undefined, 'not a number');
});

test('the Link\'s next page on the same host and API root is the answer\'s next, as an API path', async () => {
  const link = `${next(`https://${HOST}/api/v4/projects/7/merge_requests?page=2&per_page=100`)}, <https://${HOST}/api/v4/projects/7/merge_requests?page=9>; rel="last"`;
  const { doFetch } = fakeFetch(respond(200, { Link: link }, '[]'), respond(200, {}, '[]'));
  const api = apiOver(doFetch);
  assert.equal((await api.get('projects/7/merge_requests')).next, 'projects/7/merge_requests?page=2&per_page=100');
  assert.equal((await api.get('projects/7/merge_requests?page=9')).next, undefined, 'no Link, last page');
});

test('a next page on another host, scheme, port or outside /api/v4 throws, never ends the listing', async () => {
  const outside = `gitlab api: next page outside ${HOST}'s API`;
  const urls = [
    'https://evil.example.test/api/v4/projects/7/merge_requests?page=2',
    `http://${HOST}/api/v4/projects/7/merge_requests?page=2`,
    `https://${HOST}:8443/api/v4/projects/7/merge_requests?page=2`,
    `https://${HOST}/projects/7/merge_requests?page=2`,
    `https://${HOST}/api/v40/projects?page=2`,
    `https://${HOST}.evil.example.test/api/v4/projects?page=2`,
    'not a url',
  ];
  for (const url of urls) {
    const { doFetch } = fakeFetch(respond(200, { Link: next(url) }, '[]'));
    const err = await refusing(apiOver(doFetch).get('projects/7/merge_requests'));
    assert.equal(err.message, outside, url);
  }
});

test('listAll follows next across pages and joins them', async () => {
  const { doFetch, calls } = fakeFetch(
    respond(200, { Link: next(`https://${HOST}/api/v4/projects?page=2`) }, '[1,2]'),
    respond(200, {}, '[3]'),
  );
  assert.deepEqual(await listAll(apiOver(doFetch), 'projects'), [1, 2, 3]);
  assert.deepEqual(calls.map((call) => call.url), [`https://${HOST}/api/v4/projects`, `https://${HOST}/api/v4/projects?page=2`]);
});

test('listAll throws on a page that is not a list', async () => {
  const { doFetch } = fakeFetch(respond(200, {}, '{"message":"x"}'));
  await assert.rejects(listAll(apiOver(doFetch), 'projects'), /gitlab api: expected a list/);
});

test('a 401 is a SourceNotConnectedError naming the host and telling to connect again in Settings, with no token', async () => {
  const { doFetch } = fakeFetch(respond(401, {}, `{"message":"bad ${TOKEN}"}`));
  const err = await refusing(apiOver(doFetch).get('user'));
  assert.ok(err instanceof SourceNotConnectedError);
  assert.match(err.message, new RegExp(HOST.replaceAll('.', '\\.')));
  assert.match(err.message, /connect it again in Settings/);
});

test('a 429 is a SourceRateLimitError at now plus Retry-After seconds, or its HTTP date; absent or invalid waits a minute', async () => {
  const date = new Date(NOW + 90_000).toUTCString();
  const { doFetch } = fakeFetch(
    respond(429, { 'Retry-After': '30' }, 'slow down'),
    respond(429, { 'Retry-After': date }, ''),
    respond(429, {}, ''),
    respond(429, { 'Retry-After': 'soon' }, ''),
  );
  const api = apiOver(doFetch);
  const retryAts: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const err = await refusing(api.get('user'));
    assert.ok(err instanceof SourceRateLimitError);
    retryAts.push(err.retryAt);
  }
  const at = (ms: number): string => new Date(NOW + ms).toISOString();
  assert.deepEqual(retryAts, [at(30_000), at(90_000), at(60_000), at(60_000)]);
});

test('any other non-2xx throws a GitlabHttpError carrying the status, a redirect included, without the body', async () => {
  const { doFetch } = fakeFetch(respond(404, {}, `{"message":"${TOKEN}"}`), respond(302, { Location: 'https://elsewhere.example.test/' }), respond(500));
  const api = apiOver(doFetch);
  const notFound = await refusing(api.get('projects/0'));
  assert.ok(notFound instanceof GitlabHttpError);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, 'gitlab api: HTTP 404');
  assert.equal(((await refusing(api.get('x'))) as GitlabHttpError).status, 302, 'a redirect is never followed');
  assert.equal(((await refusing(api.get('x'))) as GitlabHttpError).status, 500);
});

test('a body that is not JSON throws without quoting it', async () => {
  const { doFetch } = fakeFetch(respond(200, {}, `<html>${TOKEN}</html>`));
  const err = await refusing(apiOver(doFetch).get('user'));
  assert.equal(err.message, 'gitlab api: invalid JSON body');
});

test('graphql posts the query and variables to /api/graphql and answers its JSON', async () => {
  const { doFetch, calls } = fakeFetch(respond(200, QUOTA_HEADERS, '{"data":{"currentUser":{"id":"gid://gitlab/User/1"}}}'));
  const answer = await apiOver(doFetch).graphql('query($a:Int){x}', { a: 1 });
  assert.deepEqual(answer.body, { data: { currentUser: { id: 'gid://gitlab/User/1' } } });
  assert.equal(answer.quota?.limit, 600);
  assert.equal(calls[0]?.url, `https://${HOST}/api/graphql`);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { query: 'query($a:Int){x}', variables: { a: 1 } });
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${TOKEN}`);
});

test('a graphql answer with errors throws the first message, scrubbed of the token', async () => {
  const body = JSON.stringify({ errors: [{ message: `Field x is missing, sent ${TOKEN}` }, { message: 'second' }] });
  const { doFetch } = fakeFetch(respond(200, {}, body), respond(200, {}, '{"errors":[]}'));
  const api = apiOver(doFetch);
  const err = await refusing(api.graphql('q', {}));
  assert.match(err.message, /^gitlab graphql: Field x is missing/);
  assert.deepEqual((await api.graphql('q', {})).body, { errors: [] }, 'an empty errors list is no error');
});

test('a malformed token throws before any call and never quotes it; so does a host that is not a bare name', async () => {
  const { doFetch, calls } = fakeFetch();
  for (const bad of [`${TOKEN}\n`, `${TOKEN} x`, '']) {
    const err = await refusing(apiOver(doFetch, bad).get('user'));
    assert.equal(err.message, 'gitlab: malformed token');
  }
  assert.equal(calls.length, 0);
  for (const host of ['', 'a/b', 'https://gitlab.example.test', 'u@host', 'a b', 'GitLab.example.test', 'gitlab.example.test:443']) {
    assert.throws(() => gitlabApi({ host, token: async () => TOKEN, fetch: doFetch }), /gitlab: invalid host/, host);
  }
});

test('no error message holds the token, whatever the failure', async () => {
  const body = JSON.stringify({ errors: [{ message: TOKEN }] });
  const { doFetch } = fakeFetch(respond(401, {}, TOKEN), respond(429, { 'Retry-After': TOKEN }, TOKEN), respond(500, {}, TOKEN), respond(200, {}, TOKEN), respond(200, {}, body));
  const api = apiOver(doFetch);
  // one at a time: the fake answers in call order. refusing asserts each message is clean
  for (const run of [() => api.get('a'), () => api.get('a'), () => api.get('a'), () => api.get('a'), () => api.graphql('q', {})]) await refusing(run());
});

test('listAll throws past its page ceiling rather than loop on a Link that points back at itself', async () => {
  const api = { get: async () => ({ body: [1], next: 'projects?page=1' }) };
  await assert.rejects(listAll(api, 'projects?page=1'), /gitlab api: more than \d+ pages/);
});

test('an empty RateLimit-* header counts as absent, not as a spent quota', async () => {
  const { doFetch } = fakeFetch(respond(200, { ...QUOTA_HEADERS, 'RateLimit-Remaining': '' }, '[]'));
  assert.equal((await apiOver(doFetch).get('projects')).quota, undefined);
});

test('a huge Retry-After is capped at a day instead of escaping as a RangeError', async () => {
  const { doFetch } = fakeFetch(respond(429, { 'Retry-After': '99999999999' }));
  const err = await refusing(apiOver(doFetch).get('projects'));
  assert.ok(err instanceof SourceRateLimitError);
  assert.equal(err.retryAt, new Date(NOW + 24 * 60 * 60 * 1000).toISOString());
});

test('a next page outside the API reads the 2xx body before it throws, freeing the connection', async () => {
  const answer = respond(200, { Link: next('https://elsewhere.test/api/v4/projects?page=2') }, '[]');
  const { doFetch } = fakeFetch(answer);
  await refusing(apiOver(doFetch).get('projects'));
  assert.equal(answer.bodyUsed, true);
});
