import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activityOf } from '../src/activities.js';
import type { ChannelView } from '../src/console.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { Exec, SettingsBody, Stage, Task } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { TEARDOWN_MARKER } from '../src/worktree-teardown.js';
import { AUTH, fakeLog, fakeSourceFactory, fakeSpawn, GITHUB_ENTRY, STAGES, tempHive, workspacesAt } from './fakes.js';
import { readyOn, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';

// A workspace's teardown (#654) through the server: the fake source's task, a local task and an orphan, each listed by git under
// .hive/worktrees on its own branch. No worker unless a test asks for one.
const SLUG = 'hive-1-from-ready';
const LOCAL_SLUG = 'hive-hive-1-local';
const ORPHAN_SLUG = 'hive-9-gone';
const BRANCHES: [string, string][] = [[SLUG, 'hive/1-from-ready'], [LOCAL_SLUG, 'hive/HIVE-1-local'], [ORPHAN_SLUG, 'hive/9-gone']];
const FAILED = 'teardown failed at line 1 (RUN exit 3): exit 3';
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
  showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

interface Started { base: string; repo: string; gitDir: string; server: HiveServer; calls: string[][] }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const hookEvent = (base: string, ptyId: string, payload: unknown): Promise<Response> =>
  hiveFetch(`${base}/hooks/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': ptyId }, body: JSON.stringify(payload) });
const task0 = (server: HiveServer): Task => server.getState()!.tasks[0];
// A task's live activity (#629): where its worktree, its deleting mark and its error are
const work = (server: HiveServer, taskId: string) => activityOf(server.getState()!, taskId);
const deletePath = (s: Started, taskId: string): string => `${s.base}${workPath(s.server, taskId)}/delete`; // #629: was /tasks/:id/delete-activity
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const history = async (base: string): Promise<string> => (await json<ChannelView>(hiveFetch(`${base}/console/setup`))).history;
const settingsWith = (repo: string, teardown: string, extra: Partial<Omit<SettingsBody, 'workspaces'>> = {}) =>
  ({ ...BODY, ...extra, workspaces: [{ ...workspacesAt(repo)[0], teardown }] });

// git lists the main checkout and the three worktrees, answers the git dir with a temp folder, makes the folder on `worktree add` and passes
// every check (clean, merged); every argv after -C <dir> is recorded.
async function start(t: TestContext, teardown: string, extra: Partial<Omit<SettingsBody, 'workspaces'>> = {}, cap = 0): Promise<Started> {
  const { home, repo } = await tempHive(t, cap);
  const gitDir = join(repo, '.git', 'worktrees', SLUG); // the worktree's admin dir, where the teardown marker lives
  await Promise.all([SLUG, LOCAL_SLUG, ORPHAN_SLUG].map((slug) => mkdir(join(repo, '.git', 'worktrees', slug), { recursive: true })));
  const listing = [`worktree ${repo}\nHEAD 1111\nbranch refs/heads/main\n`, ...BRANCHES.map(([slug, branch]) => `worktree ${worktreePath(repo, slug)}\nHEAD 2222\nbranch refs/heads/${branch}\n`)].join('\n');
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args.slice(2));
    if (args.includes('add')) await mkdir(args[args.indexOf('--') + 1], { recursive: true });
    if (args.includes('--git-common-dir')) return { stdout: `${join(repo, '.git')}\n` };
    return { stdout: args.includes('list') ? listing : '' };
  };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec, log: fakeLog().log });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, settingsWith(repo, teardown, extra))).status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  return { base, repo, gitDir, server, calls };
}

// A worktree on disk that the task owns, as a first open would leave it
async function withWorktree(s: Started, taskId: string, slug: string, branch: string): Promise<string> {
  const path = worktreePath(s.repo, slug);
  await mkdir(path, { recursive: true });
  await readyOn(s.server, taskId, { path, branch, base: null, local: false }); // #629: the activity first
  return path;
}

test('the ⋯ delete activity runs the teardown in the worktree after git\'s checks and before the remove, in a teardown run of the setup channel, and writes its marker (#654)', async (t) => {
  const s = await start(t, 'COPY notes.md');
  const path = await withWorktree(s, 'board:I1', SLUG, BRANCHES[0][1]);
  await writeFile(join(path, 'notes.md'), 'kept\n');
  s.calls.length = 0;
  assert.deepEqual(await json(postJson(deletePath(s, 'board:I1'))), { removed: true });
  assert.equal(await readFile(join(s.repo, 'notes.md'), 'utf8'), 'kept\n', 'the teardown copies into the main checkout');
  assert.equal(await exists(join(s.gitDir, TEARDOWN_MARKER)), true);
  const at = (match: (c: string[]) => boolean): number => s.calls.findIndex(match);
  const checked = at((c) => c[0] === 'merge-base');
  const tornDown = at((c) => c.includes('--git-common-dir'));
  const removed = at((c) => c[0] === 'worktree' && c[1] === 'remove');
  assert.ok(checked < tornDown && tornDown < removed, s.calls.map((c) => c.join(' ')).join('\n'));
  const text = await history(s.base);
  assert.match(text, /── #1 · teardown · \d\d:\d\d:\d\d ──/);
  assert.match(text, /copied 1 files to notes\.md/);
  assert.match(text, /teardown ok · 1 steps · \d+ms/);
});

test('a failing teardown step is the ⋯ route\'s refusal: nothing removed, no marker, the task keeps its worktree; force then skips the teardown and removes (#654)', async (t) => {
  const s = await start(t, 'RUN exit 3');
  const path = await withWorktree(s, 'board:I1', SLUG, BRANCHES[0][1]);
  s.calls.length = 0;
  assert.deepEqual(await json(postJson(deletePath(s, 'board:I1'))), { removed: false, refused: FAILED });
  assert.equal(s.calls.some((c) => c[1] === 'remove' || c[0] === 'branch'), false, 'all or nothing');
  assert.deepEqual([await exists(join(s.gitDir, TEARDOWN_MARKER)), work(s.server, 'board:I1')?.worktree, work(s.server, 'board:I1')?.deleting], [false, path, undefined]);
  assert.deepEqual(await json(postJson(deletePath(s, 'board:I1'), { force: true })), { removed: true });
  assert.match(await history(s.base), /teardown skipped: forced/);
});

test('excluir task… on a local task whose teardown fails answers 409 with the message and the task stays (#542, #654)', async (t) => {
  const s = await start(t, 'RUN exit 3');
  assert.equal((await postJson(`${s.base}/tasks`, { title: 'Local', stage: 'fila' })).status, 201);
  const path = await withWorktree(s, 'local:1', LOCAL_SLUG, BRANCHES[1][1]);
  const res = await postJson(`${s.base}/tasks/${encodeURIComponent('local:1')}/close`);
  assert.deepEqual([res.status, await res.json()], [409, { error: FAILED }]);
  assert.equal(work(s.server, 'local:1')?.worktree, path);
});

test('the delete activity stage\'s teardown failure is deleteActivityFailed: the task stays in the stage with the message (#654)', async (t) => {
  const stages: Stage[] = [STAGES[0], { name: 'done', from: { board: ['In review'] }, action: 'deleteActivity' }, { name: 'archive', from: { board: ['Done'] } }];
  const s = await start(t, 'RUN exit 3', { stages }, 1); // I1 runs in fila, in a worktree the spawn made
  const ptyId = s.server.getState()!.workers[0].runId!;
  await hookEvent(s.base, ptyId, { hook_event_name: 'SessionStart', cwd: s.repo });
  await s.server.dispatch({ type: 'done', ptyId });
  await hookEvent(s.base, ptyId, { hook_event_name: 'Stop' }); // fila ends into done: its delete activity runs in this dispatch (#284)
  assert.deepEqual([task0(s.server).stage, work(s.server, task0(s.server).item.itemId)?.error], ['done', FAILED]);
});

test('an orphan\'s removal runs the teardown in a run labelled by its slug: a failure is the refused answer, a teardown that goes through removes (#181, #654)', async (t) => {
  const s = await start(t, 'RUN exit 3');
  const path = worktreePath(s.repo, ORPHAN_SLUG);
  await mkdir(path, { recursive: true });
  assert.deepEqual(await json(postJson(`${s.base}/worktrees/hive/${ORPHAN_SLUG}/remove`)), { removed: false, refused: FAILED });
  assert.match(await history(s.base), /── hive-9-gone · teardown · /);
  assert.equal((await postJson(`${s.base}/settings`, settingsWith(s.repo, 'RUN true'))).status, 200);
  s.calls.length = 0;
  assert.deepEqual(await json(postJson(`${s.base}/worktrees/hive/${ORPHAN_SLUG}/remove`)), { removed: true });
  assert.ok(s.calls.some((c) => c.join(' ') === `worktree remove -- ${path}`));
});
