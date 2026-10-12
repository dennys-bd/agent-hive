import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import type { Exec, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeSourceFactory, fakeSpawn, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { join } from 'node:path';
import { openReadModel, READ_MODEL_FILE } from '../src/read-model/db.js';
import { REPO, REPO_ROW } from './read-model/fixtures.js';
import { tempDir } from './temp-dir.js';

// #181: the daemon hands the read model, and the login the sync reads with, to the repository routes
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true,
  defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const postJson = (url: string, body: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body) });

// gh's login is bia and every workspace's origin is acme/hive
const exec: Exec = async (file) => ({ stdout: file === 'gh' ? 'bia\n' : `git@github.com:${REPO}.git\n` });

test('GET /repositories answers from the read model as the login gh names, with no GraphQL call (#181)', async (t: TestContext) => {
  const { db } = await openReadModel(join(await tempDir(t, 'read-model-'), READ_MODEL_FILE)); // the server's close() closes it
  db.setRepo(REPO_ROW);
  const { home, repo } = await tempHive(t);
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec, readModel: db });
  const base = `http://127.0.0.1:${await server.listen(0)}`;
  t.after(() => server.close());
  assert.equal((await postJson(`${base}/settings`, { workspaces: workspacesAt(repo), ...BODY })).status, 200);
  const res = await hiveFetch(`${base}/repositories`, { headers: { 'x-hive-ui': '1' } });
  const body = (await res.json()) as { repository: string; syncedAt: string | null }[];
  assert.equal(res.status, 200);
  assert.deepEqual(body.map((summary) => summary.repository), [REPO]);
});
