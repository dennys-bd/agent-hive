import { execFile } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { workspaceProtocolPaths } from '../src/hooks-settings.js';
import { passagesDir } from '../src/passage-store.js';
import { AFTER_MESSAGE, headerKeyMessage, type RenderedPassage } from '../src/protocol-inserts.js';
import { PROTOCOL_BLOCKS, renderProtocol, SESSION_PROTOCOL, STAGE_PROTOCOL } from '../src/protocol.js';
import { createServer } from '../src/server.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from '../src/server-memory.js';
import { TEXT_MESSAGE, UNKNOWN_PASSAGE_MESSAGE } from '../src/server-protocol.js';
import type { SettingsBody, Workspace } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, WORKSPACE, fakeSourceFactory, tempHive, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// The protocol routes (#336), end to end against a configured Hive with two workspaces and no worker
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method, headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const answer = async (res: Promise<Response>): Promise<[number, unknown]> => {
  const done = await res;
  return [done.status, await done.json()];
};

const SITE = 'hive-site';
const SITE_ONLY = '---\nafter: ask\n---\n{% if workspace == "hive-site" %}\nCheck the design questions first.\n{% endif %}\n';
const rendered = (id: string, after: string, text: string): RenderedPassage => ({ id, after, orphan: !(PROTOCOL_BLOCKS as readonly string[]).includes(after), text, errors: [] });
const files = async (home: string, workspace: string): Promise<[string, string]> => {
  const paths = workspaceProtocolPaths(home, workspace);
  return [await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')];
};

async function start(t: TestContext): Promise<{ base: string; home: string }> {
  const { home, repo } = await tempHive(t);
  const other = await tempDir(t, 'site-');
  await promisify(execFile)('git', ['init', '--quiet', other]);
  const site: Workspace = { ...workspacesAt(repo)[0], name: SITE, path: other };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send('POST', `${base}/settings`, { ...BODY, workspaces: [...workspacesAt(repo), site] })).status, 200);
  return { base, home };
}

test('a passage created after ask is in hive-site\'s stage and session files right after the ask block before the POST answers, absent from hive\'s; render answers exactly those files; PUT changes and DELETE removes it, each rewriting the files (#336)', async (t) => {
  const { base, home } = await start(t);
  assert.deepEqual(await answer(send('POST', `${base}/api/protocol/passages`, { text: SITE_ONLY })), [201, { id: 'p1' }]);
  const site = [rendered('p1', 'ask', 'Check the design questions first.')];
  assert.deepEqual(await files(home, SITE), [renderProtocol('stage', [], site), renderProtocol('session', [], site)]);
  assert.deepEqual(await files(home, WORKSPACE), [STAGE_PROTOCOL, SESSION_PROTOCOL], 'its if does not hold for hive: nothing in its place');
  const [stage, session] = await files(home, SITE);
  assert.deepEqual(await answer(hiveFetch(`${base}/api/protocol/render?workspace=${SITE}`)), [200, { stage, session }]);
  assert.deepEqual(await answer(hiveFetch(`${base}/api/protocol/render?workspace=ghost`)), [404, { error: UNKNOWN_WORKSPACE_MESSAGE }]);
  assert.deepEqual(await answer(send('PUT', `${base}/api/protocol/passages/p1`, { text: '---\nafter: intro\n---\nFor all.\n' })), [200, { id: 'p1' }]);
  assert.equal((await files(home, WORKSPACE))[0], renderProtocol('stage', [], [rendered('p1', 'intro', 'For all.')]));
  assert.equal((await send('DELETE', `${base}/api/protocol/passages/p1`)).status, 204);
  assert.deepEqual(await files(home, WORKSPACE), [STAGE_PROTOCOL, SESSION_PROTOCOL]);
});

test('a bad after, a basedOn, a missing text, an unknown id: 400 or 404, nothing written (#336)', async (t) => {
  const { base, home } = await start(t);
  const url = `${base}/api/protocol/passages`;
  assert.deepEqual(await answer(send('POST', url, { text: '---\nafter: nowhere\n---\nx\n' })), [400, { errors: [{ line: 2, message: AFTER_MESSAGE }] }]);
  const credited = '---\nafter: ask\nbasedOn: { name: x, repo: o/r, ref: main, license: MIT, url: https://example.com }\n---\nx\n';
  assert.deepEqual(await answer(send('POST', url, { text: credited })), [400, { errors: [{ line: 3, message: headerKeyMessage('basedOn') }] }]);
  assert.deepEqual(await answer(send('POST', url, {})), [400, { error: TEXT_MESSAGE }]);
  assert.deepEqual(await answer(send('PUT', `${url}/p9`, { text: '---\nafter: ask\n---\nx\n' })), [404, { error: UNKNOWN_PASSAGE_MESSAGE }]);
  assert.deepEqual(await answer(send('DELETE', `${url}/p9`)), [404, { error: UNKNOWN_PASSAGE_MESSAGE }]);
  assert.deepEqual(await answer(hiveFetch(`${base}/api/protocol`)).then(([, body]) => (body as { passages: unknown[] }).passages), []);
  assert.deepEqual(await files(home, WORKSPACE), [STAGE_PROTOCOL, SESSION_PROTOCOL]);
});

test('GET /api/protocol answers the blocks with their tool and off, and each passage with its anchor, orphan and the workspaces where it fails; an orphan lands last, before the memory section (#336)', async (t) => {
  const { base, home } = await start(t);
  // what a Hive update leaves behind: an anchor no block has (the routes refuse one), written by hand
  await send('POST', `${base}/api/protocol/passages`, { text: '---\nafter: done\nvariables:\n  team: { required: true, workspaces: { hive-site: core } }\n---\nAsk {{ team }}.\n' });
  await writeFile(join(passagesDir(home), 'p2.md.liquid'), '---\nafter: gone\n---\nLeft over.\n');
  await send('POST', `${base}/workspaces/${WORKSPACE}/memory`, { kind: 'fact', text: 'pnpm test is the gate' }); // a rewrite, and a memory section
  const [, view] = await answer(hiveFetch(`${base}/api/protocol`));
  const { blocks, passages } = view as { blocks: { id: string; off: boolean; tool?: string }[]; passages: { id: string; after: string; orphan: boolean; errors: Record<string, unknown[]> }[] };
  assert.deepEqual(blocks.map((b) => [b.id, b.off, b.tool]), PROTOCOL_BLOCKS.map((id) => [id, false, id === 'remember' ? 'hive_remember' : undefined]));
  assert.deepEqual(passages.map((p) => [p.id, p.after, p.orphan, Object.keys(p.errors)]), [['p1', 'done', false, [WORKSPACE]], ['p2', 'gone', true, []]]);
  const [stage] = await files(home, WORKSPACE);
  assert.ok(!stage.includes('Ask '), 'p1 fails for hive: left out of its files');
  assert.ok(stage.includes('Left over.\n\n## Workspace memory'), 'the orphan is last, right before the memory section');
  assert.ok((await files(home, SITE))[0].includes('Ask core.'));
});

test('turning hive_remember off drops the remember block from every protocol file, the global ones included; hive_applied off drops the memory section\'s hive_applied line (#336)', async (t) => {
  const { base, home } = await start(t);
  await send('POST', `${base}/workspaces/${WORKSPACE}/memory`, { kind: 'fact', text: 'pnpm test is the gate' });
  for (const tool of ['hive_remember', 'hive_applied']) assert.equal((await send('PUT', `${base}/api/mcp/tools/${tool}`, { on: false })).status, 200);
  const global = [join(home, 'protocol', 'stage.md'), join(home, 'protocol', 'session.md')];
  const texts = [...await files(home, WORKSPACE), ...await files(home, SITE), ...await Promise.all(global.map((p) => readFile(p, 'utf8')))];
  for (const text of texts) assert.equal(text.includes('hive_remember'), false);
  assert.equal((await files(home, WORKSPACE))[0].includes('hive_applied'), false);
  const [, view] = await answer(hiveFetch(`${base}/api/protocol`));
  assert.equal((view as { blocks: { id: string; off: boolean }[] }).blocks.find((b) => b.id === 'remember')?.off, true);
});
