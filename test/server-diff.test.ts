import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { worktreePath } from '../src/worktree.js';
import type { Checkpoint, Task, Exec, SettingsBody } from '../src/types.js';
import { fileHash } from '../src/diff.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { savedTasks, type WithWork, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';

// GET /activities/:id/diff (#270, #629) over a Comb with no source and no worker: its tasks are local ones saved in state.json before the first save. git is
// a fake that answers the index path, the merge-base and the diff, and records every call.
const START = 'f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1';
const MERGE_BASE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const PARENT = '0f1e2d3c4b5a0f1e2d3c4b5a0f1e2d3c4b5a0f1e';
const DIFF = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+two', ''].join('\n');
const FILES = [{ path: 'a.txt', status: 'modified', hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'del', text: 'one', old: 1 }, { kind: 'add', text: 'two', new: 1 }] }] }].map((f) => ({ ...f, hash: fileHash(f as Parameters<typeof fileHash>[0]) }));
const task = (n: number, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...extra,
});
// The slug a saved activity carries (#629): the one the worktree paths below name
const SLUG_OF = (c: Task): string => `hive-${c.item.id.replace('HIVE-', '')}-task`;

interface Diffs { base: string; repo: string; calls: string[][]; fail(err: unknown): void; orphan(): void; server: HiveServer }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const get = (f: Diffs, id: string, scope?: string): Promise<Response> =>
  hiveFetch(`${f.base}${workPath(f.server, id)}/diff${scope === undefined ? '' : `?scope=${scope}`}`);

// Every task with a worktree still on disk gets its directory: the post-poll check marks a missing one gone (#208).
async function startDiffs(t: TestContext, tasks: (repo: string) => WithWork[]): Promise<Diffs> {
  const { home, repo } = await tempHive(t);
  const saved = tasks(repo);
  for (const c of saved) if (c.worktree !== undefined && !c.worktreeGone) await mkdir(c.worktree, { recursive: true });
  const index = join(await tempDir(t, 'index-'), 'index');
  await writeFile(index, 'the real index');
  await saveState(home, savedTasks({ ...initialState(0), localCount: saved.length }, saved, SLUG_OF)); // #629: each worktree on its activity
  const calls: string[][] = [];
  let failure: unknown;
  let noParent = false;
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (args.includes('--git-path')) return { stdout: `${index}\n` };
    if (args.includes('merge-base')) return { stdout: `${MERGE_BASE}\n` };
    if (args.includes('--verify')) {
      if (noParent) throw new Error('fatal: Needed a single revision');
      return { stdout: `${PARENT}\n` };
    }
    if (!args.includes('diff')) return { stdout: '' };
    if (failure !== undefined) throw failure;
    return { stdout: DIFF };
  };
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [] };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  calls.length = 0; // whatever the save ran is not the diff
  return { base, repo, calls, fail: (err) => { failure = err; }, orphan: () => { noParent = true; }, server };
}

test('GET /activities/:id/diff answers the worktree on disk against the stage start, or against the merge-base with origin/HEAD, parsed, running git in the worktree the slug names (#270)', async (t) => {
  const f = await startDiffs(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task'), stageStart: { stage: 'fila', commit: START } })]);
  const worktree = worktreePath(f.repo, 'hive-1-task');
  const stage = await get(f, 'local:1', 'stage');
  assert.deepEqual([stage.status, await stage.json()], [200, { scope: 'stage', base: 'f0e1d2c', files: FILES }]);
  assert.deepEqual(f.calls.map((args) => args.slice(0, 2)), [['-C', worktree], ['-C', worktree], ['-C', worktree]], 'rev-parse, add and diff, all in the worktree');
  assert.equal(f.calls.at(-1)?.at(-1), START, 'the stage scope diffs from its recorded start');
  f.calls.length = 0;
  const all = await get(f, 'local:1', 'worktree');
  assert.deepEqual([all.status, await all.json()], [200, { scope: 'worktree', base: 'a1b2c3d (origin/HEAD)', files: FILES }]);
  assert.deepEqual(f.calls[0], ['-C', worktree, 'merge-base', '--end-of-options', 'HEAD', 'origin/HEAD']);
  assert.equal(f.calls.at(-1)?.at(-1), MERGE_BASE);
});

test('GET /activities/:id/diff refuses an unknown task (404), a scope that is not stage or worktree (400), and a task with no workspace, no worktree on disk or no start in its current stage (409), running no git (#270)', async (t) => {
  const f = await startDiffs(t, (repo) => [
    task(1, { worktree: worktreePath(repo, 'hive-1-task') }),
    task(2),
    task(3, { worktree: worktreePath(repo, 'hive-3-task'), worktreeGone: true }),
    task(4, { worktree: worktreePath(repo, 'hive-4-task'), stageStart: { stage: 'other', commit: START } }),
    task(5, { workspace: 'gone', worktree: worktreePath(repo, 'hive-5-task') }),
  ]);
  const refusals: [string, string | undefined, number, string][] = [
    ['local:9', 'stage', 404, 'atividade desconhecida'], // #629: no activity under that id, checked first
    ['local:1', undefined, 400, 'scope deve ser stage, worktree, commit ou checkpoint'],
    ['local:1', 'all', 400, 'scope deve ser stage, worktree, commit ou checkpoint'],
    ['local:1', 'stage', 409, 'a etapa atual não tem início registrado'],
    ['local:4', 'stage', 409, 'a etapa atual não tem início registrado'],
    ['local:2', 'worktree', 404, 'atividade desconhecida'], // #629: never opened, so no activity to diff
    ['local:3', 'stage', 409, 'tarefa sem worktree no disco'],
    ['local:5', 'worktree', 409, 'workspace gone is gone'],
  ];
  for (const [id, scope, status, error] of refusals) {
    const res = await get(f, id, scope);
    assert.deepEqual([res.status, await res.json()], [status, { error }], `${id} ${scope}`);
  }
  assert.deepEqual(f.calls, [], 'no refusal runs git');
});

test('GET /activities/:id/diff answers 413 when the diff passes DIFF_MAX_BYTES and 500 with git\'s own words on any other failure (#270)', async (t) => {
  const f = await startDiffs(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  f.fail(Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
  const large = await get(f, 'local:1', 'worktree');
  assert.deepEqual([large.status, await large.json()], [413, { error: 'diff grande demais para o visualizador' }]);
  f.fail(Object.assign(new Error('Command failed: git diff'), { stderr: 'fatal: bad object a1b2c3d\n' }));
  const broken = await get(f, 'local:1', 'worktree');
  assert.deepEqual([broken.status, await broken.json()], [500, { error: 'fatal: bad object a1b2c3d' }]);
});

test('GET /activities/:id/diff?scope=commit answers HEAD^ against HEAD in the worktree, and 409 on a root commit (#591)', async (t) => {
  const f = await startDiffs(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const worktree = worktreePath(f.repo, 'hive-1-task');
  const res = await get(f, 'local:1', 'commit');
  assert.deepEqual([res.status, await res.json()], [200, { scope: 'commit', base: '0f1e2d3 (HEAD^)', files: FILES }]);
  assert.deepEqual(f.calls.map((args) => args.slice(0, 3)), [['-C', worktree, 'rev-parse'], ['-C', worktree, '-c']], 'no index copy, no add');
  assert.deepEqual(f.calls.at(-1)?.slice(-2), ['HEAD^', 'HEAD']);
  f.orphan();
  const root = await get(f, 'local:1', 'commit');
  assert.deepEqual([root.status, await root.json()], [409, { error: 'o último commit não tem pai' }]);
});

test('GET /activities/:id/diff?scope=checkpoint&checkpoint=<n> diffs the worktree against that checkpoint\'s point; a missing or unknown n is a 400, a task with no checkpoint a 409 (#619)', async (t) => {
  const A1: Checkpoint = { n: 1, stage: 'fila', start: START, head: START, commit: PARENT, branch: '', at: '2026-10-10T10:00:00.000Z', ended: 'done' };
  const f = await startDiffs(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task'), checkpoints: [A1] }), task(2, { worktree: worktreePath(repo, 'hive-2-task') })]);
  const res = await get(f, 'local:1', 'checkpoint&checkpoint=1');
  assert.deepEqual([res.status, await res.json()], [200, { scope: 'checkpoint', base: '0f1e2d3 (checkpoint 1)', files: FILES }]);
  assert.equal(f.calls.at(-1)?.at(-1), PARENT, 'the diff runs against the point');
  f.calls.length = 0;
  const refusals: [string, string, number, string][] = [
    ['local:1', 'checkpoint', 400, 'informe checkpoint: o número de um ponto de restauração da tarefa'],
    ['local:1', 'checkpoint&checkpoint=9', 400, 'informe checkpoint: o número de um ponto de restauração da tarefa'],
    ['local:2', 'checkpoint&checkpoint=1', 409, 'a tarefa não tem pontos de restauração'],
  ];
  for (const [id, scope, status, error] of refusals) {
    const refused = await get(f, id, scope);
    assert.deepEqual([refused.status, await refused.json()], [status, { error }], `${id} ${scope}`);
  }
  assert.deepEqual(f.calls, [], 'no refusal runs git');
});
