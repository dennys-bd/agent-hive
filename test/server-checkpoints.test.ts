import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { activityOf } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { branchFor } from '../src/tasks.js';
import { worktreePath } from '../src/worktree.js';
import type { Activity, Checkpoint, Exec, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { bareTask, savedTasks, type WithWork, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';

// The restore routes (#619) over a Comb with no source and no worker: one local task stopped in fila with its worktree, its stage start and one
// checkpoint, saved in state.json before the first save. git is a fake that answers a clean worktree and records every call after -C <dir>.
const START = 'f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1';
const POINT = 'c3d4e5f6a7b8c3d4e5f6a7b8c3d4e5f6a7b8c3d4';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const SLUG = 'hive-1-task';
const A1: Checkpoint = { n: 1, stage: 'fila', start: START, head: START, commit: POINT, branch: '', at: '2026-10-10T10:00:00.000Z', ended: 'done' };
const fixture = (repo: string): WithWork => ({
  item: { itemId: 'local:1', id: 'HIVE-1', title: 'Task 1', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive',
  stopped: true, worktree: worktreePath(repo, SLUG), stageStart: { stage: 'fila', commit: START }, checkpoints: [A1],
});
const BRANCH = branchFor({}, bareTask(fixture('/r')).item);

interface Restores { base: string; server: HiveServer; calls: string[][]; raw: string[][]; git: { failing?: string; published?: string } }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const route = (f: Restores, n: number | string): string => `${f.base}${workPath(f.server, 'local:1')}/checkpoints/${n}/restore`;
const work = (f: Restores): Activity => activityOf(f.server.getState()!, 'local:1')!;

async function startRestores(t: TestContext, extra: Partial<WithWork> = {}): Promise<Restores> {
  const { home, repo } = await tempHive(t);
  await mkdir(worktreePath(repo, SLUG), { recursive: true }); // on disk, or the post-poll check marks it gone (#208)
  await saveState(home, savedTasks({ ...initialState(0), localCount: 1 }, [{ ...fixture(repo), ...extra }], () => SLUG));
  const calls: string[][] = [];
  const raw: string[][] = [];
  const git: Restores['git'] = {};
  const exec: Exec = async (_file, args) => {
    raw.push(args);
    let command = args.slice(args.indexOf('-C') + 2); // after git's global options and the directory
    while (command[0] === '-c') command = command.slice(2); // and the -c settings a read runs with
    calls.push(command);
    if (command[0] === git.failing) throw Object.assign(new Error(`Command failed: git ${command.join(' ')}`), { stderr: 'fatal: boom\n' });
    if (command[0] === 'rev-parse' && command[1] === '--show-toplevel') return { stdout: `${args[1]}\n` }; // its own checkout
    if (command[0] === 'rev-parse' && command[1] === 'HEAD') return { stdout: `${HEAD}\n` };
    if (command[0] === 'symbolic-ref') return { stdout: `${BRANCH}\n` };
    if (command[0] === 'ls-remote') return { stdout: git.published === undefined ? '' : `${git.published}\trefs/heads/${BRANCH}\n` };
    return { stdout: '' }; // status: a clean worktree
  };
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [] };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  calls.length = 0; // whatever the save ran is not a restore
  raw.length = 0;
  return { base, server, calls, raw, git };
}

test('GET …/checkpoints/:n/restore previews Restart\'s plan for the checkpoint\'s head; an unknown or malformed checkpoint is a 404 (#619)', async (t) => {
  const f = await startRestores(t);
  assert.deepEqual(await json(hiveFetch(route(f, 1))), { mode: 'reset', branch: BRANCH });
  f.git.published = 'feedfacefeedfacefeedfacefeedfacefeedface';
  assert.deepEqual(await json(hiveFetch(route(f, 1))), { mode: 'branch', branch: BRANCH, newBranch: `${BRANCH}-r2` });
  for (const n of [9, '1abc', '-1', '1.0', '%20']) {
    const unknown = await hiveFetch(route(f, n));
    assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'ponto de restauração desconhecido' }], String(n));
  }
});

test('POST …/restore captures the current state as a checkpoint, then resets, cleans and puts the checkpoint\'s work back unstaged; the task keeps its stage and start (#619)', async (t) => {
  const f = await startRestores(t);
  const res = await postJson(route(f, 1));
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(f.calls, [
    ['rev-parse', 'HEAD'], ['symbolic-ref', '--short', 'HEAD'], ['status', '--porcelain'], ['update-ref', `refs/hive/${SLUG}/checkpoint/2`, HEAD], // the capture
    ['cat-file', '-e', `${START}^{commit}`], ['ls-remote', 'origin', `refs/heads/${BRANCH}`, `refs/heads/${BRANCH}-r*`], // the plan
    ['rev-parse', '--show-toplevel'], ['symbolic-ref', '--short', 'HEAD'], ['reset', '--hard', START], ['clean', '-fd'], // Restart's git
    ['read-tree', '-u', '--reset', POINT], ['reset', '-q'], // the checkpoint's work, unstaged
  ]);
  const after = work(f);
  assert.deepEqual(
    [after.checkpoints?.map((a) => [a.n, a.ended]), after.deleting, after.stageStart, after.stopped, f.server.getState()!.tasks[0].stage],
    [[[1, 'done'], [2, 'restore']], undefined, { stage: 'fila', commit: START }, true, 'fila'],
  );
});

test('POST …/restore on a published branch checks out <branch>-r2 and the activity follows it (#619)', async (t) => {
  const f = await startRestores(t);
  f.git.published = 'feedfacefeedfacefeedfacefeedfacefeedface';
  assert.deepEqual(await json(postJson(route(f, 1))), { ok: true });
  assert.ok(f.calls.some((c) => c.join(' ') === `switch -c ${BRANCH}-r2 ${START}`));
  assert.equal(work(f).branch, `${BRANCH}-r2`);
});

test('POST …/restore answers 409 when the task is already marked, running no git, and 500 with git\'s words when its git fails, the mark gone and the capture kept (#619)', async (t) => {
  const f = await startRestores(t);
  await f.server.dispatch({ type: 'restoring', itemId: 'local:1' }); // another git job holds the task
  const refused = await postJson(route(f, 1));
  assert.deepEqual([refused.status, await refused.json(), f.calls], [409, { error: 'restauração indisponível: uma execução ou outra operação está ativa na tarefa' }, []]);
  assert.equal(work(f).deleting, true, 'the other job\'s mark is not this restore\'s to drop');
  await f.server.dispatch({ type: 'restoreFailed', itemId: 'local:1' });
  f.git.failing = 'read-tree';
  const broken = await postJson(route(f, 1));
  assert.deepEqual([broken.status, await broken.json()], [500, { error: 'fatal: boom' }]);
  assert.deepEqual([work(f).deleting, work(f).checkpoints?.length], [undefined, 2]);
});

test('POST …/restore on an unknown checkpoint is a 404 and runs no git (#619)', async (t) => {
  const f = await startRestores(t);
  const res = await postJson(route(f, '9'));
  assert.deepEqual([res.status, f.calls], [404, []]);
});

test('POST …/restore reads the worker\'s worktree status with fsmonitor off and no optional locks, so a configured monitor never runs and the index is not rewritten (#619)', async (t) => {
  const f = await startRestores(t);
  assert.equal((await postJson(route(f, 1))).status, 200);
  const status = f.raw.find((args) => args.includes('status'));
  assert.ok(status?.includes('--no-optional-locks'), 'no optional locks');
  assert.ok(status?.join(' ').includes('-c core.fsmonitor=false'), 'fsmonitor off');
});

test('POST …/restore refuses with 409 a task that has no worktree of its own (the user\'s checkout, none, or gone), before the mark and any git (#619)', async (t) => {
  for (const extra of [{ local: true }, { worktree: undefined }, { worktreeGone: true }] as Partial<WithWork>[]) {
    const f = await startRestores(t, extra);
    const res = await postJson(route(f, 1));
    assert.equal(res.status, 409, JSON.stringify(extra));
    assert.deepEqual([f.calls, work(f).deleting], [[], undefined], JSON.stringify(extra));
  }
});

test('POST …/restore stops when the safety capture records nothing: 500, the mark dropped, no reset or clean ran (#619)', async (t) => {
  const f = await startRestores(t);
  f.git.failing = 'status';
  const res = await postJson(route(f, 1));
  assert.equal(res.status, 500);
  assert.deepEqual(f.calls.filter((c) => ['reset', 'clean', 'read-tree', 'switch'].includes(c[0])), []);
  assert.deepEqual([work(f).deleting, work(f).checkpoints?.length], [undefined, 1]);
});
