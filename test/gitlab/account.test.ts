import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeGitlabCredential, saveGitlabCredential } from '../../src/credentials.js';
import { gitlabAccess, verifyGitlabToken } from '../../src/gitlab/account.js';
import { SourceNotConnectedError } from '../../src/source-errors.js';
import { tempDir } from '../temp-dir.js';

const HOST = 'git.example.com';
const TOKEN = `glpat-test-${randomUUID()}`; // built at runtime: no token in a fixture
const NEW_TOKEN = `glpat-test-${randomUUID()}`;
const USER = { id: 1, username: 'ana' };
const SELF = { id: 9, scopes: ['read_user', 'api'], expires_at: '2027-01-31', active: true };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { url: string; authorization?: string }
/** A fetch answering by API path (`user`, `personal_access_tokens/self`), recording each call's URL and bearer. */
function fakeGitlab(answers: Record<string, () => Response>): { doFetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), authorization: (init.headers as Record<string, string> | undefined)?.Authorization });
    const answer = answers[String(url).replace(`https://${HOST}/api/v4/`, '')];
    if (answer === undefined) throw new Error(`no answer for ${String(url)}`);
    return answer();
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}
const answering = (user: () => Response, self: () => Response = () => json(200, SELF)) => fakeGitlab({ user, 'personal_access_tokens/self': self });

test('a token with the api scope answers its username and expiry, read from /user and /personal_access_tokens/self with the token as a bearer only (#1048)', async () => {
  const { doFetch, calls } = answering(() => json(200, USER));
  assert.deepEqual(await verifyGitlabToken(HOST, TOKEN, doFetch), { username: 'ana', expiresAt: '2027-01-31' });
  assert.deepEqual(calls, [
    { url: `https://${HOST}/api/v4/user`, authorization: `Bearer ${TOKEN}` },
    { url: `https://${HOST}/api/v4/personal_access_tokens/self`, authorization: `Bearer ${TOKEN}` },
  ]);
});

test('a token that never expires answers no expiresAt; an expires_at that is no date is dropped, not stored (#1048)', async () => {
  assert.deepEqual(await verifyGitlabToken(HOST, TOKEN, answering(() => json(200, USER), () => json(200, { ...SELF, expires_at: null })).doFetch), { username: 'ana' });
  assert.deepEqual(await verifyGitlabToken(HOST, TOKEN, answering(() => json(200, USER), () => json(200, { ...SELF, expires_at: 'soon' })).doFetch), { username: 'ana' });
});

test('GitLab\'s 401 is refused, a token without api is scope, a 404 on /self is unverifiable, and anything else is unreachable; no verdict holds the token (#1048)', async () => {
  const cases: [string, ReturnType<typeof answering>, string][] = [
    ['401 on /user', answering(() => json(401, { message: '401 Unauthorized' })), 'refused'],
    ['401 on /self', answering(() => json(200, USER), () => json(401, {})), 'refused'],
    ['no api scope', answering(() => json(200, USER), () => json(200, { ...SELF, scopes: ['read_api', 'read_user'] })), 'scope'],
    ['404 on /self', answering(() => json(200, USER), () => json(404, { message: '404 Not Found' })), 'unverifiable'],
    ['404 on /user', answering(() => json(404, {})), 'unreachable'],
    ['a 5xx', answering(() => json(503, {})), 'unreachable'],
    ['a 429', answering(() => json(429, {})), 'unreachable'],
    ['a network error', answering(() => { throw new TypeError('fetch failed'); }), 'unreachable'],
    ['a username that is no string', answering(() => json(200, { id: 1, username: 7 })), 'unreachable'],
    ['scopes that are no list', answering(() => json(200, USER), () => json(200, { ...SELF, scopes: 'api' })), 'unreachable'],
  ];
  for (const [name, { doFetch }, error] of cases) {
    const verdict = await verifyGitlabToken(HOST, TOKEN, doFetch);
    assert.deepEqual(verdict, { error }, name);
    assert.ok(!JSON.stringify(verdict).includes(TOKEN), name);
  }
});

test('gitlabAccess answers undefined for a host with no account; its client reads the stored token at every call, a reconnect included, and after a remove it throws not connected, naming no token (#1048)', async (t) => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'gitlab-access-') };
  const { doFetch, calls } = answering(() => json(200, USER));
  assert.equal(await gitlabAccess(HOST, env, doFetch), undefined);
  await saveGitlabCredential(HOST, { token: TOKEN, username: 'ana' }, env);
  assert.equal(await gitlabAccess('gitlab.com', env, doFetch), undefined, 'another host');
  const api = await gitlabAccess(HOST, env, doFetch);
  assert.ok(api);
  await api.get('user');
  await saveGitlabCredential(HOST, { token: NEW_TOKEN, username: 'ana' }, env);
  await api.get('user');
  assert.deepEqual(calls.map((call) => call.authorization), [`Bearer ${TOKEN}`, `Bearer ${NEW_TOKEN}`], 'no restart needed');
  assert.equal(await removeGitlabCredential(HOST, env), true);
  const err = await api.get('user').then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof SourceNotConnectedError, String(err));
  assert.ok(!err.message.includes(TOKEN) && !err.message.includes(NEW_TOKEN));
  assert.equal(calls.length, 2, 'no call without a token');
});
