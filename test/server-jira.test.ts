import { mkdir } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { credentialsPath, jiraCredential, readCredentials, saveJiraCredential } from '../src/credentials.js';
import { createServer } from '../src/server.js';
import { JIRA_LOGIN_MESSAGE, JIRA_SAVE_MESSAGE, normalizeJiraSite, registerJiraRoutes } from '../src/server-jira.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
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
    ['empty accountId', () => json({ accountId: '', displayName: 'Ana' })],
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

const list = (h: Harness): Promise<[number, unknown]> => answered(fetch(`${h.base}/settings/jira/sites`));
const remove = (h: Harness, site: string): Promise<Response> => fetch(`${h.base}/settings/jira/sites/${encodeURIComponent(site)}`, { method: 'DELETE' });
const stored = { email: EMAIL, token: TOKEN, accountId: 'acc-x' };

test('the listing answers every stored site sorted, each with its own state, even when the others fail (#817)', async (t) => {
  const h = await routes(t, (url) => (url.includes('//ok.') ? json({ accountId: 'acc-ok' }) : url.includes('//gone.') ? json({}, 401) : json({}, 500)));
  assert.deepEqual(await list(h), [200, []], 'nothing stored, nothing listed');
  for (const site of ['ok.atlassian.net', 'gone.atlassian.net', 'down.atlassian.net']) await saveJiraCredential(site, stored, h.env);
  assert.deepEqual(await list(h), [200, [
    { site: 'down.atlassian.net', state: 'unreachable' },
    { site: 'gone.atlassian.net', state: 'refused' },
    { site: 'ok.atlassian.net', state: 'connected', name: 'acc-ok' }, // no displayName: the account id, never the stored email
  ]]);
  assert.ok(h.calls.every((c) => c.auth === BASIC), 'each site checked with its own stored login');
});

test('disconnect removes the site\'s login and the listing no longer has it; a site with no login is a 204 too (#817)', async (t) => {
  const h = await routes(t, () => json(ME));
  await saveJiraCredential(SITE, stored, h.env);
  await saveJiraCredential('other.atlassian.net', stored, h.env);
  assert.equal((await remove(h, SITE)).status, 204);
  assert.equal(await jiraCredential(SITE, h.env), undefined);
  assert.deepEqual(await list(h), [200, [{ site: 'other.atlassian.net', state: 'connected', name: 'Ana' }]]);
  assert.equal((await remove(h, SITE)).status, 204);
});

test('no answer and no log line holds the email or the token (#817)', async (t) => {
  const bodies: string[] = [];
  const keep = async (res: Promise<Response>): Promise<void> => { bodies.push(await (await res).text()); };
  for (const answer of [() => json(ME), () => json({}, 401), () => json({ secret: TOKEN }, 500)] as Answer[]) {
    const h = await routes(t, answer);
    await keep(connect(h, { site: SITE, email: EMAIL, token: TOKEN }));
    await saveJiraCredential(SITE, stored, h.env);
    await keep(fetch(`${h.base}/settings/jira/sites`));
    await keep(remove(h, SITE));
    for (const text of [...bodies, ...h.lines]) assert.ok(!text.includes(EMAIL) && !text.includes(TOKEN), text);
  }
});

test('a login that cannot be written answers 500 and logs the site, never the login (#817)', async (t) => {
  const h = await routes(t, () => json(ME));
  await mkdir(credentialsPath(h.env), { recursive: true }); // the rename onto a directory fails
  assert.deepEqual(await answered(connect(h, { site: SITE, email: EMAIL, token: TOKEN })), [500, { error: JIRA_SAVE_MESSAGE }]);
  assert.ok(h.lines.some((l) => l.startsWith(`ERROR jira site ${SITE} not saved: `)), h.lines.join('\n'));
  assert.ok(!h.lines.some((l) => l.includes(EMAIL) || l.includes(TOKEN)));
});

test('in setup mode the daemon answers GET /settings/jira/sites, and a DELETE needs x-hive-ui like every dashboard write (#817)', async (t) => {
  const home = await tempDir(t, 'jira-home-');
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'jira-cfg-') };
  const { log } = fakeLog();
  const server = createServer({ home, log, secret: SECRET, credentialsEnv: env });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${port}/settings/jira/sites`;
  await saveJiraCredential(SITE, { email: EMAIL, token: TOKEN, accountId: 'acc-1' }, env);
  assert.equal((await hiveFetch(`${url}/${SITE}`, { method: 'DELETE' })).status, 403);
  assert.ok(await jiraCredential(SITE, env), 'refused by the gate, nothing removed');
  assert.equal((await hiveFetch(`${url}/${SITE}`, { method: 'DELETE', headers: { 'x-hive-ui': '1' } })).status, 204);
  const res = await hiveFetch(url); // nothing stored any more, so no call leaves for a real Jira
  assert.deepEqual([res.status, await res.json()], [200, []]);
});
