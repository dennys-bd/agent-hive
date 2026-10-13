import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { worktreePath } from '../src/worktree.js';
import type { Task, TaskFile, Exec, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { savedActivityId, withKeptRecord, withWork, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { localActivityId } from '../src/activities.js';

// A Comb with no source and no worker: its only task is a local one saved in state.json before the first save, with a workspace and a result
// (#99) that holds two paths, a URL, a number, an absolute path and one that leads out (#258).
const SLUG = 'hive-1-spec';
const task = (extra: Partial<Task> = {}): Task => ({
  item: { itemId: 'local:1', id: 'HIVE-1', title: 'Spec', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive',
  ...extra,
});
// The task's result, in its record (#629)
const RESULT = { spec: 'docs/spec.md', plan: 'docs/plan.md', pr: 'https://github.com/acme/r/pull/1', count: 3, abs: '/hive-697-no-such-dir/x.md', up: '../../../x.md' };

interface Files { base: string; repo: string; worktree: string; calls: string[][]; fail(message: string): void; setOrigin(url: string): void; server: HiveServer }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const files = async (f: Files, id = 'local:1'): Promise<TaskFile[]> => (await hiveFetch(`${f.base}${workPath(f.server, id)}/files`)).json() as Promise<TaskFile[]>;

// The task's worktree holds docs/spec.md; the exec records every call and, once fail() is called, rejects like a CLI that failed.
// others: more tasks, each with an activity of its own (#588, #629), a terminal of theirs needs one to post from
async function startFiles(t: TestContext, saved: Task = task(), isDeleted = false, others: Task[] = [], result: Record<string, unknown> = RESULT): Promise<Files> {
  const made = await tempHive(t);
  const repo = await realpath(made.repo); // the routes answer real paths: macOS's tmpdir is a symlink
  const worktree = worktreePath(repo, SLUG);
  await mkdir(join(worktree, 'docs'), { recursive: true });
  await writeFile(join(worktree, 'docs', 'spec.md'), '# spec');
  const base0 = { ...initialState(0), localCount: 1, tasks: [saved, ...others] };
  // #629: its activity names the worktree; a deleted one is its record alone
  const own = isDeleted
    ? withKeptRecord(base0, saved.item.itemId, savedActivityId(1), { slug: SLUG, result })
    : withWork(base0, saved.item.itemId, { id: savedActivityId(1), slug: SLUG }, { result });
  await saveState(made.home, others.reduce((state, other, i) => withWork(state, other.item.itemId, { id: savedActivityId(i + 2), slug: `hive-${i + 2}-issue` }), own));
  const calls: string[][] = [];
  let failure: string | undefined;
  let origin = ''; // what git remote get-url origin prints (#588): none until a test sets one
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (failure) throw new Error(failure);
    return { stdout: args.includes('get-url') ? `${origin}\n` : '' };
  };
  const server = createServer({ secret: SECRET, home: made.home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [] };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  calls.length = 0; // whatever the save ran is not what a test asserts
  return { base, repo, worktree, calls, fail: (message) => { failure = message; }, setOrigin: (url) => { origin = url; }, server };
}

test('files lists every string of the result that resolves to a file: from the worktree, then from the workspace once the worktree is gone, (#717); a URL, a number and a missing path never; [] with no workspace; 404 for an unknown task (#258, #697)', async (t) => {
  const f = await startFiles(t);
  await mkdir(join(f.repo, 'docs'));
  await writeFile(join(f.repo, 'docs', 'spec.md'), '# spec, merged');
  await writeFile(join(f.repo, 'docs', 'plan.md'), '# plan');
  assert.deepEqual(await files(f), [{ key: 'spec', path: 'docs/spec.md', base: 'worktree' }], 'plan is not in the worktree; a URL, a number, a missing absolute path and a missing ../ path never are');
  await rm(f.worktree, { recursive: true });
  assert.deepEqual(await files(f), [{ key: 'spec', path: 'docs/spec.md', base: 'workspace' }, { key: 'plan', path: 'docs/plan.md', base: 'workspace' }], 'after a delete activity: the main checkout');
  assert.equal((await hiveFetch(`${f.base}${workPath(f.server, 'local:9')}/files`)).status, 404);
  assert.deepEqual(await files(await startFiles(t)), [{ key: 'spec', path: 'docs/spec.md', base: 'worktree' }], 'the links open in the editor pane (#717)');
  assert.deepEqual(await files(await startFiles(t, task({ workspace: 'gone' }))), [], 'no workspace: no links');
});

test('files lists a result outside the worktree, absolute (base outside) or ../ into the checkout (base workspace), (#697)', async (t) => {
  const plan = join(await realpath(await tempDir(t, 'docs-repo-')), 'plan.md');
  await writeFile(plan, '# plan');
  const f = await startFiles(t, task(), false, [], { plan, spec: '../../../docs/spec.md' });
  await mkdir(join(f.repo, 'docs'));
  await writeFile(join(f.repo, 'docs', 'spec.md'), '# spec, merged');
  assert.deepEqual(await files(f), [{ key: 'plan', path: plan, base: 'outside' }, { key: 'spec', path: '../../../docs/spec.md', base: 'workspace' }]);
});

test('after a delete activity the record id still lists the result\'s files from the main checkout; a record with no live activity is no live route (#629)', async (t) => {
  const f = await startFiles(t, task(), true);
  await mkdir(join(f.repo, 'docs'));
  await writeFile(join(f.repo, 'docs', 'spec.md'), '# spec, merged');
  assert.deepEqual(await files(f), [{ key: 'spec', path: 'docs/spec.md', base: 'workspace' }]);
  assert.equal((await hiveFetch(`${f.base}/activities/${savedActivityId(1)}/diff`)).status, 404);
});

// Source tasks next to the local HIVE-1 (#588): issues 10 and 20 of acme/app, and 30 of acme/lib with a qualified id
const sourceIssue = (n: number, repository: string, id = String(n)): Task => task({
  item: { itemId: `gh:${n}`, id, title: `Issue ${n}`, body: '', url: `https://github.com/${repository}/issues/${n}`, source: 'gh', facets: { assignees: [], labels: [], repository, fields: {} } },
  created: undefined,
  orphan: true, // #191: a listed task is saved lean and this hive has no read model to hydrate it, so its item stays whole
});
const NO_REF = { error: 'no task or issue for this reference' };
const BAD_REF = { error: 'ref must be #N or PREFIX-N' };

test('open-ref answers the task a reference names, else the issue in the terminal task\'s repository; a local activity resolves only the Hive\'s tasks; 404 for nothing or an unknown activity, 400 for a malformed ref (#588, #629)', async (t) => {
  const f = await startFiles(t, task(), false, [sourceIssue(10, 'acme/app'), sourceIssue(20, 'acme/app'), sourceIssue(30, 'acme/lib', 'GH-30')]);
  const issue = `${workPath(f.server, 'gh:10')}/open-ref`; // #629: the terminal's activity
  const own = `${workPath(f.server, 'local:1')}/open-ref`;
  const shell = `/activities/${encodeURIComponent(localActivityId('hive'))}/open-ref`;
  const answers: [string, string, number, unknown][] = [
    [issue, '#20', 200, { taskId: 'gh:20' }],
    [issue, '#30', 200, { taskId: 'gh:30' }],
    [issue, 'HIVE-1', 200, { taskId: 'local:1' }],
    [issue, '#99', 200, { url: 'https://github.com/acme/app/issues/99' }],
    [issue, 'HIVE-9', 404, NO_REF],
    [own, '#99', 404, NO_REF],
    [shell, '#20', 200, { taskId: 'gh:20' }],
    [shell, '#99', 404, NO_REF],
    [`/activities/${savedActivityId(99)}/open-ref`, '#20', 404, { error: 'atividade desconhecida' }],
    ['/activities/local%3Asite/open-ref', '#20', 404, { error: 'atividade desconhecida' }],
  ];
  for (const [path, ref, status, body] of answers) {
    const res = await postJson(`${f.base}${path}`, { ref });
    assert.equal(res.status, status, `${path} ${ref}`);
    assert.deepEqual(await res.json(), body, `${path} ${ref}`);
  }
  for (const bad of [undefined, '', '#', '#x', '#1 ', 'UTF 8', '-1', 12]) {
    const res = await postJson(`${f.base}${issue}`, { ref: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), BAD_REF, JSON.stringify(bad));
  }
  assert.deepEqual(f.calls.filter((call) => !call.includes('get-url')), [], 'nothing runs but reading the origin');
  // a terminal with no GitHub repository of its own falls back to its workspace's origin, when that is on GitHub
  f.setOrigin('git@github.com:acme/site.git');
  for (const path of [own, shell]) {
    const res = await postJson(`${f.base}${path}`, { ref: '#99' });
    assert.deepEqual(await res.json(), { url: 'https://github.com/acme/site/issues/99' }, path);
  }
  assert.deepEqual(f.calls.at(-1), ['git', '-C', f.repo, 'remote', 'get-url', 'origin']);
  f.fail('not a git repository');
  assert.equal((await postJson(`${f.base}${own}`, { ref: '#99' })).status, 404, 'a failing git leaves no repository');
});

test('POST /activities/:id/open-file is gone with the IDE: 404, and nothing runs (#818)', async (t) => {
  const f = await startFiles(t);
  assert.equal((await postJson(`${f.base}${workPath(f.server, 'local:1')}/open-file`, { path: 'docs/spec.md' })).status, 404);
  assert.deepEqual(f.calls, []);
});
