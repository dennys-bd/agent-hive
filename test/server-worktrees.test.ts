import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { initialState } from '../src/orchestrator.js';
import { createServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { worktreePath } from '../src/worktree.js';
import type { Task, Exec, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { savedTasks, type WithWork } from './fixtures/work.js';

// GET /activities/worktrees (#586) over a Comb with no source and no worker: its tasks are local ones saved in state.json before the first save.
// git is a fake that answers the merge-base, the commit count and the status, fails in the worktree `broken` names, and records every call.
const MERGE_BASE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const STATUS = [' M src/a.ts', '?? notes.md', 'D  old.txt', ''].join('\n');
const task = (n: number, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...extra,
});
// The slug a saved activity carries (#629): the one the worktree paths below name
const SLUG_OF = (c: Task): string => `hive-${c.item.id.replace('HIVE-', '')}-task`;

interface Rows { base: string; repo: string; calls: string[][] }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const get = (f: Rows): Promise<Response> => hiveFetch(`${f.base}/activities/worktrees`, { headers: { 'x-hive-ui': '1' } });

// Every task with a worktree still on disk gets its directory: the post-poll check marks a missing one gone (#208).
async function startRows(t: TestContext, tasks: (repo: string) => WithWork[], brokenSlug?: string, onCall?: (args: string[]) => Promise<void>): Promise<Rows> {
  const { home, repo } = await tempHive(t);
  const saved = tasks(repo);
  for (const c of saved) if (c.worktree !== undefined && !c.worktreeGone) await mkdir(c.worktree, { recursive: true });
  await saveState(home, savedTasks({ ...initialState(0), localCount: saved.length }, saved, SLUG_OF)); // #629: each worktree on its activity
  const broken = brokenSlug === undefined ? undefined : worktreePath(repo, brokenSlug);
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    await onCall?.(args);
    if (args[1] === broken) throw Object.assign(new Error('Command failed: git'), { stderr: 'fatal: not a git repository\n' });
    if (args.includes('merge-base')) return { stdout: `${MERGE_BASE}\n` };
    if (args.includes('rev-list')) return { stdout: '2\n' };
    if (args.includes('status')) return { stdout: STATUS };
    return { stdout: '' };
  };
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [] };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  calls.length = 0; // whatever the save ran is not the route's
  return { base, repo, calls };
}

test('GET /activities/worktrees answers a task with a worktree on disk with its changed files and its commits ahead of the diff\'s base, running git in the worktree the slug names; a task with none answers no row and runs no git (#586)', async (t) => {
  const f = await startRows(t, (repo) => [
    task(1, { worktree: worktreePath(repo, 'hive-1-task') }),
    task(2),
    task(3, { worktree: worktreePath(repo, 'hive-3-task'), worktreeGone: true }),
  ]);
  const worktree = worktreePath(f.repo, 'hive-1-task');
  const res = await get(f);
  assert.deepEqual([res.status, await res.json()], [200, [{ itemId: 'local:1', changed: 3, ahead: 2 }]]);
  assert.deepEqual(f.calls, [
    ['-C', worktree, 'merge-base', '--end-of-options', 'HEAD', 'origin/HEAD'],
    ['-C', worktree, '-c', 'core.fsmonitor=false', 'status', '--porcelain'],
    ['-C', worktree, 'rev-list', '--count', '--end-of-options', `${MERGE_BASE}..HEAD`],
  ], 'argv, no shell; nothing for tasks 2 and 3');
});

test('GET /activities/worktrees leaves out a task git cannot read and still answers the others (#586)', async (t) => {
  const f = await startRows(t, (repo) => [
    task(1, { worktree: worktreePath(repo, 'hive-1-task') }),
    task(2, { worktree: worktreePath(repo, 'hive-2-task') }),
  ], 'hive-2-task');
  const res = await get(f);
  assert.deepEqual([res.status, await res.json()], [200, [{ itemId: 'local:1', changed: 3, ahead: 2 }]]);
});

test('GET /activities/worktrees counts from the task\'s chosen base, passed after --end-of-options, and reads a checkout task in the workspace\'s checkout (#586)', async (t) => {
  const f = await startRows(t, (repo) => [
    task(1, { worktree: worktreePath(repo, 'hive-1-task'), base: { ref: 'feature/x', tellWorker: false } }),
    task(2, { local: true }),
  ]);
  const res = await get(f);
  assert.deepEqual(await res.json(), [{ itemId: 'local:1', changed: 3, ahead: 2 }, { itemId: 'local:2', changed: 3, ahead: 2 }]);
  assert.deepEqual(f.calls.filter((args) => args.includes('merge-base')), [
    ['-C', worktreePath(f.repo, 'hive-1-task'), 'merge-base', '--end-of-options', 'HEAD', 'feature/x'],
    ['-C', f.repo, 'merge-base', '--end-of-options', 'HEAD', 'origin/HEAD'],
  ]);
});

test('GET /activities/worktrees reads at most four tasks at once, so many activities never fan out into a burst of git (#586)', async (t) => {
  let inFlight = 0;
  let most = 0;
  // a task is in flight from its merge-base to its rev-list, the first and the last of its three git calls
  const onCall = async (args: string[]): Promise<void> => {
    if (args.includes('merge-base')) most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (args.includes('rev-list')) inFlight -= 1;
  };
  const f = await startRows(t, (repo) => [1, 2, 3, 4, 5, 6].map((n) => task(n, { worktree: worktreePath(repo, `hive-${n}-task`) })), undefined, onCall);
  const res = await get(f);
  assert.equal(((await res.json()) as unknown[]).length, 6);
  assert.equal(most, 4);
});
