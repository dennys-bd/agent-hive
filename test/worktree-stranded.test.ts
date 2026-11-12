import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { slugFor } from '../src/tasks.js';
import type { Activity, Exec, Task } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { isStranded, strandedRepo, worktreeRepo } from '../src/worktree-stranded.js';
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
