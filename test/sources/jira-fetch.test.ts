import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JiraBadRequestError, JiraHttpError, JiraNotFoundError, jiraFetch } from '../../src/sources/jira-fetch.js';
import { isNotConnected, isRateLimited } from '../../src/source-errors.js';

const SITE = 'acme.atlassian.net';
const CRED = { email: 'ana@example.com', token: 'fake-token-xyz', accountId: 'acc-1' };
const BASIC = Buffer.from(`${CRED.email}:${CRED.token}`).toString('base64');
const NOW = Date.parse('2030-01-01T00:00:00.000Z');

interface Call { url: string; init: RequestInit }

function harness(res: Response | (() => Response), credential: typeof CRED | null = CRED) {
  const calls: Call[] = [];
  const deps = {
    credential: async () => credential ?? undefined,
    now: () => NOW,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return typeof res === 'function' ? res() : res;
    }) as unknown as typeof fetch,
  };
  return { calls, deps };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers });

test('sends the Basic header to the site rest api and answers the parsed JSON', async () => {
  const { calls, deps } = harness(json({ a: 1 }));
  assert.deepEqual(await jiraFetch(SITE, '/myself', { method: 'GET' }, deps), { a: 1 });
  assert.equal(calls[0].url, `https://${SITE}/rest/api/3/myself`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${BASIC}`);
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(calls[0].init.signal);
});

test('a 204 answers undefined', async () => {
  const { deps } = harness(new Response(null, { status: 204 }));
  assert.equal(await jiraFetch(SITE, '/issue/X-1', { method: 'PUT' }, deps), undefined);
});

test('a 429 throws SourceRateLimitError with retryAt from seconds, an HTTP date, or now + 60 s', async () => {
  const retryAtOf = async (headers: Record<string, string>): Promise<string> => {
    const { deps } = harness(json({}, 429, headers));
    const err = await jiraFetch(SITE, '/x', undefined, deps).catch((e: unknown) => e);
    assert.ok(isRateLimited(err));
    return err.retryAt;
  };
  assert.equal(await retryAtOf({ 'Retry-After': '30' }), new Date(NOW + 30_000).toISOString());
  assert.equal(await retryAtOf({ 'Retry-After': 'Tue, 01 Jan 2030 00:05:00 GMT' }), '2030-01-01T00:05:00.000Z');
  assert.equal(await retryAtOf({}), new Date(NOW + 60_000).toISOString());
  assert.equal(await retryAtOf({ 'Retry-After': 'soon' }), new Date(NOW + 60_000).toISOString());
});

test('a zero or past Retry-After waits the default and a huge one is capped at an hour, never losing the rate-limit error', async () => {
  const retryAtOf = async (value: string): Promise<string> => {
    const { deps } = harness(json({}, 429, { 'Retry-After': value }));
    const err = await jiraFetch(SITE, '/x', undefined, deps).catch((e: unknown) => e);
    assert.ok(isRateLimited(err), value);
    return err.retryAt;
  };
  assert.equal(await retryAtOf('0'), new Date(NOW + 60_000).toISOString());
  assert.equal(await retryAtOf('Mon, 31 Dec 2029 23:00:00 GMT'), new Date(NOW + 60_000).toISOString());
  assert.equal(await retryAtOf('99999999999999999999'), new Date(NOW + 3_600_000).toISOString());
  assert.equal(await retryAtOf('31536000'), new Date(NOW + 3_600_000).toISOString());
});

test('a path without a leading slash is refused before any fetch', async () => {
  const { calls, deps } = harness(json({}));
  await assert.rejects(jiraFetch(SITE, 'issue/X-1', undefined, deps), /must start with \//);
  assert.equal(calls.length, 0);
});

test('a 401 and a missing credential throw SourceNotConnectedError; the missing one never calls fetch', async () => {
  const unauthorized = harness(json({}, 401));
  const err = await jiraFetch(SITE, '/x', undefined, unauthorized.deps).catch((e: unknown) => e);
  assert.ok(isNotConnected(err));
  assert.equal(err.source, `jira:${SITE}`);
  const none = harness(json({}), null);
  assert.ok(isNotConnected(await jiraFetch(SITE, '/x', undefined, none.deps).catch((e: unknown) => e)));
  assert.equal(none.calls.length, 0);
});

test('a site that is not a bare lowercase hostname is refused before any fetch', async () => {
  for (const site of ['https://acme.atlassian.net', 'acme.atlassian.net/evil', 'acme.atlassian.net:8443', 'Acme.atlassian.net', 'u@acme.atlassian.net', '']) {
    const { calls, deps } = harness(json({}));
    await assert.rejects(jiraFetch(site, '/x', undefined, deps), /jira site/);
    assert.equal(calls.length, 0, site);
  }
});

test('another status, a bad body and every error keep the token, the header and the body out of the message', async () => {
  const cases = [json({ secret: CRED.token }, 500), new Response(`not json ${CRED.token}`, { status: 200 }), json({}, 401), json({}, 429)];
  for (const res of cases) {
    const err = await jiraFetch(SITE, '/x', undefined, harness(res).deps).catch((e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(CRED.token) && !err.message.includes(BASIC) && !err.message.includes('secret'));
  }
  await assert.rejects(jiraFetch(SITE, '/x', undefined, harness(json({}, 503)).deps), { message: 'jira api: HTTP 503' });
  await assert.rejects(jiraFetch(SITE, '/x', undefined, harness(new Response('nope', { status: 200 })).deps), { message: 'jira api: invalid JSON body' });
});

test('a 404 throws JiraNotFoundError, worded as the status and never quoting the body (#820)', async () => {
  const { deps } = harness(json({ errorMessages: ['Issue does not exist'] }, 404));
  await assert.rejects(jiraFetch(SITE, '/issue/10001', {}, deps), (err: unknown) => err instanceof JiraNotFoundError && err.message === 'jira api: HTTP 404');
});

test('another non-ok status throws JiraHttpError with the keys of the body\'s errors, [] when it is not JSON, and never quotes the body (#823)', async () => {
  const body = { errorMessages: [], errors: { issuesInUnlicensedProjects: { count: 1, issueIdsOrKeys: ['ABC-1'], message: `plan ${CRED.token}` } } };
  const refused = await jiraFetch(SITE, '/issue/archive', { method: 'PUT' }, harness(json(body, 400)).deps).catch((e: unknown) => e);
  assert.ok(refused instanceof JiraHttpError);
  assert.deepEqual([refused.status, refused.errorKeys, refused.message], [400, ['issuesInUnlicensedProjects'], 'jira api: HTTP 400']);
  const broken = await jiraFetch(SITE, '/x', undefined, harness(new Response(`oops ${CRED.token}`, { status: 500 })).deps).catch((e: unknown) => e);
  assert.ok(broken instanceof JiraHttpError);
  assert.deepEqual([broken.status, broken.errorKeys, broken.message], [500, [], 'jira api: HTTP 500']);
  const listed = await jiraFetch(SITE, '/x', undefined, harness(json({ errors: ['a'] }, 400)).deps).catch((e: unknown) => e);
  assert.ok(listed instanceof JiraHttpError);
  assert.deepEqual(listed.errorKeys, [], 'an errors array is no errors object');
  for (const err of [refused, broken]) assert.ok(!err.message.includes(CRED.token) && !err.message.includes(BASIC) && !err.message.includes('plan'));
});

test('api agile calls the Agile API under the same site and header (#826)', async () => {
  const { calls, deps } = harness(json({ values: [] }));
  await jiraFetch(SITE, '/board?type=scrum', {}, { ...deps, api: 'agile' });
  assert.equal(calls[0].url, `https://${SITE}/rest/agile/1.0/board?type=scrum`);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Basic ${BASIC}`);
});

test('a 400 throws JiraBadRequestError with Jira\'s errors and errorMessages, named on request; a body with neither keeps the status message (#826)', async () => {
  const body = { errors: { customfield_10020: 'Sprint is closed', priority: 7 }, errorMessages: ['Issue type cannot change'], token: 'x' };
  const err = await jiraFetch(SITE, '/issue/10001', { method: 'PUT' }, harness(json(body, 400)).deps).catch((e: unknown) => e);
  assert.ok(err instanceof JiraBadRequestError);
  assert.ok(err instanceof JiraHttpError, 'the #823 refusals still read it by status and keys');
  assert.deepEqual([err.status, err.errorKeys], [400, ['customfield_10020', 'priority']]);
  assert.equal(err.message, 'customfield_10020: Sprint is closed; Issue type cannot change');
  assert.equal(err.named({ customfield_10020: 'Sprint' }), 'Sprint: Sprint is closed; Issue type cannot change');
  for (const res of [json({}, 400), new Response('not json', { status: 400 }), json({ errors: { a: 1 } }, 400)]) {
    await assert.rejects(jiraFetch(SITE, '/x', {}, harness(res).deps), (e: unknown) => !(e instanceof JiraBadRequestError) && e instanceof JiraHttpError && e.message === 'jira api: HTTP 400');
  }
});

test('a 400 keeps at most 10 parts, each cut to 300 characters (#826)', async () => {
  const errors = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, 'e'.repeat(500)]));
  const body = { errors, errorMessages: ['m1', 'm2', 'm3', 'm4'] };
  const err = await jiraFetch(SITE, '/x', { method: 'PUT' }, harness(json(body, 400)).deps).catch((e: unknown) => e);
  assert.ok(err instanceof JiraBadRequestError);
  const parts = err.message.split('; ');
  assert.equal(parts.length, 10);
  assert.ok(parts.every((p) => p.length <= 300 + 'f0: '.length));
  assert.equal(parts[0], `f0: ${'e'.repeat(300)}`);
  assert.equal(parts[9], 'm2');
});
