import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../../src/orchestrator.js';
import { createServer, type HiveServer, type ServerDeps } from '../../src/server.js';
import { saveState } from '../../src/state-store.js';
import type { Task, Exec, SettingsBody } from '../../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from '../fakes.js';
import { hiveFetch, SECRET } from '../secret-client.js';
import { ignoredEntry, ordinary, renamed, statusText, untracked } from './porcelain-v2.js';
import { savedTasks, type WithWork } from './work.js';

// The tree routes' test server (#502): local tasks saved in state.json, with git faked
const LISTED = ['a.txt', 'src/b.ts', 'gone.txt', 'new.txt', 'vendor/lib/', ''].join('\0');
// git's --directory listing (#818): an empty folder, a folder a listed file sits under, and the nested repository LISTED names too
const DIRS = ['empty/', 'src/', 'vendor/lib/', ''].join('\0');
// the vendor/lib nested repository the --directory listing names (it holds .git) joins the ignored folders
export const IGNORED_ENTRIES = { files: ['debug.log'], folders: ['docs', 'node_modules', 'vendor/lib'] };
// a nested repository's git status (#1), its paths relative to that repository
const NESTED_STATUS = statusText(ordinary('.M', 'agent/foo.md'), ignoredEntry('agent/x.log'));
// the tree's one status run (#502): marks, the deleted path, a rename, and what git ignores (HIVE-22), a .git the guard drops; no branch line
const STATUS = statusText(ordinary('.M', 'src/b.ts'), ordinary('.D', 'gone.txt'), untracked('new.txt'), renamed('R.', 'moved.ts', 'old.ts'), ignoredEntry('debug.log'), ignoredEntry('node_modules/'), ignoredEntry('docs/'), ignoredEntry('.git/'));
export const task = (n: number, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...extra,
});
// The slug a saved activity carries (#629): the one the worktree paths below name
const SLUG_OF = (c: Task): string => `hive-${c.item.id.replace('HIVE-', '')}-task`;
export const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });

export async function startTree(t: TestContext, tasks: (repo: string) => WithWork[], extra: Partial<ServerDeps> = {}): Promise<{ base: string; repo: string; calls: [string, string[]][]; server: HiveServer }> {
  const { home, repo } = await tempHive(t);
  const saved = tasks(repo);
  for (const c of saved) if (c.worktree !== undefined && !c.worktreeGone) await mkdir(join(c.worktree, 'vendor/lib/.git'), { recursive: true }); // the nested repository (#818)
  await mkdir(join(repo, 'vendor/lib/.git'), { recursive: true });
  await saveState(home, savedTasks({ ...initialState(0), localCount: saved.length }, saved, SLUG_OF)); // #629: each worktree on its activity
  const calls: [string, string[]][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    if (args.includes('--ignored=matching')) {
      if (args[2].endsWith('broken')) throw new Error('fatal: not a git repository');
      return { stdout: NESTED_STATUS };
    }
    if (args.includes('--directory')) return { stdout: DIRS };
    if (args.includes('ls-files')) return { stdout: LISTED };
    return { stdout: args.includes('status') ? STATUS : '' };
  };
  const server = createServer({ secret: SECRET, home, exec, ...extra });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [] };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  calls.length = 0;
  return { base, repo, calls, server };
}
