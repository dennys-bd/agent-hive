import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { saveJiraCredential } from '../src/credentials.js';
import { createServer } from '../src/server.js';
import { jiraColumns, registerJiraSettingsRoutes } from '../src/server-jira-settings.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

const SITE = 'acme.atlassian.net';
const EMAIL = 'ana@example.com';
const TOKEN = 'fake-token-821';
const API = '/rest/api/3';

type Answer = (url: URL) => Response;
interface Harness { base: string; lines: string[]; calls: string[] }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

// A fake Jira: each path from /rest/api/3 on, without its query, answers its bodies in order. A Response goes out as it is, and a path
// with nothing left is a 404
function fakeJira(bodies: Record<string, unknown[]>): Answer {
  const served = new Map<string, number>();
  return (url) => {
    const path = url.pathname.slice(API.length);
    const at = served.get(path) ?? 0;
    served.set(path, at + 1);
    const body = Object.hasOwn(bodies, path) ? bodies[path][at] : undefined;
    return body instanceof Response ? body : body === undefined ? json({ errorMessages: ['not found'] }, 404) : json(body);
  };
}

// The routes alone on express, over a temp config home holding one site's login (unless `login` is false) and a fake Jira whose calls
// land in `calls`, from /rest/api/3 on with their query
async function routes(t: TestContext, answer: Answer, login = true): Promise<Harness> {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'jira-settings-') };
  if (login) await saveJiraCredential(SITE, { email: EMAIL, token: TOKEN, accountId: 'acc-1' }, env);
  const { log, lines } = fakeLog();
  const calls: string[] = [];
  const fake = (async (raw: string) => {
    const url = new URL(raw);
    calls.push(`${url.pathname.slice(API.length)}${url.search}`);
    return answer(url);
  }) as unknown as typeof fetch;
  const deps = { log, env, fetch: fake };
  const app = express();
  registerJiraSettingsRoutes(app, deps);
  app.get('/settings/source-columns', (req, res) => jiraColumns(req, res, deps));
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lines, calls };
}

const SITE_ROUTES = ['/settings/jira/projects', '/settings/jira/link-types'];
const PROJECT_ROUTES = ['/settings/jira/issue-types', '/settings/source-columns']; // Task 7 adds /settings/filter-options
const ALL_ROUTES = (): string[] => [...SITE_ROUTES, ...PROJECT_ROUTES];
const url = (route: string, site = SITE, project = 'ABC'): string =>
  `${route}?type=jira&site=${encodeURIComponent(site)}${PROJECT_ROUTES.includes(route) ? `&project=${encodeURIComponent(project)}` : ''}`;
const get = async (h: Harness, path: string): Promise<[number, unknown]> => { const res = await fetch(`${h.base}${path}`); return [res.status, await res.json()]; };

test('projects pages until isLast and answers each key and name, with the site\'s stored login (#821)', async (t) => {
  const h = await routes(t, fakeJira({ '/project/search': [
    { startAt: 0, isLast: false, values: [{ id: '1', key: 'ABC', name: 'Alpha' }] },
    { startAt: 1, isLast: true, values: [{ id: '2', key: 'XYZ', name: 'Zed' }] },
  ] }));
  assert.deepEqual(await get(h, url('/settings/jira/projects', 'https://Acme.atlassian.net/')), [200, [{ key: 'ABC', name: 'Alpha' }, { key: 'XYZ', name: 'Zed' }]]);
  assert.deepEqual(h.calls, ['/project/search?startAt=0&maxResults=100', '/project/search?startAt=1&maxResults=100']);
});

test('issue-types answers id, name and subtask, and link-types each type with its two phrases (#821)', async (t) => {
  const h = await routes(t, fakeJira({
    '/issue/createmeta/ABC/issuetypes': [{ startAt: 0, total: 2, issueTypes: [{ id: '10001', name: 'Story', subtask: false }, { id: '10002', name: 'Sub-task', subtask: true }] }],
    '/issueLinkType': [{ issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] }],
  }));
  assert.deepEqual(await get(h, url('/settings/jira/issue-types')), [200, [{ id: '10001', name: 'Story', subtask: false }, { id: '10002', name: 'Sub-task', subtask: true }]]);
  assert.deepEqual(await get(h, url('/settings/jira/link-types')), [200, [{ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }]]);
});

test('source-columns?type=jira answers the project\'s status names in Jira\'s order (#821)', async (t) => {
  const todo = { name: 'To Do', statusCategory: { key: 'new' } };
  const h = await routes(t, fakeJira({ '/project/ABC/statuses': [[
    { name: 'Story', statuses: [todo, { name: 'In Progress', statusCategory: { key: 'indeterminate' } }] },
    { name: 'Bug', statuses: [todo, { name: 'Done', statusCategory: { key: 'done' } }] },
  ]] }));
  assert.deepEqual(await get(h, url('/settings/source-columns')), [200, ['To Do', 'In Progress', 'Done']]);
  assert.deepEqual(h.calls, ['/project/ABC/statuses']);
});

test('a site with no stored login answers 409 not-connected on every route and no fetch leaves; a 401 answers 409 too (#821)', async (t) => {
  const none = await routes(t, fakeJira({}), false);
  for (const route of ALL_ROUTES()) assert.deepEqual(await get(none, url(route)), [409, { error: 'not-connected' }], route);
  assert.equal(none.calls.length, 0);
  const refused = await routes(t, () => json({}, 401));
  for (const route of ALL_ROUTES()) assert.deepEqual(await get(refused, url(route)), [409, { error: 'not-connected' }], route);
});

test('a 429 with Retry-After answers 429 with resetsAt (#821)', async (t) => {
  const h = await routes(t, () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
  for (const route of ALL_ROUTES()) {
    const [status, body] = await get(h, url(route));
    const { error, resetsAt } = body as { error: string; resetsAt: string };
    assert.equal(status, 429, route);
    assert.ok(Date.parse(resetsAt) > Date.now(), route);
    assert.equal(error, `rate limited until ${resetsAt}`, route);
  }
});

test('a 500 or an unexpected body answers 502 with the message, never 500, and logs the site, never the login (#821)', async (t) => {
  const failing = await routes(t, () => json({ secret: TOKEN }, 500));
  for (const route of ALL_ROUTES()) assert.deepEqual(await get(failing, url(route)), [502, { error: 'jira api: HTTP 500' }], route);
  assert.ok(failing.lines.some((l) => l.startsWith(`WARN jira settings ${SITE}: `)), failing.lines.join('\n'));
  assert.ok(!failing.lines.some((l) => l.includes(EMAIL) || l.includes(TOKEN)));
  const odd = await routes(t, fakeJira({ '/project/search': [{ values: 'nope' }] }));
  assert.deepEqual(await get(odd, url('/settings/jira/projects')), [502, { error: 'read model: unexpected jira projects' }]);
});

test('an invalid site or project answers 400 naming it, and no fetch leaves (#821)', async (t) => {
  const h = await routes(t, fakeJira({}));
  for (const site of ['acme.atlassian.net/evil', 'u@acme.atlassian.net', 'acme', '']) {
    for (const route of ALL_ROUTES()) assert.deepEqual(await get(h, url(route, site)), [400, { error: 'invalid-site' }], `${route} ${site}`);
  }
  for (const project of ['abc', 'AB-1', '../x', '']) {
    for (const route of PROJECT_ROUTES) assert.deepEqual(await get(h, url(route, SITE, project)), [400, { error: 'invalid-project' }], `${route} ${project}`);
  }
  assert.equal(h.calls.length, 0);
});

test('in setup mode the daemon answers every Jira settings route, 409 with no stored login (#821)', async (t) => {
  const home = await tempDir(t, 'jira-settings-home-');
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'jira-settings-cfg-') };
  const server = createServer({ home, log: fakeLog().log, secret: SECRET, credentialsEnv: env });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  for (const route of ALL_ROUTES()) { // no login, so no call leaves for a real Jira
    const res = await hiveFetch(`http://127.0.0.1:${port}${url(route)}`);
    assert.deepEqual([res.status, await res.json()], [409, { error: 'not-connected' }], route);
  }
});
