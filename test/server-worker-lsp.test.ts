import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { localActivityId } from '../src/activities.js';
import { editorDir } from '../src/editor-install.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { RecordInput } from '../src/facts.js';
import type { OpenResult, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { pluginRenderPath } from '../src/plugin-render.js';
import { workerLspPath } from '../src/worker-lsp.js';
import { AUTH, GITHUB_ENTRY, STAGES, WORKSPACE, fakeFacts, fakeSourceFactory, fakeSpawn, type FakeWorker, launchFlag, tempHive, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// The workers' language servers through the server (#803): the plugin written on boot, on a save and on an install's end, and every claude
// launch of the workspace carrying it. One worker and one stage (fila).
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS,
  shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep',
  closeSessionTabNotice: true, closeStageTabNotice: true, closeTerminalTab: 'keep', closeTerminalTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true,
  defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const LOCAL = encodeURIComponent(localActivityId(WORKSPACE));

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i += 1) await sleep(5);
  assert.ok(await check(), 'condition not met in time');
}

// gopls's install record: all the worker's launch of a binary server reads (hiveLaunch), so no runtime on the machine's PATH is needed
async function installGopls(home: string): Promise<void> {
  const dir = editorDir(home, { kind: 'server', id: 'gopls' });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'installed.json'), JSON.stringify({ version: '0.20.0', installedAt: '2026-10-09T00:00:00.000Z' }));
}

interface Started { base: string; server: HiveServer; workers: FakeWorker[]; home: string; repo: string; records: RecordInput[] }

async function start(t: TestContext): Promise<Started> {
  const { home, repo } = await tempHive(t, 1); // one worker: the fake source's task starts
  await installGopls(home);
  const { spawn, workers } = fakeSpawn();
  const { facts, records } = fakeFacts();
  const server = createServer({ secret: SECRET, home, facts, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  return { base, server, workers, home, repo, records };
}

const launchOf = (workers: FakeWorker[], ptyId: string | undefined) => workers.find((w) => w.launch.ptyId === ptyId)?.launch;

test('every claude run in the workspace gets its plugin as a second --plugin-dir: the stage run, a local session and a terminal\'s claude; a terminal\'s shell gets none (#803)', async (t) => {
  const { base, server, workers, home, records } = await start(t);
  const dir = workerLspPath(home, WORKSPACE);
  assert.ok((JSON.parse(await readFile(join(dir, '.lsp.json'), 'utf8')) as Record<string, unknown>).gopls, 'the boot wrote the plugin before any run');
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  assert.equal(launchFlag(workers[0]?.launch, '--plugin-dir', 1), dir, 'the stage run');
  const session = (await (await postJson(`${base}/activities/${LOCAL}/sessions`)).json()) as OpenResult;
  assert.equal(launchFlag(launchOf(workers, session.ptyId), '--plugin-dir', 1), dir, 'a local session');
  const shell = (await (await postJson(`${base}/activities/${LOCAL}/shell`)).json()) as OpenResult;
  assert.equal(launchFlag(launchOf(workers, shell.ptyId), '--plugin-dir', 1), undefined, 'a shell runs no claude');
  const [, ...argv] = (await (await hiveFetch(`${base}/hooks/terminals/${shell.ptyId}/session`, { method: 'POST', body: new URLSearchParams({ agent: 'claude' }) })).text()).split('\n');
  assert.deepEqual(argv.slice(4, 8), ['--plugin-dir', pluginRenderPath(home, WORKSPACE), '--plugin-dir', dir], 'a terminal\'s claude: its workspace\'s plugin folder (#316), then the language servers');
  const spawned = records.filter((r) => r.event === 'run.spawned').at(-1) as Record<string, unknown> | undefined;
  assert.deepEqual(spawned?.lsp_servers, ['gopls'], 'a local session\'s run.spawned, through its activity\'s workspace');
});

test('a Settings save that takes the server out of the workspace deletes its plugin before it answers; one that puts it back writes it; removing the server deletes it again (#803)', async (t) => {
  const { base, home, repo } = await start(t);
  const dir = workerLspPath(home, WORKSPACE);
  assert.equal(await exists(dir), true);
  const out = { ...BODY, workspaces: workspacesAt(repo), editor: { ...BODY.editor, languages: { go: { server: { workspaces: [] } } } } };
  assert.equal((await postJson(`${base}/settings`, out)).status, 200);
  assert.equal(await exists(dir), false, 'out of scope');
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  assert.equal(await exists(dir), true, 'back in scope');
  assert.equal((await postJson(`${base}/settings/editor/installs/server/gopls`, { action: 'remove' })).status, 200);
  await waitFor(async () => !(await exists(dir))); // the install's settled state (absent) rewrites the plugins
});
