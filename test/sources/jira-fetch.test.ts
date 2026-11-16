import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiraFetch } from '../../src/sources/jira-fetch.js';
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
