import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { jiraCredential, readCredentials, saveJiraCredential } from '../src/credentials.js';
import { JIRA_LOGIN_MESSAGE, normalizeJiraSite, registerJiraRoutes } from '../src/server-jira.js';
import { fakeLog } from './fakes.js';
import { tempDir } from './temp-dir.js';

const SITE = 'acme.atlassian.net';
const EMAIL = 'ana@example.com';
const TOKEN = 'fake-token-817';
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
const ME = { accountId: 'acc-1', displayName: 'Ana' };

type Answer = (url: string) => Response;
interface Call { url: string; auth: string | undefined }
interface Harness { base: string; env: NodeJS.ProcessEnv; lines: string[]; calls: Call[] }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

// The Jira routes alone on express, over a temp config home and a fake Jira whose calls land in `calls`
async function routes(t: TestContext, answer: Answer): Promise<Harness> {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'jira-') };
  const { log, lines } = fakeLog();
  const calls: Call[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.Authorization });
    return answer(url);
  }) as unknown as typeof fetch;
  const app = express();
  app.use(express.json());
  registerJiraRoutes(app, { log, env, fetch: fake });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, env, lines, calls };
}

const connect = (h: Harness, body: unknown): Promise<Response> =>
  fetch(`${h.base}/settings/jira/sites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const answered = async (res: Promise<Response>): Promise<[number, unknown]> => { const done = await res; return [done.status, await done.json()]; };

test('normalizeJiraSite trims, lowercases, drops a leading scheme and a trailing slash, and refuses what is still no bare host (#817)', () => {
  assert.equal(normalizeJiraSite('  https://Acme.atlassian.net/ '), SITE);
  assert.equal(normalizeJiraSite('http://acme.atlassian.net'), SITE);
  assert.equal(normalizeJiraSite(SITE), SITE);
  for (const raw of ['acme.atlassian.net/jira', 'acme.atlassian.net:8443', 'u@acme.atlassian.net', 'ftp://acme.atlassian.net', 'acme', '', 42, undefined]) {
    assert.equal(normalizeJiraSite(raw), undefined, String(raw));
  }
});

test('a connect /myself accepts stores the login under the normalized site and answers connected with the name (#817)', async (t) => {
  const h = await routes(t, () => json(ME));
  assert.deepEqual(await answered(connect(h, { site: 'https://Acme.atlassian.net/', email: EMAIL, token: TOKEN })), [200, { site: SITE, state: 'connected', name: 'Ana' }]);
  assert.deepEqual(h.calls, [{ url: `https://${SITE}/rest/api/3/myself`, auth: BASIC }], 'the candidate login, not a stored one');
  assert.deepEqual(await jiraCredential(SITE, h.env), { email: EMAIL, token: TOKEN, accountId: 'acc-1' });
  assert.ok(h.lines.includes(`INFO jira site connected: ${SITE}`), h.lines.join('\n'));
});

test('a /myself without a displayName names the account by the email typed; an accepted reconnect replaces the old login (#817)', async (t) => {
  const h = await routes(t, () => json({ accountId: 'acc-2' }));
  await saveJiraCredential(SITE, { email: 'old@example.com', token: 'fake-old-token', accountId: 'acc-0' }, h.env);
  assert.deepEqual(await answered(connect(h, { site: SITE, email: EMAIL, token: TOKEN })), [200, { site: SITE, state: 'connected', name: EMAIL }]);
  assert.deepEqual(await jiraCredential(SITE, h.env), { email: EMAIL, token: TOKEN, accountId: 'acc-2' });
});

test('a 401 stores nothing and answers 400 refused; a reconnect refused the same way keeps the old login (#817)', async (t) => {
  const h = await routes(t, () => json({}, 401));
  assert.deepEqual(await answered(connect(h, { site: SITE, email: EMAIL, token: TOKEN })), [400, { error: 'refused' }]);
  assert.deepEqual(await readCredentials(h.env), {});
  const old = { email: 'old@example.com', token: 'fake-old-token', accountId: 'acc-0' };
  await saveJiraCredential(SITE, old, h.env);
  assert.deepEqual(await answered(connect(h, { site: SITE, email: EMAIL, token: TOKEN })), [400, { error: 'refused' }]);
  assert.deepEqual(await jiraCredential(SITE, h.env), old);
  assert.ok(h.lines.includes(`WARN jira connect refused: ${SITE} (refused)`), h.lines.join('\n'));
});

test('a 429, a 500, a network failure or a body without a string accountId or displayName answers 400 unreachable and stores nothing (#817)', async (t) => {
  const cases: [string, Answer][] = [
    ['429', () => json({}, 429)],
    ['500', () => json({}, 500)],
    ['network', () => { throw new TypeError('fetch failed'); }],
    ['no accountId', () => json({ displayName: 'Ana' })],
    ['non-string displayName', () => json({ accountId: 'acc-1', displayName: 7 })],
    ['not an object', () => json('Ana')],
  ];
  for (const [label, answer] of cases) {
    const h = await routes(t, answer);
    assert.deepEqual(await answered(connect(h, { site: SITE, email: EMAIL, token: TOKEN })), [400, { error: 'unreachable' }], label);
    assert.deepEqual(await readCredentials(h.env), {}, label);
  }
});

test('a site that is no host answers 400 invalid-site and a non-string login 400 with its text, both before any fetch (#817)', async (t) => {
  const h = await routes(t, () => json(ME));
  for (const site of ['acme.atlassian.net/evil', 'u@acme.atlassian.net', 42, undefined]) {
    assert.deepEqual(await answered(connect(h, { site, email: EMAIL, token: TOKEN })), [400, { error: 'invalid-site' }], String(site));
  }
  assert.deepEqual(await answered(connect(h, { site: SITE, email: EMAIL })), [400, { error: JIRA_LOGIN_MESSAGE }]);
  assert.deepEqual(await answered(connect(h, { site: SITE, email: 1, token: TOKEN })), [400, { error: JIRA_LOGIN_MESSAGE }]);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await readCredentials(h.env), {});
});
