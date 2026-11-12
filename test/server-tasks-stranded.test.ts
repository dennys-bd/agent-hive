import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transcriptDir } from '../src/agents/claude-transcript.js';
import { activityOf } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { branchFor } from '../src/tasks.js';
import { worktreePath } from '../src/worktree.js';
import type { DeleteActivityScope, Exec, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { bodyFlows, LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { bareTask, savedTasks, type WithWork, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// #746: delete activity and delete task on a created task whose workspace left the Comb. One local task, stopped in fila, whose workspace is
// `gone`; git is a fake that lists the worktrees it is told to and records every call after -C <dir>.
const SLUG = 'hive-1-task';
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const AT = '2026-10-10T10:00:00.000Z';
const TRANSCRIPTS: DeleteActivityScope = { session: true, transcripts: true, nonAutoTasks: false };
const fixture = (worktree: string): WithWork => ({
  item: { itemId: 'local:1', id: 'HIVE-1', title: 'Task 1', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'gone', stopped: true, worktree,
});
const BRANCH = branchFor({}, bareTask(fixture('/r')).item);

interface Fake { listed: boolean; listFails: boolean; dirty: Record<string, string>; unmerged: boolean; ignored: string }
interface Started { base: string; repo: string; server: HiveServer; calls: string[][]; fake: Fake }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const hasTask = (s: Started): boolean => s.server.getState()!.tasks.some((task) => task.item.itemId === 'local:1');
const hasActivity = (s: Started): boolean => activityOf(s.server.getState()!, 'local:1') !== undefined;
const ran = (s: Started, ...words: string[]): boolean => s.calls.some((c) => words.every((w, i) => c[i] === w));

// `worktree` is where the activity says its worktree is, from the repo (default: the Hive's own place). Git lists the main checkout and, while
// fake.listed, that worktree on BRANCH; `status` answers fake.dirty[<dir>] and everything else passes every check.
async function start(t: TestContext, where: (repo: string) => string = (repo) => worktreePath(repo, SLUG), scope: DeleteActivityScope = DELETE_ACTIVITY_DEFAULTS, sessions = false): Promise<Started> {
  const { home, repo } = await tempHive(t);
  const worktree = where(repo);
  await mkdir(worktree, { recursive: true });
  let saved = savedTasks({ ...initialState(0), localCount: 1, deleteActivity: scope }, [fixture(worktree)], () => SLUG);
  if (sessions) saved = { ...saved, activityRecords: saved.activityRecords.map((r) => ({ ...r, sessions: [{ id: SESSION, startedAt: AT, stages: ['fila'], agent: 'claude' as const, lastUsedAt: AT }] })) };
  await saveState(home, saved);
  const fake: Fake = { listed: true, listFails: false, dirty: {}, unmerged: false, ignored: '' };
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    let command = args.slice(2); // after -C <dir>
    while (command[0] === '-c') command = command.slice(2);
    calls.push(command);
    if (command[0] === 'worktree' && command[1] === 'list') {
      if (fake.listFails) throw new Error('fatal: not a git repository');
      return { stdout: `worktree ${repo}\nHEAD 1\nbranch refs/heads/main\n\n${fake.listed ? `worktree ${worktree}\nHEAD 2\nbranch refs/heads/${BRANCH}\n` : ''}` };
    }
    if (command[0] === 'status') return { stdout: fake.dirty[args[1]] ?? '' };
    if (command[0] === 'ls-files') return { stdout: fake.ignored };
    if (command[0] === 'merge-base' && fake.unmerged) throw Object.assign(new Error('not an ancestor'), { code: 1 });
    return { stdout: '' };
  };
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], flows: bodyFlows(LOCAL_STAGES), onClose: 'menuBar', deleteActivity: scope, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, commandSemaphores: [], trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [] };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  calls.length = 0; // whatever the save ran is not a deletion
  return { base, repo, server, calls, fake };
}

const del = (s: Started, body?: unknown): Promise<Response> => postJson(`${s.base}${workPath(s.server, 'local:1')}/delete`, body);
const close = (s: Started): Promise<Response> => postJson(`${s.base}/tasks/local:1/close`);

// CLAUDE_CONFIG_DIR for one test: where removeTranscripts looks
async function claudeConfigDir(t: TestContext): Promise<void> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = await tempDir(t, 'claude-');
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
}
const transcriptAt = async (cwd: string): Promise<string> => {
  await mkdir(transcriptDir(cwd), { recursive: true });
  const file = join(transcriptDir(cwd), `${SESSION}.jsonl`);
  await writeFile(file, '{}\n');
  return file;
};

test('delete activity on a removed workspace\'s activity removes its worktree and branch through the repo the path names, and the task loses its activity', async (t) => {
  const s = await start(t);
  assert.deepEqual(await json(del(s)), { removed: true });
  assert.equal(ran(s, 'worktree', 'remove', '--', worktreePath(s.repo, SLUG)), true);
  assert.equal(ran(s, 'branch', '-d', '--', BRANCH), true);
  assert.equal(hasActivity(s), false);
  assert.equal(hasTask(s), true);
});

test('delete activity on a removed workspace answers the refusal a live workspace does for a dirty worktree and an unmerged branch, and removes nothing', async (t) => {
  const s = await start(t);
  const path = worktreePath(s.repo, SLUG);
  s.fake.dirty[path] = ' M a.txt\n';
  assert.deepEqual(await json(del(s)), { removed: false, refused: { reason: 'dirty', path, files: ' M a.txt' } });
  s.fake.dirty = {};
  s.fake.unmerged = true;
  assert.deepEqual(await json(del(s)), { removed: false, refused: { reason: 'unmerged', branch: BRANCH, target: 'HEAD' } });
  assert.equal(ran(s, 'worktree', 'remove'), false);
  assert.equal(hasActivity(s), true);
});

test('delete activity on a removed workspace removes the session transcripts when the scope covers them', async (t) => {
  await claudeConfigDir(t);
  const s = await start(t, undefined, TRANSCRIPTS, true);
  const file = await transcriptAt(worktreePath(s.repo, SLUG));
  assert.deepEqual(await json(del(s)), { removed: true });
  assert.equal(await exists(file), false);
});

test('a stranded worktree holding a nested worktree with uncommitted work is refused without force, and nothing is deleted', async (t) => {
  const s = await start(t);
  const path = worktreePath(s.repo, SLUG);
  s.fake.ignored = 'docs/\0';
  await mkdir(join(s.repo, 'docs', '.git'), { recursive: true });
  await mkdir(join(path, 'docs', '.git'), { recursive: true });
  s.fake.dirty[join(path, 'docs')] = ' M notes.md\n';
  assert.deepEqual(await json(del(s)), { removed: false, refused: { reason: 'dirty', path: join(path, 'docs'), files: ' M notes.md' } });
  assert.equal(ran(s, 'worktree', 'remove'), false);
  assert.equal(await exists(path), true);
  assert.equal(hasActivity(s), true);
});

test('delete activity on a removed workspace whose repo folder is gone answers removed, runs no git and the task loses its activity', async (t) => {
  const s = await start(t);
  await rm(s.repo, { recursive: true, force: true });
  assert.deepEqual(await json(del(s)), { removed: true });
  assert.deepEqual(s.calls, []);
  assert.equal(hasActivity(s), false);
});

test('delete task on a created task whose workspace is gone removes the task, through git when the repo is on disk', async (t) => {
  const s = await start(t);
  assert.deepEqual(await json(close(s)), { ok: true });
  assert.equal(ran(s, 'worktree', 'remove', '--', worktreePath(s.repo, SLUG)), true);
  assert.equal(ran(s, 'branch', '-d', '--', BRANCH), true);
  assert.equal(hasTask(s), false);
});

test('delete task on a created task whose workspace and repo folder are gone removes the task and runs no git', async (t) => {
  const s = await start(t);
  await rm(s.repo, { recursive: true, force: true });
  assert.deepEqual(await json(close(s)), { ok: true });
  assert.deepEqual(s.calls, []);
  assert.equal(hasTask(s), false);
});

test('a worktree path not of the Hive\'s shape runs no git and removes nothing, transcripts included', async (t) => {
  await claudeConfigDir(t);
  const s = await start(t, (repo) => join(repo, 'elsewhere', SLUG), TRANSCRIPTS, true);
  const elsewhere = join(s.repo, 'elsewhere', SLUG);
  const file = await transcriptAt(elsewhere);
  assert.deepEqual(await json(del(s)), { removed: true });
  assert.deepEqual(s.calls, []);
  assert.equal(await exists(elsewhere), true);
  assert.equal(await exists(file), true);
  assert.equal(hasActivity(s), false);
});

test('a path git does not confirm runs only the confirmation, removes no worktree and still drops the transcripts under the repo the path names', async (t) => {
  await claudeConfigDir(t);
  const s = await start(t, undefined, TRANSCRIPTS, true);
  s.fake.listed = false; // the folder is on disk, but git lists no such worktree
  const path = worktreePath(s.repo, SLUG);
  const file = await transcriptAt(path);
  assert.deepEqual(await json(del(s)), { removed: true });
  assert.deepEqual(s.calls.map((c) => c.slice(0, 2)), [['worktree', 'list']]);
  assert.equal(await exists(path), true);
  assert.equal(await exists(file), false);
  assert.equal(hasActivity(s), false);
});

test('a git failure on the confirmation is treated as nothing on disk: the activity is forgotten and no removal runs', async (t) => {
  const s = await start(t);
  s.fake.listFails = true;
  assert.deepEqual(await json(del(s)), { removed: true });
  assert.deepEqual(s.calls.map((c) => c.slice(0, 2)), [['worktree', 'list']]);
  assert.equal(hasActivity(s), false);
});
