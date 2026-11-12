import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { slugFor } from '../src/tasks.js';
import type { Activity, Config, Exec, State, Task } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { isStranded, strandedRepo, strandedRows, worktreeRepo } from '../src/worktree-stranded.js';
import { withWork } from './fixtures/work.js';
import { tempDir } from './temp-dir.js';

// #746: the repo a removed workspace's worktree belongs to, read from the path and confirmed by one git listing.

const task = { item: { itemId: 'board:I1', id: '1', title: 'From ready', body: '', url: '' }, boardColumn: 'Ready' } as Task;
const SLUG = slugFor(task.item);
const activityAt = (worktree: string | undefined, extra: Partial<Activity> = {}): Activity => ({ id: 'a1', kind: 'task', workspace: 'gone', slug: SLUG, ...(worktree === undefined ? {} : { worktree }), ...extra });
const listing = (repo: string, slugs: string[]): string => [`worktree ${repo}\nHEAD 1\n`, ...slugs.map((slug) => `worktree ${worktreePath(repo, slug)}\nHEAD 2\n`)].join('\n');
const fakeExec = (stdout: string | Error): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (stdout instanceof Error) throw stdout;
    return { stdout };
  };
  return { exec, calls };
};

test('isStranded is true when the activity\'s workspace names none in the Comb', () => {
  const config = { comb: { workspaces: [{ name: 'live' }] } } as Parameters<typeof isStranded>[0];
  assert.equal(isStranded(config, { workspace: 'live' }), false);
  assert.equal(isStranded(config, { workspace: 'gone' }), true);
});

test('worktreeRepo cuts the repo off a path that ends exactly at .hive/worktrees/<slug>, whichever the platform', () => {
  assert.equal(worktreeRepo(activityAt(`/work/repo/.hive/worktrees/${SLUG}`), task, 'linux'), '/work/repo');
  assert.equal(worktreeRepo(activityAt(`C:\\work\\repo\\.hive\\worktrees\\${SLUG}`), task, 'win32'), 'C:\\work\\repo');
  assert.equal(worktreeRepo(activityAt(`C:/work/repo/.hive/worktrees/${SLUG}`), task, 'win32'), 'C:\\work\\repo');
  assert.equal(worktreeRepo({ ...activityAt(`/r/.hive/worktrees/hive-1-other`), slug: undefined }, { ...task, item: { ...task.item, title: 'other' } }, 'linux'), '/r', 'the slug falls back to the task title\'s');
});

test('worktreeRepo answers undefined for any other shape', () => {
  const shapes = [
    `/work/repo/.hive/worktrees/${SLUG}/`, `/work/repo/.hive/worktrees/${SLUG}/sub`, `/work/repo/.hive/worktrees/${SLUG}x`, `/work/repo/.hive/worktrees/hive-9-else`,
    `/work/repo/worktrees/${SLUG}`, `/work/repo/.hive/${SLUG}`, `/work/a/.hive/worktrees/b/../../../repo/.hive/worktrees/${SLUG}`, `/work/repo/./.hive/worktrees/${SLUG}`, `.hive/worktrees/${SLUG}`, `relative/.hive/worktrees/${SLUG}`, `/.hive/worktrees/${SLUG}`, '',
  ];
  for (const shape of shapes) assert.equal(worktreeRepo(activityAt(shape), task, 'linux'), undefined, shape);
  assert.equal(worktreeRepo(activityAt(undefined), task, 'linux'), undefined);
  assert.equal(worktreeRepo(activityAt(`/work/repo/.hive/worktrees/${SLUG}`, { local: true }), task, 'linux'), undefined);
});

test('strandedRepo confirms the repo when git lists the slug\'s worktree', async (t) => {
  const repo = await tempDir(t, 'stranded-');
  await mkdir(join(repo, '.git'));
  const worktree = worktreePath(repo, SLUG);
  await mkdir(worktree, { recursive: true });
  const { exec, calls } = fakeExec(listing(repo, [SLUG]));
  assert.deepEqual(await strandedRepo(activityAt(worktree), task, exec), { repo });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['-C', repo, '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain']);
});

test('strandedRepo does not confirm a folder git does not list while the folder is on disk', async (t) => {
  const repo = await tempDir(t, 'stranded-');
  await mkdir(join(repo, '.git'));
  const worktree = worktreePath(repo, SLUG);
  await mkdir(worktree, { recursive: true });
  assert.equal(await strandedRepo(activityAt(worktree), task, fakeExec(listing(repo, [])).exec), undefined);
});

test('strandedRepo confirms a worktree folder already gone from disk when git answers in the repo', async (t) => {
  const repo = await tempDir(t, 'stranded-');
  await mkdir(join(repo, '.git'));
  await mkdir(join(repo, '.hive', 'worktrees'), { recursive: true });
  assert.deepEqual(await strandedRepo(activityAt(worktreePath(repo, SLUG)), task, fakeExec(listing(repo, [])).exec), { repo });
});

test('strandedRepo answers undefined on a git failure', async (t) => {
  const repo = await tempDir(t, 'stranded-');
  await mkdir(join(repo, '.git'));
  const { exec } = fakeExec(new Error('fatal: not a git repository'));
  assert.equal(await strandedRepo(activityAt(worktreePath(repo, SLUG)), task, exec), undefined);
});

test('strandedRepo runs no git for a repo folder that is gone or a path of another shape', async (t) => {
  const repo = await tempDir(t, 'stranded-');
  await mkdir(join(repo, '.git'));
  const { exec, calls } = fakeExec(listing(repo, [SLUG]));
  assert.equal(await strandedRepo(activityAt(worktreePath(join(repo, 'missing'), SLUG)), task, exec), undefined);
  assert.equal(await strandedRepo(activityAt(join(repo, 'elsewhere')), task, exec), undefined);
  assert.deepEqual(calls, []);
});

test('strandedRepo runs no git in a repo folder with no .git of its own, which a parent repository would answer for', async (t) => {
  const repo = await tempDir(t, 'stranded-');
  const { exec, calls } = fakeExec(listing(repo, []));
  assert.equal(await strandedRepo(activityAt(worktreePath(repo, SLUG)), task, exec), undefined);
  assert.equal(calls.length, 0);
});

test('worktreeRepo refuses a . or .. slug and a UNC path on Windows', () => {
  for (const slug of ['.', '..']) assert.equal(worktreeRepo(activityAt(`/work/repo/.hive/worktrees/${slug}`, { slug }), task, 'linux'), undefined, slug);
  assert.equal(worktreeRepo(activityAt(`\\\\host\\share\\.hive\\worktrees\\${SLUG}`), task, 'win32'), undefined);
  assert.equal(worktreeRepo(activityAt(`C:\\work\\repo\\.hive\\worktrees\\${SLUG}`), task, 'win32'), 'C:\\work\\repo');
});

test('strandedRepo does not confirm a gone worktree in a repo the Hive never made worktrees in', async (t) => {
  const repo = await tempDir(t, 'stranded-');
  await mkdir(join(repo, '.git'));
  assert.equal(await strandedRepo(activityAt(worktreePath(repo, SLUG)), task, fakeExec(listing(repo, [])).exec), undefined);
});

// #747: GET /worktrees' rows of stranded task activities. `live` is the only workspace in the Comb. Git answers each repo's listing from
// `listings`; `failing` fails only listWorktrees' listing there, not strandedRepo's fsmonitor-off check; ls-files answers `ignored`, and
// every status one uncommitted file.
const CONFIG = { comb: { workspaces: [{ name: 'live' }] } } as Pick<Config, 'comb'>;
const taskN = (n: number, title: string): Task => ({ item: { itemId: `board:I${n}`, id: String(n), title, body: '', url: '' }, boardColumn: 'Ready' }) as Task;
const second = taskN(2, 'Second');
const third = taskN(3, 'Third');
const strandedState = (works: [Task, Partial<Activity>][]): State =>
  works.reduce((s, [t, work]) => withWork(s, t.item.itemId, work), { ...initialState(0), tasks: works.map(([t]) => t) });
const rowsExec = (listings: Record<string, string>, { failing, ignored = '' }: { failing?: string; ignored?: string } = {}): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (args.includes('ls-files')) return { stdout: ignored };
    if (args.includes('status')) return { stdout: ' M a.ts\n' };
    if (args[1] === failing && !args.includes('core.fsmonitor=false')) throw new Error('fatal: bad object');
    return { stdout: listings[args[1] ?? ''] ?? '' };
  };
  return { exec, calls };
};
// A repo folder with its own .git and a worktree folder per slug
async function repoWith(t: TestContext, slugs: string[]): Promise<string> {
  const repo = await tempDir(t, 'stranded-');
  await mkdir(join(repo, '.git'));
  for (const slug of slugs) await mkdir(worktreePath(repo, slug), { recursive: true });
  return repo;
}

test('strandedRows answers a stranded task activity\'s own worktree under its removed workspace, with its task, its nested status and workspaceGone; another worktree of the repo and a live workspace\'s activity answer none (#747)', async (t) => {
  const repo = await repoWith(t, [SLUG, 'hive-9-other']);
  await mkdir(join(repo, 'docs', '.git'), { recursive: true }); // a nested repo the stand-in detects
  await mkdir(join(worktreePath(repo, SLUG), 'docs', '.git'), { recursive: true });
  const state = strandedState([
    [task, { workspace: 'gone', slug: SLUG, worktree: worktreePath(repo, SLUG) }],
    [second, { workspace: 'live', slug: slugFor(second.item), worktree: worktreePath(repo, slugFor(second.item)) }],
  ]);
  const { exec } = rowsExec({ [repo]: listing(repo, [SLUG, 'hive-9-other']) }, { ignored: 'docs/\0' });
  const rows = await strandedRows(state, CONFIG, exec);
  assert.deepEqual(rows.map((r) => [r.workspace, r.slug, r.path, r.task?.id, r.task?.activityId, r.orphan, r.nested, r.workspaceGone]), [
    ['gone', SLUG, worktreePath(repo, SLUG), 'board:I1', 'a-board:I1', undefined, [{ path: 'docs', uncommitted: 1 }], true],
  ]);
});

test('strandedRows answers nothing and runs no git for a local stranded activity or one with no task (#747)', async (t) => {
  const repo = await repoWith(t, [SLUG, 'hive-9-kept']);
  const local = strandedState([[task, { workspace: 'gone', slug: SLUG, worktree: worktreePath(repo, SLUG), local: true }]]);
  const state = withWork(local, 'board:I9', { workspace: 'gone', slug: 'hive-9-kept', worktree: worktreePath(repo, 'hive-9-kept') }); // its task left (#861)
  const { exec, calls } = rowsExec({ [repo]: listing(repo, [SLUG, 'hive-9-kept']) });
  assert.deepEqual(await strandedRows(state, CONFIG, exec), []);
  assert.deepEqual(calls, []);
});

test('strandedRows drops only the rows of a stranded activity whose repo git does not confirm or whose listing fails (#747)', async (t) => {
  const kept = await repoWith(t, [SLUG]);
  const broken = await repoWith(t, [slugFor(second.item)]);
  const bare = await tempDir(t, 'stranded-'); // no .git of its own: never confirmed
  await mkdir(worktreePath(bare, slugFor(third.item)), { recursive: true });
  const state = strandedState([
    [task, { workspace: 'gone', slug: SLUG, worktree: worktreePath(kept, SLUG) }],
    [second, { workspace: 'old', slug: slugFor(second.item), worktree: worktreePath(broken, slugFor(second.item)) }],
    [third, { workspace: 'older', slug: slugFor(third.item), worktree: worktreePath(bare, slugFor(third.item)) }],
  ]);
  const { exec } = rowsExec({ [kept]: listing(kept, [SLUG]), [broken]: listing(broken, [slugFor(second.item)]) }, { failing: broken });
  assert.deepEqual((await strandedRows(state, CONFIG, exec)).map((r) => [r.workspace, r.slug]), [['gone', SLUG]]);
});
