import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../src/orchestrator.js';
import type { Deliver, Delivery } from '../src/review-deliver.js';
import { batchText, chipText, commentText } from '../src/review-message.js';
import { addDraft, appendMessage, createReviewStore, reviewPath, settleMessage, startThread } from '../src/review-store.js';
import type { LiveView } from '../src/server-tasks.js';
import { registerReviewThreadRoutes, type ThreadRouteDeps } from '../src/server-review-threads.js';
import type { Task, ReviewAnchor, ReviewFile } from '../src/types.js';
import { withWork } from './fixtures/work.js';
import { hiveFetch } from './secret-client.js';
import { send, SESSION_A, SESSION_B, SESSION_OTHER, startReviews } from './review-server.js';
import { tempDir } from './temp-dir.js';

const ANCHOR: ReviewAnchor = { scope: 'worktree', path: 'a.txt', side: 'new', start: 1, end: 1, excerpt: ['two'] };
const NEW_ID = 'dddddddd-4444-4444-8444-444444444444';

async function start(t: TestContext) {
  const delivered: { to: string; text: string }[] = [];
  const failing = new Set<string>();
  const deliverReview: Deliver = async (_taskId, to, text) => {
    delivered.push({ to, text });
    return failing.has(to) ? { ok: false, reason: 'boom' } : { ok: true, session: to === 'new' ? NEW_ID : to };
  };
  const hive = await startReviews(t, { deliverReview });
  const file = async (): Promise<ReviewFile> => JSON.parse(await readFile(reviewPath(hive.home, 'local:1'), 'utf8')) as ReviewFile;
  return { ...hive, delivered, failing, file };
}

test('POST /threads stores the conversation, delivers the comment to each recipient and makes them participants (#591)', async (t) => {
  const h = await start(t);
  const res = await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: ANCHOR, text: ' why? ', to: [SESSION_A, 'new'] });
  const answer = await res.json() as { thread: string; failed: string[] };
  assert.deepEqual([res.status, answer.failed], [200, []]);
  const [thread] = (await h.file()).threads;
  assert.deepEqual(thread.participants, [SESSION_A, NEW_ID]);
  assert.deepEqual([thread.messages[0].text, thread.messages[0].to, thread.messages[0].pending], ['why?', [SESSION_A, NEW_ID], undefined]);
  assert.deepEqual(h.delivered.map((d) => d.to), [SESSION_A, 'new']);
  assert.equal(h.delivered[0].text, commentText(ANCHOR, answer.thread, { text: 'why?' }, SESSION_A, () => 'claude'));
});

test('a failed delivery keeps the message failed with no participant; reenviar delivers it to that recipient only (#591)', async (t) => {
  const h = await start(t);
  h.failing.add(SESSION_A);
  const { thread } = await (await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: ANCHOR, text: 'why?', to: [SESSION_A] })).json() as { thread: string };
  const [stored] = (await h.file()).threads;
  assert.deepEqual([stored.participants, stored.messages[0].failed, stored.messages[0].pending], [[], true, [SESSION_A]]);
  h.failing.clear();
  const retry = await send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread}/messages/${stored.messages[0].id}/retry`);
  assert.equal(retry.status, 200);
  const [again] = (await h.file()).threads;
  assert.deepEqual([again.participants, again.messages.length, again.messages[0].failed], [[SESSION_A], 1, undefined]);
  assert.equal((await send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread}/messages/${stored.messages[0].id}/retry`)).status, 409);
});

test('a reply with no to goes to the reply target; resolve closes and a new message reopens (#591)', async (t) => {
  const h = await start(t);
  const { thread } = await (await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: ANCHOR, text: 'why?', to: [SESSION_B] })).json() as { thread: string };
  assert.equal((await send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread}/resolve`, { resolved: true })).status, 200);
  assert.equal((await h.file()).threads[0].resolved, true);
  assert.equal((await send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread}/messages`, { text: 'and?' })).status, 200);
  assert.deepEqual([h.delivered.at(-1)?.to, (await h.file()).threads[0].resolved, (await h.file()).threads[0].messages.length], [SESSION_B, undefined, 2]);
});

test('the conversation routes refuse an unknown task or conversation, a bad anchor, an empty or oversized text and another task\'s session (#591)', async (t) => {
  const h = await start(t);
  const post = (path: string, body: unknown) => send(h.base, 'POST', `/tasks/local%3A1/review${path}`, body);
  const unknown = await send(h.base, 'POST', '/tasks/local%3A9/review/threads', { anchor: ANCHOR, text: 'x', to: [SESSION_A] });
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'tarefa desconhecida' }]);
  for (const body of [
    { anchor: { ...ANCHOR, scope: 'all' }, text: 'x', to: [SESSION_A] }, { anchor: { ...ANCHOR, excerpt: [] }, text: 'x', to: [SESSION_A] },
    { anchor: ANCHOR, text: '  ', to: [SESSION_A] }, { anchor: ANCHOR, text: 'x'.repeat(10_001), to: [SESSION_A] },
    { anchor: ANCHOR, text: 'x', to: [SESSION_OTHER] }, { anchor: ANCHOR, text: 'x', to: [] },
  ]) assert.equal((await post('/threads', body)).status, 400, JSON.stringify(body).slice(0, 80));
  const missing = await post('/threads/T9/messages', { text: 'x' });
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'conversa desconhecida' }]);
  assert.equal((await post('/threads/T9/resolve', { resolved: true })).status, 404);
  assert.equal(h.delivered.length, 0); // not deepEqual: it would narrow delivered to never[]
});

test('submit sends each session its drafts in one message, turns them into conversations, keeps a failed session\'s drafts, and refuses with none (#591)', async (t) => {
  const h = await start(t);
  const draft = (text: string, session: string) => send(h.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: ANCHOR, text, session });
  await draft('one', SESSION_A);
  await draft('two', SESSION_A);
  await draft('three', SESSION_B);
  h.failing.add(SESSION_B);
  const res = await send(h.base, 'POST', '/tasks/local%3A1/review/submit');
  assert.deepEqual([res.status, await res.json()], [200, { failed: [SESSION_B] }]);
  assert.deepEqual(h.delivered.map((d) => d.to), [SESSION_A, SESSION_B]);
  const file = await h.file();
  assert.deepEqual(file.threads.map((th) => [th.messages[0].text, th.participants]), [['one', [SESSION_A]], ['two', [SESSION_A]]]);
  assert.equal(h.delivered[0].text, batchText(file.threads.map((th) => ({ anchor: th.anchor, threadId: th.id, text: th.messages[0].text })), SESSION_A, () => 'claude'));
  assert.deepEqual(file.drafts.map((d) => d.text), ['three']);
  h.failing.clear();
  await send(h.base, 'POST', '/tasks/local%3A1/review/submit');
  const none = await send(h.base, 'POST', '/tasks/local%3A1/review/submit');
  assert.deepEqual([none.status, await none.json()], [409, { error: 'nenhum rascunho para enviar' }]);
});

// A delivery held until release(): what a slow session looks like while a second request arrives
function held() {
  const started: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deliverReview: Deliver = async (_taskId, to): Promise<Delivery> => {
    started.push(to);
    await gate;
    return { ok: true, session: to };
  };
  return { started, release: () => release(), deliverReview };
}
const until = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 5));
};

test('a second submit while one is in flight is refused with 409, so the drafts are never sent twice (#591)', async (t) => {
  const h = held();
  const hive = await startReviews(t, { deliverReview: h.deliverReview });
  await send(hive.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: ANCHOR, text: 'one', session: SESSION_A });
  const first = send(hive.base, 'POST', '/tasks/local%3A1/review/submit');
  await until(() => h.started.length === 1);
  const second = await send(hive.base, 'POST', '/tasks/local%3A1/review/submit');
  assert.deepEqual([second.status, await second.json()], [409, { error: 'a revisão já está sendo enviada' }]);
  h.release();
  assert.equal((await first).status, 200);
  assert.deepEqual(h.started, [SESSION_A]);
});

test('a message is stored failed and pending while it goes out, and a retry of it then is refused with 409 (#591)', async (t) => {
  const h = held();
  const hive = await startReviews(t, { deliverReview: h.deliverReview });
  const file = async (): Promise<ReviewFile> => JSON.parse(await readFile(reviewPath(hive.home, 'local:1'), 'utf8')) as ReviewFile;
  const posted = send(hive.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: ANCHOR, text: 'why?', to: [SESSION_A] });
  await until(() => h.started.length === 1);
  const [thread] = (await file()).threads;
  assert.deepEqual([thread.messages[0].failed, thread.messages[0].pending], [true, [SESSION_A]]);
  const retry = await send(hive.base, 'POST', `/tasks/local%3A1/review/threads/${thread.id}/messages/${thread.messages[0].id}/retry`);
  assert.deepEqual([retry.status, await retry.json()], [409, { error: 'a mensagem já está sendo entregue' }]);
  h.release();
  assert.equal((await posted).status, 200);
  assert.deepEqual([(await file()).threads[0].messages[0].failed, h.started], [undefined, [SESSION_A]]);
});

const TASK = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true } satisfies Task;

// The thread routes alone over `deps` (a store that fails or lies), answering the base URL
function routesOver(t: TestContext, deps: Partial<ThreadRouteDeps> & Pick<ThreadRouteDeps, 'reviews'>): string {
  const app = express();
  app.use(express.json());
  registerReviewThreadRoutes(app, {
    requireLive: () => ({ state: withWork({ ...initialState(0), tasks: [TASK] }, 'local:1', {}, { sessions: [{ id: SESSION_A, startedAt: 'T', stages: ['fila'], agent: 'claude' as const, lastUsedAt: 'T' }] }), runtime: {} as LiveView['runtime'] }),
    notifyReview: () => undefined,
    log: { error: () => undefined, info: () => undefined, debug: () => undefined },
    deliver: async (_c, to) => ({ ok: true, session: to }),
    ...deps,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('a batch delivered whose conversations cannot be written is retried once, then answered unsaved and logged without its text (#591)', async (t) => {
  const store = createReviewStore(await tempDir(t, 'reviews-'), () => true);
  await store.update('local:1', (f) => addDraft(f, { id: 'D1', anchor: ANCHOR, session: SESSION_A, text: 'secret words' }));
  let failures = 0;
  const errors: string[] = [];
  const base = routesOver(t, {
    reviews: { ...store, update: async (id, edit) => { failures += 1; if (failures <= 2) throw new Error('disk full'); return store.update(id, edit); } },
    log: { error: (line) => errors.push(line), info: () => undefined, debug: () => undefined },
  });
  const res = await hiveFetch(`${base}/tasks/local%3A1/review/submit`, { method: 'POST' });
  assert.deepEqual([res.status, await res.json()], [200, { failed: [], unsaved: [SESSION_A] }]);
  assert.equal(failures, 2, 'written twice, then given up');
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes('secret words'));
});

test('a retry whose message another delivery settled since its first read is refused with 409 and delivers nothing (#591)', async (t) => {
  const store = createReviewStore(await tempDir(t, 'reviews-'), () => true);
  const message = { id: 'M1', author: 'user' as const, at: 'T', text: 'why?', failed: true as const, pending: [SESSION_A] };
  const stale = await store.update('local:1', (f) => startThread(f, { id: 'T1', anchor: ANCHOR, participants: [], messages: [message] }));
  await store.update('local:1', (f) => settleMessage(f, 'T1', 'M1', { delivered: [{ asked: SESSION_A, session: SESSION_A }], failed: [] }));
  const delivered: string[] = [];
  const base = routesOver(t, { reviews: { ...store, read: async () => stale }, deliver: async (_c, to) => { delivered.push(to); return { ok: true, session: to }; } });
  const res = await hiveFetch(`${base}/tasks/local%3A1/review/threads/T1/messages/M1/retry`, { method: 'POST' });
  assert.deepEqual([res.status, await res.json(), delivered], [409, { error: 'nada para reenviar' }, []]);
});

test('submit leaves out the sessions named in skip, and refuses a skip that is not a list of the task\'s sessions (#591)', async (t) => {
  const h = await start(t);
  await send(h.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: ANCHOR, text: 'one', session: SESSION_A });
  await send(h.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: ANCHOR, text: 'two', session: SESSION_B });
  assert.equal((await send(h.base, 'POST', '/tasks/local%3A1/review/submit', { skip: 'x' })).status, 400);
  assert.equal((await send(h.base, 'POST', '/tasks/local%3A1/review/submit', { skip: [SESSION_OTHER] })).status, 400);
  assert.deepEqual(await (await send(h.base, 'POST', '/tasks/local%3A1/review/submit', { skip: [SESSION_B] })).json(), { failed: [] });
  assert.deepEqual([h.delivered.map((d) => d.to), (await h.file()).drafts.map((d) => d.text)], [[SESSION_A], ['two']]);
  const none = await send(h.base, 'POST', '/tasks/local%3A1/review/submit', { skip: [SESSION_B] });
  assert.deepEqual([none.status, await none.json()], [409, { error: 'nenhum rascunho para enviar' }]);
});

test('mentions pick the recipients and are stored with the text, which keeps each chip where it was written (#591)', async (t) => {
  const h = await start(t);
  const text = `why ${chipText(SESSION_B)} and ${chipText('new')}?`;
  const res = await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: ANCHOR, text, mentions: [SESSION_B, 'new'] });
  const { thread } = await res.json() as { thread: string };
  assert.equal(res.status, 200);
  const [message] = (await h.file()).threads[0].messages;
  assert.deepEqual([message.text, message.mentions, message.to], [text, [SESSION_B, 'new'], [SESSION_B, NEW_ID]]);
  assert.deepEqual(h.delivered.map((d) => d.to), [SESSION_B, 'new']);
  assert.match(h.delivered[0].text, /\nwhy @claude bbbbbbbb and @claude new session\?\n/);
  assert.match(h.delivered[0].text, /\nMentions: @claude bbbbbbbb \(you\), @claude new session\n/, 'each recipient its own (you)');
  assert.match(h.delivered[1].text, /\nMentions: @claude bbbbbbbb, @claude new session \(you\)\n/);
  const reply = `${chipText(SESSION_A)} and you?`;
  assert.equal((await send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread}/messages`, { text: reply, mentions: [SESSION_A] })).status, 200);
  assert.deepEqual([h.delivered.at(-1)?.to, (await h.file()).threads[0].messages[1].mentions], [SESSION_A, [SESSION_A]]);
  for (const mentions of [[SESSION_OTHER], [], 'x']) {
    assert.equal((await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: ANCHOR, text: 'x', mentions })).status, 400, JSON.stringify(mentions));
  }
});

test('each delivery carries what that session has not received yet: all of it on joining, then only the missed messages, again on a retry (#591)', async (t) => {
  const h = await start(t);
  const store = createReviewStore(h.home, () => true);
  const agentSays = (session: string, text: string) => store.update('local:1', (f) => appendMessage(f, f.threads[0].id, { id: `R-${text}`, author: { session }, at: '2026-09-29T12:00:00.000Z', text }));
  const reply = (thread: string, text: string, mention: string) => send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread}/messages`, { text: `${chipText(mention)} ${text}`, mentions: [mention] });
  const { thread } = await (await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: ANCHOR, text: 'why?', to: [SESSION_A] })).json() as { thread: string };
  assert.doesNotMatch(h.delivered[0].text, /Earlier in this conversation/);
  await agentSays(SESSION_A, 'because');
  await reply(thread, 'agree?', SESSION_B);
  assert.match(h.delivered[1].text, /Earlier in this conversation, not sent to you yet:\n\[user, [^\]]+\]\nwhy\?\n\[@claude aaaaaaaa, [^\]]+\]\nbecause\nNew message:\n@claude bbbbbbbb agree\?\n/);
  await agentSays(SESSION_B, 'yes');
  h.failing.add(SESSION_A);
  await reply(thread, 'ok?', SESSION_A);
  const missedByA = /Earlier in this conversation, not sent to you yet:\n\[user, [^\]]+\]\n@claude bbbbbbbb agree\?\n\[@claude bbbbbbbb, [^\]]+\]\nyes\nNew message:\n@claude aaaaaaaa ok\?\n/;
  assert.match(h.delivered[2].text, missedByA, 'not why? nor its own because');
  assert.deepEqual((await h.file()).threads[0].received, { [SESSION_A]: (await h.file()).threads[0].messages[0].id, [SESSION_B]: (await h.file()).threads[0].messages[2].id }, 'the failure marked nothing');
  h.failing.clear();
  const failedId = (await h.file()).threads[0].messages[4].id;
  assert.equal((await send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread}/messages/${failedId}/retry`)).status, 200);
  assert.match(h.delivered[3].text, missedByA, 'the retry resends the missed set');
  await reply(thread, 'thanks', SESSION_A);
  assert.doesNotMatch(h.delivered[4].text, /Earlier in this conversation/, 'nothing is ever resent');
});

test('a batch marks each new conversation received by its session, so a reply after it carries only what came since (#591)', async (t) => {
  const h = await start(t);
  await send(h.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: ANCHOR, text: 'one', session: SESSION_A });
  await send(h.base, 'POST', '/tasks/local%3A1/review/submit');
  const [thread] = (await h.file()).threads;
  assert.deepEqual(thread.received, { [SESSION_A]: thread.messages[0].id });
  await createReviewStore(h.home, () => true).update('local:1', (f) => appendMessage(f, thread.id, { id: 'R1', author: { session: SESSION_B }, at: '2026-09-29T12:00:00.000Z', text: 'from b' }));
  await send(h.base, 'POST', `/tasks/local%3A1/review/threads/${thread.id}/messages`, { text: 'and?', to: [SESSION_A] });
  assert.match(h.delivered.at(-1)?.text ?? '', /not sent to you yet:\n\[@claude bbbbbbbb, [^\]]+\]\nfrom b\nNew message:\nand\?\n/);
  assert.doesNotMatch(h.delivered.at(-1)?.text ?? '', /\none\n/);
});

const DESIGN = { kind: 'area', path: 'agent/hive/designs/x/home.hv.html', viewport: 1280, theme: 'dark', tweaks: {}, rect: { x: 40, y: 120, width: 320, height: 180 } } as const;
const pinOf = (anchor: object): number | undefined => ('pin' in anchor ? (anchor.pin as number) : undefined);

test('submit kind design sends only the design drafts, one message numbered by pins; no kind sends only line drafts (#111)', async (t) => {
  const h = await start(t);
  const draft = (anchor: unknown, text: string) => send(h.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor, text, session: SESSION_A });
  await draft(DESIGN, 'one');
  await draft({ ...DESIGN, kind: 'element', selector: 'h1', text: 'Hi' }, 'two');
  await draft(ANCHOR, 'line');
  assert.equal((await send(h.base, 'POST', '/tasks/local%3A1/review/submit', { kind: 'pixels' })).status, 400);
  const res = await send(h.base, 'POST', '/tasks/local%3A1/review/submit', { kind: 'design' });
  assert.deepEqual([res.status, await res.json(), h.delivered.length], [200, { failed: [] }, 1]);
  assert.deepEqual(h.delivered[0].text.match(/^Design comment \d+ on \S+/gm), [`Design comment 1 on ${DESIGN.path}`, `Design comment 2 on ${DESIGN.path}`]);
  const file = await h.file();
  assert.deepEqual([file.drafts.map((d) => d.text), file.threads.map((th) => pinOf(th.anchor))], [['line'], [1, 2]]);
  const none = await send(h.base, 'POST', '/tasks/local%3A1/review/submit', { kind: 'design' });
  assert.deepEqual([none.status, await none.json()], [409, { error: 'nenhum rascunho para enviar' }]);
  await draft(DESIGN, 'three');
  assert.equal(pinOf((await h.file()).drafts.at(-1)!.anchor), 3, 'the sent comments keep their pins');
  assert.equal((await send(h.base, 'POST', '/tasks/local%3A1/review/submit')).status, 200);
  assert.match(h.delivered[1].text, /^Review comment on a\.txt/);
  assert.deepEqual((await h.file()).drafts.map((d) => d.text), ['three'], 'a submit without kind leaves the design drafts');
});

test('a design comment sent now is pinned in the store edit and delivers the pin it stored (#111)', async (t) => {
  const h = await start(t);
  await send(h.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor: DESIGN, text: 'later', session: SESSION_A });
  const res = await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: { ...DESIGN, pin: 9 }, text: 'now', to: [SESSION_A] });
  const { thread } = await res.json() as { thread: string };
  assert.equal(res.status, 200);
  const [stored] = (await h.file()).threads;
  assert.deepEqual(stored.anchor, { ...DESIGN, pin: 2 });
  assert.equal(h.delivered[0].text, commentText(stored.anchor, thread, { text: 'now' }, SESSION_A, () => 'claude'));
  assert.match(h.delivered[0].text, /^Design comment 2 on /);
  assert.equal((await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: { ...DESIGN, theme: 'sepia' }, text: 'x', to: [SESSION_A] })).status, 400);
});

test('submit with path sends only that design file\'s drafts; with to, every one goes to it in one message; a bad path or to is refused (#113)', async (t) => {
  const h = await start(t);
  const OTHER = { ...DESIGN, path: 'agent/hive/designs/x/other.hv.html' };
  const draft = (anchor: unknown, text: string, session: string) => send(h.base, 'POST', '/tasks/local%3A1/review/drafts', { anchor, text, session });
  const submit = (body: unknown) => send(h.base, 'POST', '/tasks/local%3A1/review/submit', body);
  await draft(DESIGN, 'one', SESSION_A);
  await draft(DESIGN, 'two', SESSION_B);
  await draft(OTHER, 'elsewhere', SESSION_A);
  for (const body of [{ path: DESIGN.path }, { kind: 'design', path: 5 }, { kind: 'design', to: SESSION_OTHER }, { kind: 'design', to: 'x' }]) {
    assert.equal((await submit(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(h.delivered.length, 0); // not deepEqual: it would narrow delivered to never[]
  const res = await submit({ kind: 'design', path: DESIGN.path, to: SESSION_B });
  assert.deepEqual([res.status, await res.json()], [200, { failed: [] }]);
  assert.deepEqual(h.delivered.map((d) => d.to), [SESSION_B], 'the drafts of two sessions in one message to to');
  assert.deepEqual(h.delivered[0].text.match(/^Design comment \d+ on \S+/gm), [`Design comment 1 on ${DESIGN.path}`, `Design comment 2 on ${DESIGN.path}`]);
  const file = await h.file();
  assert.deepEqual(file.threads.map((th) => [th.messages[0].text, th.participants]), [['one', [SESSION_B]], ['two', [SESSION_B]]]);
  assert.deepEqual(file.drafts.map((d) => d.text), ['elsewhere'], 'another design\'s draft stays');
  assert.equal((await submit({ kind: 'design', path: DESIGN.path })).status, 409);
  assert.equal((await submit({ kind: 'design', path: OTHER.path, to: SESSION_A, skip: [SESSION_A] })).status, 409, 'skip applies to the to group');
  assert.equal((await submit({ kind: 'design', path: OTHER.path })).status, 200, 'without to: by each draft\'s session, as before');
  assert.deepEqual(h.delivered.at(-1)?.to, SESSION_A);
});
