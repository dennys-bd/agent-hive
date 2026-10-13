import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { addDraft, appendMessage, convertDrafts, createReviewStore, droppedReviews, dropStaleMarks, EMPTY_REVIEW, markAgentResolved, markReviewed, nextPin, pinned, removeDraft, replyTarget, resolve, reviewPath, setDefaultSession, settleMessage, startThread, updateDraft } from '../src/review-store.js';
import { chipText } from '../src/review-message.js';
import { initialState } from '../src/orchestrator.js';
import type { Task, ReviewFile } from '../src/types.js';
import { tempDir } from './temp-dir.js';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const frozen = (file: ReviewFile): ReviewFile => JSON.parse(JSON.stringify(file), (_k, v: unknown) => (typeof v === 'object' && v !== null ? Object.freeze(v) : v)) as ReviewFile;

test('markReviewed marks a file of a scope once, replacing its hash, and unmarks it; the input is never touched (#591)', () => {
  const one = markReviewed(frozen(EMPTY_REVIEW), { scope: 'worktree', path: 'a.ts', hash: H1 }, true);
  const again = markReviewed(frozen(one), { scope: 'worktree', path: 'a.ts', hash: H2 }, true);
  assert.deepEqual(again.reviewed, [{ scope: 'worktree', path: 'a.ts', hash: H2 }]);
  const other = markReviewed(frozen(again), { scope: 'stage', path: 'a.ts', hash: H1 }, true);
  assert.equal(other.reviewed.length, 2, 'per scope');
  assert.deepEqual(markReviewed(frozen(other), { scope: 'worktree', path: 'a.ts', hash: H2 }, false).reviewed, [{ scope: 'stage', path: 'a.ts', hash: H1 }]);
});

test('dropStaleMarks drops the scope\'s marks whose file changed or left the diff, keeps the rest, and answers the same file when none goes (#591)', () => {
  const file = frozen({ ...EMPTY_REVIEW, reviewed: [
    { scope: 'worktree', path: 'a.ts', hash: H1 }, { scope: 'worktree', path: 'b.ts', hash: H1 }, { scope: 'worktree', path: 'gone.ts', hash: H1 }, { scope: 'stage', path: 'a.ts', hash: H1 },
  ] });
  const dropped = dropStaleMarks(file, 'worktree', [{ path: 'a.ts', hash: H1 }, { path: 'b.ts', hash: H2 }]);
  assert.deepEqual(dropped.reviewed.map((m) => `${m.scope}:${m.path}`), ['worktree:a.ts', 'stage:a.ts']);
  assert.equal(dropStaleMarks(dropped, 'worktree', [{ path: 'a.ts', hash: H1 }]), dropped);
});

test('the store reads a missing file as empty, writes atomically under reviews/, keeps two queued edits of one task, and removes it (#591)', async (t) => {
  const home = await tempDir(t, 'reviews-');
  const store = createReviewStore(home, () => true);
  assert.deepEqual(await store.read('local:1'), EMPTY_REVIEW);
  await Promise.all([
    store.update('local:1', (f) => markReviewed(f, { scope: 'worktree', path: 'a.ts', hash: H1 }, true)),
    store.update('local:1', (f) => markReviewed(f, { scope: 'worktree', path: 'b.ts', hash: H1 }, true)),
  ]);
  assert.deepEqual((await store.read('local:1')).reviewed.map((m) => m.path), ['a.ts', 'b.ts']);
  const path = reviewPath(home, 'local:1');
  assert.ok(path.endsWith('reviews/local%3A1.json'));
  assert.deepEqual(await readdir(dirname(path)), ['local%3A1.json'], 'no temp file left');
  await store.remove('local:1');
  assert.deepEqual(await store.read('local:1'), EMPTY_REVIEW);
  await store.remove('local:1'); // nothing to remove: no throw
});

test('an edit landing after its task left the State writes nothing, so a late write never brings its file back (#591)', async (t) => {
  const home = await tempDir(t, 'reviews-');
  let isLive = true;
  const store = createReviewStore(home, (itemId) => isLive && itemId === 'local:1');
  await store.update('local:1', (f) => markReviewed(f, { scope: 'worktree', path: 'a.ts', hash: H1 }, true));
  isLive = false;
  await store.remove('local:1');
  const late = await store.update('local:1', (f) => markReviewed(f, { scope: 'worktree', path: 'b.ts', hash: H1 }, true));
  assert.deepEqual(late.reviewed.map((m) => m.path), ['b.ts'], 'the edit still answers');
  await assert.rejects(readFile(reviewPath(home, 'local:1'), 'utf8'), { code: 'ENOENT' });
});

test('droppedReviews names the tasks a reduction dropped, but none a stage change dropped, which the next poll brings back (#591)', () => {
  const task = (itemId: string): Task => ({ item: { itemId, id: itemId, title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true });
  const prev = { ...initialState(0), tasks: [task('work:1'), task('local:2'), task('local:3')] };
  const next = { ...prev, tasks: [task('local:3')] };
  assert.deepEqual(droppedReviews(prev, next, { type: 'closeTask', taskId: 'work:1' }), ['work:1', 'local:2']);
  assert.deepEqual(droppedReviews(prev, next, { type: 'setStages', stages: [], transitions: [] }), []);
  assert.deepEqual(droppedReviews(prev, prev, { type: 'tick' }), []);
});

test('a file that is not a review file is refused, never overwritten (#591)', async (t) => {
  const home = await tempDir(t, 'reviews-');
  const path = reviewPath(home, 'local:1');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"reviewed": 3}');
  const store = createReviewStore(home, () => true);
  await assert.rejects(store.read('local:1'), /not a review file/);
  await assert.rejects(store.update('local:1', (f) => f), /not a review file/);
  assert.equal(await readFile(path, 'utf8'), '{"reviewed": 3}');
});

const ANCHOR = { scope: 'worktree' as const, path: 'a.ts', side: 'new' as const, start: 1, end: 1, excerpt: ['x'] };
const user = (id: string, pending: string[]) => ({ id, author: 'user' as const, at: 'T', text: 'why?', pending });

test('startThread, appendMessage (which reopens), settleMessage and resolve answer new files (#591)', () => {
  const started = startThread(frozen(EMPTY_REVIEW), { id: 'T1', anchor: ANCHOR, participants: [], messages: [user('M1', ['s1', 'new'])] });
  const settled = settleMessage(frozen(started), 'T1', 'M1', { delivered: [{ asked: 'new', session: 's2' }], failed: ['s1'] });
  assert.deepEqual(settled.threads[0].participants, ['s2']);
  assert.deepEqual(settled.threads[0].messages[0], { ...user('M1', ['s1']), to: ['s2'], failed: true });
  const retried = settleMessage(frozen(settled), 'T1', 'M1', { delivered: [{ asked: 's1', session: 's1' }], failed: [] });
  assert.deepEqual([retried.threads[0].participants, retried.threads[0].messages[0].to, retried.threads[0].messages[0].failed, retried.threads[0].messages[0].pending], [['s2', 's1'], ['s2', 's1'], undefined, undefined]);
  const closed = resolve(frozen(retried), 'T1', true);
  assert.equal(closed.threads[0].resolved, true);
  assert.equal(resolve(frozen(closed), 'T1', false).threads[0].resolved, undefined);
  const reopened = appendMessage(frozen(closed), 'T1', { id: 'M2', author: { session: 's1' }, at: 'T', text: 'because' });
  assert.deepEqual([reopened.threads[0].resolved, reopened.threads[0].messages.length], [undefined, 2]);
});

test('replyTarget is the last session that replied, else the first participant (#591)', () => {
  const thread = { id: 'T1', anchor: ANCHOR, participants: ['s1', 's2'], messages: [{ ...user('M1', []), to: ['s1', 's2'] }] };
  assert.equal(replyTarget(thread), 's1');
  assert.equal(replyTarget({ ...thread, messages: [...thread.messages, { id: 'M2', author: { session: 's2' }, at: 'T', text: 'x' }] }), 's2');
  assert.equal(replyTarget({ ...thread, participants: [], messages: [user('M1', ['new'])] }), undefined);
});

test('draft edits, the default session and convertDrafts answer new files (#591)', () => {
  const draft = { id: 'D1', anchor: ANCHOR, session: 's1', text: 'a' };
  const added = addDraft(frozen(EMPTY_REVIEW), draft);
  assert.deepEqual(updateDraft(frozen(added), 'D1', { text: 'b', session: 'new' }).drafts, [{ ...draft, text: 'b', session: 'new' }]);
  assert.deepEqual(removeDraft(frozen(added), 'D1').drafts, []);
  assert.equal(setDefaultSession(frozen(added), 's1').defaultSession, 's1');
  assert.equal('defaultSession' in setDefaultSession(frozen({ ...added, defaultSession: 's1' }), undefined), false);
  const converted = convertDrafts(frozen(added), [{ draft, threadId: 'T1', messageId: 'M1' }], 's9', 'AT');
  assert.deepEqual(converted.drafts, []);
  assert.deepEqual(converted.threads, [{ id: 'T1', anchor: ANCHOR, participants: ['s9'], received: { s9: 'M1' }, messages: [{ id: 'M1', author: 'user', at: 'AT', text: 'a', to: ['s9'] }] }]);
});

test('convertDrafts keeps a draft\'s chip: a draft whose text holds its session\'s chip becomes a message mentioning it (#591)', () => {
  const draft = { id: 'D1', anchor: ANCHOR, session: 'new', text: `look ${chipText('new')}` };
  const converted = convertDrafts(frozen(addDraft(EMPTY_REVIEW, draft)), [{ draft, threadId: 'T1', messageId: 'M1' }], 's9', 'AT');
  assert.deepEqual(converted.threads[0].messages[0], { id: 'M1', author: 'user', at: 'AT', text: draft.text, to: ['s9'], mentions: ['new'] });
});

test('settleMessage marks what each reached session received, never moving back; a failed one is marked nothing (#591)', () => {
  const thread = { id: 'T1', anchor: ANCHOR, participants: [], messages: [user('M1', ['s1', 'new']), user('M2', ['s1'])] };
  const first = settleMessage(frozen(startThread(EMPTY_REVIEW, thread)), 'T1', 'M2', { delivered: [{ asked: 's1', session: 's1' }], failed: [] });
  assert.deepEqual(first.threads[0].received, { s1: 'M2' });
  const older = settleMessage(frozen(first), 'T1', 'M1', { delivered: [{ asked: 's1', session: 's1' }, { asked: 'new', session: 's2' }], failed: [] });
  assert.deepEqual(older.threads[0].received, { s1: 'M2', s2: 'M1' }, 'a retry of an older message keeps the later mark; a new session is marked by its id');
  const failed = settleMessage(frozen(startThread(EMPTY_REVIEW, thread)), 'T1', 'M1', { delivered: [], failed: ['s1', 'new'] });
  assert.equal(failed.threads[0].received, undefined);
});

test('convertDrafts marks each conversation\'s first message received by the session it reached (#591)', () => {
  const draft = { id: 'D1', anchor: ANCHOR, session: 'new', text: 'a' };
  const converted = convertDrafts(frozen(addDraft(EMPTY_REVIEW, draft)), [{ draft, threadId: 'T1', messageId: 'M1' }], 's9', 'AT');
  assert.deepEqual(converted.threads[0].received, { s9: 'M1' });
});

const design = (pin: number, path = 'd/home.hv.html') => ({ path, viewport: 1280 as const, theme: 'dark' as const, tweaks: {}, pin, kind: 'area' as const, rect: { x: 0, y: 0, width: 1, height: 1 } });

test('nextPin is the highest pin among the path\'s design drafts and threads plus one: gaps kept, other paths and line anchors apart (#111)', () => {
  assert.equal(nextPin(EMPTY_REVIEW, 'd/home.hv.html'), 1);
  const file: ReviewFile = {
    ...EMPTY_REVIEW,
    drafts: [{ id: 'D1', anchor: design(1), session: 's1', text: 'a' }, { id: 'D2', anchor: ANCHOR, session: 's1', text: 'b' }],
    threads: [{ id: 'T1', anchor: design(4), participants: [], messages: [] }, { id: 'T2', anchor: design(9, 'd/other.hv.html'), participants: [], messages: [] }],
  };
  assert.equal(nextPin(file, 'd/home.hv.html'), 5, 'pins 2 and 3 are gaps, never reused');
  assert.equal(nextPin(file, 'd/other.hv.html'), 10);
  assert.equal(nextPin(file, 'a.ts'), 1, 'a line anchor has no pin');
});

test('pinned gives a design anchor its path\'s next pin and leaves a line anchor as it is (#111)', () => {
  const { pin: _pin, ...unpinned } = design(0);
  const file = addDraft(EMPTY_REVIEW, { id: 'D1', anchor: design(2), session: 's1', text: 'a' });
  assert.deepEqual(pinned(frozen(file), unpinned), design(3));
  assert.equal(pinned(frozen(file), ANCHOR), ANCHOR);
});

test('the agent-resolved mark: set on an open thread and replaced, kept by resolve(true), dropped by resolve(false) and by a new message (#111)', () => {
  const thread = { id: 'T1', anchor: design(1), participants: ['s1'], messages: [user('M1', [])] };
  const marked = markAgentResolved(frozen(startThread(EMPTY_REVIEW, thread)), 'T1', 's1', 'AT1');
  assert.deepEqual([marked.threads[0].agentResolved, marked.threads[0].resolved], [{ session: 's1', at: 'AT1' }, undefined]);
  assert.deepEqual(markAgentResolved(frozen(marked), 'T1', 's2', 'AT2').threads[0].agentResolved, { session: 's2', at: 'AT2' });
  const confirmed = resolve(frozen(marked), 'T1', true);
  assert.deepEqual([confirmed.threads[0].resolved, confirmed.threads[0].agentResolved], [true, { session: 's1', at: 'AT1' }]);
  assert.deepEqual(markAgentResolved(frozen(confirmed), 'T1', 's2', 'AT2').threads, confirmed.threads, 'a resolved thread is not marked');
  const reopened = resolve(frozen(confirmed), 'T1', false).threads[0];
  assert.deepEqual([reopened.resolved, reopened.agentResolved], [undefined, undefined]);
  const replied = appendMessage(frozen(marked), 'T1', { id: 'M2', author: 'user', at: 'T', text: 'not yet' }).threads[0];
  assert.deepEqual([replied.agentResolved, replied.messages.length], [undefined, 2]);
});

test('convertDrafts carries a design draft\'s anchor, pin included (#111)', () => {
  const draft = { id: 'D1', anchor: design(3), session: 's1', text: 'a' };
  const converted = convertDrafts(frozen(addDraft(EMPTY_REVIEW, draft)), [{ draft, threadId: 'T1', messageId: 'M1' }], 's1', 'AT');
  assert.deepEqual(converted.threads[0].anchor, design(3));
});

test('a stored file whose design anchor has no tweaks reads back with tweaks {}; a line anchor is untouched (#241)', async (t) => {
  const home = await tempDir(t, 'reviews-');
  const { tweaks: _tweaks, ...old } = design(1);
  const file = { reviewed: [], drafts: [{ id: 'D1', anchor: old, session: 's1', text: 'a' }, { id: 'D2', anchor: ANCHOR, session: 's1', text: 'b' }], threads: [{ id: 'T1', anchor: old, participants: [], messages: [] }] };
  await mkdir(dirname(reviewPath(home, 'local:1')), { recursive: true });
  await writeFile(reviewPath(home, 'local:1'), JSON.stringify(file));
  const read = await createReviewStore(home, () => true).read('local:1');
  assert.deepEqual(read.drafts[0].anchor, design(1));
  assert.deepEqual(read.drafts[1].anchor, ANCHOR);
  assert.deepEqual(read.threads[0].anchor, design(1));
});
