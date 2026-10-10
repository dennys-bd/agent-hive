import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileHash, parseDiff } from '../src/diff.js';
import { EMPTY_REVIEW, reviewPath } from '../src/review-store.js';
import type { Exec, ReviewFile } from '../src/types.js';
import { hiveFetch } from './secret-client.js';
import { DIFF_TEXT, reviewEventDuring, send, SESSION_A, SESSION_OTHER, startReviews } from './review-server.js';
import { tempDir } from './temp-dir.js';
import { workPath } from './fixtures/work.js';

const H1 = 'a'.repeat(64);
const onDisk = async (home: string, id: string): Promise<ReviewFile> => JSON.parse(await readFile(reviewPath(home, id), 'utf8')) as ReviewFile;
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i += 1) await sleep(10);
  assert.ok(await check(), 'condition not met in time');
}

test('GET /tasks/:id/review answers the task\'s file, empty before any write, and 404 for an unknown task (#591)', async (t) => {
  const { base } = await startReviews(t);
  const res = await hiveFetch(`${base}/tasks/local%3A1/review`);
  assert.deepEqual([res.status, await res.json()], [200, EMPTY_REVIEW]);
  const unknown = await hiveFetch(`${base}/tasks/local%3A9/review`);
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'tarefa desconhecida' }]);
});

test('POST /review/reviewed marks and unmarks a file, broadcasting a named review event each time, and refuses a bad body (#591)', async (t) => {
  const { base, home } = await startReviews(t);
  const mark = { scope: 'worktree', path: 'a.txt', hash: H1, reviewed: true };
  const event = await reviewEventDuring(base, () => send(base, 'POST', '/tasks/local%3A1/review/reviewed', mark));
  assert.deepEqual(event, { type: 'review', taskId: 'local:1' });
  assert.deepEqual((await onDisk(home, 'local:1')).reviewed, [{ scope: 'worktree', path: 'a.txt', hash: H1 }]);
  assert.equal((await send(base, 'POST', '/tasks/local%3A1/review/reviewed', { ...mark, reviewed: false })).status, 200);
  assert.deepEqual((await onDisk(home, 'local:1')).reviewed, []);
  for (const bad of [{ ...mark, scope: 'all' }, { ...mark, path: '' }, { ...mark, hash: 'x' }, { ...mark, reviewed: 'yes' }]) {
    const res = await send(base, 'POST', '/tasks/local%3A1/review/reviewed', bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal((await send(base, 'POST', '/tasks/local%3A9/review/reviewed', mark)).status, 404);
});

test('GET /activities/:id/diff drops the scope\'s marks whose hash changed, and keeps a matching one and other scopes\' (#591)', async (t) => {
  const { base, home, server } = await startReviews(t);
  const hash = fileHash(parseDiff(DIFF_TEXT)[0]);
  for (const [scope, value] of [['worktree', H1], ['stage', H1]] as const) await send(base, 'POST', '/tasks/local%3A1/review/reviewed', { scope, path: 'a.txt', hash: value, reviewed: true });
  assert.equal((await hiveFetch(`${base}${workPath(server, 'local:1')}/diff?scope=worktree`)).status, 200);
  await until(async () => (await onDisk(home, 'local:1')).reviewed.length === 1);
  assert.deepEqual((await onDisk(home, 'local:1')).reviewed.map((m) => m.scope), ['stage']);
  await send(base, 'POST', '/tasks/local%3A1/review/reviewed', { scope: 'worktree', path: 'a.txt', hash, reviewed: true });
  await hiveFetch(`${base}${workPath(server, 'local:1')}/diff?scope=worktree`);
  await sleep(50);
  assert.equal((await onDisk(home, 'local:1')).reviewed.length, 2, 'the matching mark stays');
});

test('a slow older diff answering after a newer one never drops a mark made against the newer one (#591)', async (t) => {
  const index = join(await tempDir(t, 'index-'), 'index');
  await writeFile(index, 'the real index');
  const newer = DIFF_TEXT.replace('+two', '+three');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let diffs = 0;
  const exec: Exec = async (_file, args) => {
    if (args.includes('--git-path')) return { stdout: `${index}\n` };
    if (args.includes('merge-base')) return { stdout: `${'a'.repeat(40)}\n` };
    if (!args.includes('diff')) return { stdout: '' };
    diffs += 1;
    if (diffs > 1) return { stdout: newer };
    await gate;
    return { stdout: DIFF_TEXT };
  };
  const { base, home, server } = await startReviews(t, { exec });
  const older = hiveFetch(`${base}${workPath(server, 'local:1')}/diff?scope=worktree`);
  while (diffs === 0) await sleep(5);
  assert.equal((await hiveFetch(`${base}${workPath(server, 'local:1')}/diff?scope=worktree`)).status, 200);
  const hash = fileHash(parseDiff(newer)[0]);
  await send(base, 'POST', '/tasks/local%3A1/review/reviewed', { scope: 'worktree', path: 'a.txt', hash, reviewed: true });
  release();
  assert.equal((await older).status, 200);
  await sleep(50);
  assert.deepEqual((await onDisk(home, 'local:1')).reviewed, [{ scope: 'worktree', path: 'a.txt', hash }]);
});

test('a task that leaves the State takes its review file with it (#591)', async (t) => {
  const { base, home } = await startReviews(t);
  await send(base, 'POST', '/tasks/local%3A2/review/reviewed', { scope: 'worktree', path: 'a.txt', hash: H1, reviewed: true });
  assert.equal((await send(base, 'POST', '/tasks/local%3A2/close')).status, 200);
  await until(() => access(reviewPath(home, 'local:2')).then(() => false, () => true));
});

const ANCHOR = { scope: 'worktree', path: 'a.txt', side: 'new', start: 1, end: 1, excerpt: ['two'] };

test('drafts are added, edited and removed; the default session is set and cleared; refusals as for a comment (#591)', async (t) => {
  const { base, home } = await startReviews(t);
  const res = await send(base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: ANCHOR, text: 'look', session: SESSION_A });
  const { id } = await res.json() as { id: string };
  assert.deepEqual((await onDisk(home, 'local:1')).drafts, [{ id, anchor: ANCHOR, session: SESSION_A, text: 'look' }]);
  assert.equal((await send(base, 'PUT', `/tasks/local%3A1/review/drafts/${id}`, { text: 'again', session: 'new' })).status, 200);
  assert.deepEqual((await onDisk(home, 'local:1')).drafts.map((d) => [d.text, d.session]), [['again', 'new']]);
  const missing = await send(base, 'PUT', '/tasks/local%3A1/review/drafts/D9', { text: 'x', session: 'new' });
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'rascunho desconhecido' }]);
  assert.equal((await send(base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: ANCHOR, text: 'x', session: SESSION_OTHER })).status, 400);
  assert.equal((await send(base, 'DELETE', `/tasks/local%3A1/review/drafts/${id}`, undefined, false)).status, 403, 'the CSRF gate');
  assert.equal((await send(base, 'DELETE', `/tasks/local%3A1/review/drafts/${id}`)).status, 200);
  assert.deepEqual((await onDisk(home, 'local:1')).drafts, []);
  assert.equal((await send(base, 'PUT', '/tasks/local%3A1/review/default-session', { session: SESSION_A })).status, 200);
  assert.equal((await onDisk(home, 'local:1')).defaultSession, SESSION_A);
  assert.equal((await send(base, 'PUT', '/tasks/local%3A1/review/default-session', { session: null })).status, 200);
  assert.equal((await onDisk(home, 'local:1')).defaultSession, undefined);
  assert.equal((await send(base, 'PUT', '/tasks/local%3A1/review/default-session', { session: SESSION_OTHER })).status, 400);
});
