import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchText, chipText, commentText, missed } from '../src/review-message.js';
import type { ReviewAnchor, ReviewMessage, ReviewThread } from '../src/types.js';

const ANCHOR: ReviewAnchor = { scope: 'worktree', path: 'src/a.ts', side: 'new', start: 3, end: 4, excerpt: ['const a = 1;', 'return a;'] };

test('commentText names the file, the lines and the conversation, fences the excerpt, then the text and the hive_reply line (#591)', () => {
  assert.equal(commentText(ANCHOR, 'T1', { text: 'why a?' }, 's1'), [
    'Review comment on src/a.ts, lines 3–4 (conversation T1):', '```', 'const a = 1;', 'return a;', '```', 'why a?', 'Answer with the hive_reply tool, thread "T1".',
  ].join('\n'));
  assert.match(commentText({ ...ANCHOR, end: 3, excerpt: ['x ``` y'] }, 'T2', { text: 'ok' }, 's1'), /line 3 \(conversation T2\):\n````\nx ``` y\n````/);
});

test('batchText holds one block per comment, each with its own thread id (#591)', () => {
  const text = batchText([{ anchor: ANCHOR, threadId: 'T1', text: 'one' }, { anchor: { ...ANCHOR, path: 'b.ts' }, threadId: 'T2', text: 'two' }], 's1');
  assert.equal(text, `${commentText(ANCHOR, 'T1', { text: 'one' }, 's1')}\n\n${commentText({ ...ANCHOR, path: 'b.ts' }, 'T2', { text: 'two' }, 's1')}`);
});

const SESSION = 'a3df29cc-1111-4111-8111-111111111111';

test('a chip is stored as the field writes it, @ an em space · and 4 characters, "new" for a new session (#591)', () => {
  assert.equal(chipText(SESSION), '@\u2003·a3df');
  assert.equal(chipText('new'), '@\u2003·new');
});

test('commentText writes each chip where it was as the agent and the id\'s first 8 characters, a new session as new session (#591)', () => {
  const text = commentText(ANCHOR, 'T1', { text: `ask ${chipText(SESSION)} and ${chipText('new')} why`, mentions: [SESSION, 'new'] }, SESSION);
  assert.match(text, /\nask @claude a3df29cc and @claude new session why\n/);
  assert.match(commentText(ANCHOR, 'T1', { text: `ask ${chipText(SESSION)}` }, SESSION), /ask @\u2003·a3df\n/, 'a chip only when the message mentions it');
});

test('with a mention, the header gets a Mentions line before the excerpt, (you) on the session receiving it; none without (#591)', () => {
  const OTHER = '3c91e0aa-2222-4222-8222-222222222222';
  const message = { text: `${chipText(SESSION)} ${chipText(OTHER)} look`, mentions: [SESSION, OTHER] };
  const [head, mentions, fence] = commentText(ANCHOR, 'T1', message, SESSION).split('\n');
  assert.deepEqual([head, mentions, fence], ['Review comment on src/a.ts, lines 3–4 (conversation T1):', 'Mentions: @claude a3df29cc (you), @claude 3c91e0aa', '```']);
  assert.equal(commentText(ANCHOR, 'T1', message, OTHER).split('\n')[1], 'Mentions: @claude a3df29cc, @claude 3c91e0aa (you)');
  assert.equal(commentText(ANCHOR, 'T1', { text: `${chipText('new')} hi`, mentions: ['new'] }, 'new').split('\n')[1], 'Mentions: @claude new session (you)');
  assert.doesNotMatch(commentText(ANCHOR, 'T1', { text: 'hi' }, SESSION), /Mentions:/);
});

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const said = (id: string, author: ReviewMessage['author'], extra: Partial<ReviewMessage> = {}): ReviewMessage => ({ id, author, at: `2026-09-29T10:0${id.slice(1)}:00.000Z`, text: `text ${id}`, ...extra });
const THREAD: ReviewThread = {
  id: 'T1', anchor: ANCHOR, participants: [A, B], received: { [A]: 'M1', [B]: 'M3' },
  messages: [said('M1', 'user', { to: [A] }), said('M2', { session: A }), said('M3', 'user', { to: [B] }), said('M4', { session: B }), said('M5', 'user', { failed: true, pending: [A] })],
};

test('missed: a session joining gets the whole thread; a later delivery only what it has not received, never its own replies (#591)', () => {
  assert.deepEqual(missed(THREAD, 'M5', 'new').map((m) => m.id), ['M1', 'M2', 'M3', 'M4'], 'a new session has received nothing');
  assert.deepEqual(missed({ ...THREAD, received: {} }, 'M5', B).map((m) => m.id), ['M1', 'M2'], 'nothing marked: never what was sent to it (M3) or its own reply (M4)');
  assert.deepEqual(missed(THREAD, 'M5', A).map((m) => m.id), ['M3', 'M4'], 'the user\'s message to B and B\'s reply; not A\'s own reply');
  assert.deepEqual(missed(THREAD, 'M5', B).map((m) => m.id), [], 'B got M3 and wrote M4');
  assert.deepEqual(missed(THREAD, 'M2', A).map((m) => m.id), [], 'a retry of an older message owes nothing past it');
  const inFlight = { ...THREAD, messages: [...THREAD.messages, said('M6', 'user', { failed: true, pending: [A] })] };
  assert.deepEqual(missed(inFlight, 'M6', A).map((m) => m.id), ['M3', 'M4'], 'M5 still owed to A goes by its own reenviar');
});

test('commentText puts the missed messages before the new one, each with its author and time (#591)', () => {
  const text = commentText(ANCHOR, 'T1', { text: 'and now?' }, A, missed(THREAD, 'M5', A));
  assert.equal(text, [
    'Review comment on src/a.ts, lines 3–4 (conversation T1):', '```', 'const a = 1;', 'return a;', '```',
    'Earlier in this conversation, not sent to you yet:', '[user, 2026-09-29T10:03:00.000Z]', 'text M3', '[@claude bbbbbbbb, 2026-09-29T10:04:00.000Z]', 'text M4',
    'New message:', 'and now?', 'Answer with the hive_reply tool, thread "T1".',
  ].join('\n'));
});
