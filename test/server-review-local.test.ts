import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deliver } from '../src/review-deliver.js';
import { EMPTY_REVIEW, localReviewPath } from '../src/review-store.js';
import type { ReviewFile } from '../src/types.js';
import { hiveFetch } from './secret-client.js';
import { reviewEventDuring, send, SESSION_A, SESSION_LOCAL, startReviews } from './review-server.js';

const NEW_ID = 'ffffffff-6666-4666-8666-666666666666';
const LOCAL = '/workspaces/hive/review';
const DESIGN = { kind: 'area', path: 'agent/hive/designs/x/home.hv.html', viewport: 'desktop', theme: 'dark', tweaks: {}, rect: { x: 40, y: 120, width: 320, height: 180 } } as const;

// A Hive whose local deliveries are recorded (a new session reached as NEW_ID) and whose task deliveries must never happen
async function start(t: TestContext) {
  const delivered: { workspace: string; to: string; text: string }[] = [];
  const taskDelivered: string[] = [];
  const deliverLocalReview: Deliver = async (workspace, to, text) => {
    delivered.push({ workspace, to, text });
    return { ok: true, session: to === 'new' ? NEW_ID : to };
  };
  const deliverReview: Deliver = async (taskId, to) => {
    taskDelivered.push(`${taskId} ${to}`);
    return { ok: true, session: to };
  };
  const hive = await startReviews(t, { deliverReview, deliverLocalReview });
  const file = async (): Promise<ReviewFile> => JSON.parse(await readFile(localReviewPath(hive.home, 'hive'), 'utf8')) as ReviewFile;
  const reviewsDir = (): Promise<string[]> => readdir(join(hive.home, 'reviews'));
  return { ...hive, delivered, taskDelivered, file, reviewsDir };
}

test('a design thread on the local routes is created, replied to and resolved in the workspace\'s file only, and delivered as a task\'s (#344)', async (t) => {
  const h = await start(t);
  const res = await send(h.base, 'POST', `${LOCAL}/threads`, { anchor: DESIGN, text: 'bigger', to: [SESSION_LOCAL] });
  const { thread } = await res.json() as { thread: string };
  assert.equal(res.status, 200);
  assert.deepEqual([h.delivered[0].workspace, h.delivered[0].to], ['hive', SESSION_LOCAL]);
  assert.ok(h.delivered[0].text.startsWith(`Design comment 1 on ${DESIGN.path} (conversation ${thread}):`), h.delivered[0].text);
  assert.deepEqual((await h.file()).threads[0].participants, [SESSION_LOCAL]);
  assert.equal((await send(h.base, 'POST', `${LOCAL}/threads/${thread}/messages`, { text: 'and the color?' })).status, 200);
  assert.deepEqual([h.delivered.at(-1)?.to, (await h.file()).threads[0].messages.length], [SESSION_LOCAL, 2], 'the reply target');
  assert.equal((await send(h.base, 'POST', `${LOCAL}/threads/${thread}/resolve`, { resolved: true })).status, 200);
  assert.equal((await h.file()).threads[0].resolved, true);
  assert.deepEqual([await h.reviewsDir(), h.taskDelivered], [['local'], []], 'no task file, no task delivery');
});

test('the local drafts are written, edited, removed and submitted to a local session in one message; GET answers the workspace\'s file (#344)', async (t) => {
  const h = await start(t);
  const empty = await hiveFetch(`${h.base}${LOCAL}`);
  assert.deepEqual([empty.status, await empty.json()], [200, EMPTY_REVIEW]);
  const { id } = await (await send(h.base, 'POST', `${LOCAL}/drafts`, { anchor: DESIGN, text: 'one', session: SESSION_LOCAL })).json() as { id: string };
  assert.equal((await send(h.base, 'PUT', `${LOCAL}/drafts/${id}`, { text: 'one!', session: SESSION_LOCAL })).status, 200);
  await send(h.base, 'POST', `${LOCAL}/drafts`, { anchor: DESIGN, text: 'two', session: 'new' });
  const gone = await (await send(h.base, 'POST', `${LOCAL}/drafts`, { anchor: DESIGN, text: 'gone', session: SESSION_LOCAL })).json() as { id: string };
  assert.equal((await send(h.base, 'DELETE', `${LOCAL}/drafts/${gone.id}`)).status, 200);
  assert.equal((await send(h.base, 'PUT', `${LOCAL}/default-session`, { session: SESSION_LOCAL })).status, 200);
  const res = await send(h.base, 'POST', `${LOCAL}/submit`, { kind: 'design', to: SESSION_LOCAL });
  assert.deepEqual([res.status, await res.json()], [200, { failed: [] }]);
  assert.deepEqual(h.delivered.map((d) => d.to), [SESSION_LOCAL]);
  assert.equal(h.delivered[0].text.match(/^Design comment \d+ on \S+ \(conversation [^)]+\):$/gm)?.length, 2);
  const file = await h.file();
  assert.deepEqual([file.drafts, file.defaultSession, file.threads.map((th) => th.messages[0].text)], [[], SESSION_LOCAL, ['one!', 'two']]);
  assert.deepEqual(await h.reviewsDir(), ['local']);
});

test('the local routes refuse an unknown workspace and a task\'s session, a task route refuses a local one, and a local write emits the workspace\'s event (#344)', async (t) => {
  const h = await start(t);
  const unknown = await send(h.base, 'POST', '/workspaces/nope/review/threads', { anchor: DESIGN, text: 'x', to: [SESSION_LOCAL] });
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'unknown workspace' }]);
  assert.equal((await hiveFetch(`${h.base}/workspaces/nope/review`)).status, 404);
  for (const [method, path, body] of [
    ['POST', '/threads', { anchor: DESIGN, text: 'x', to: [SESSION_A] }], ['POST', '/threads', { anchor: DESIGN, text: 'x', mentions: [SESSION_A] }],
    ['POST', '/drafts', { anchor: DESIGN, text: 'x', session: SESSION_A }], ['PUT', '/default-session', { session: SESSION_A }],
    ['POST', '/submit', { kind: 'design', to: SESSION_A }],
  ] as const) assert.equal((await send(h.base, method, `${LOCAL}${path}`, body)).status, 400, `${method} ${path}`);
  assert.equal((await send(h.base, 'POST', '/tasks/local%3A1/review/threads', { anchor: DESIGN, text: 'x', to: [SESSION_LOCAL] })).status, 400);
  assert.notEqual((await send(h.base, 'POST', `${LOCAL}/reviewed`, { scope: 'worktree', path: 'a.txt', hash: 'a'.repeat(64), reviewed: true })).status, 200, 'no reviewed marks on a local review');
  assert.equal(h.delivered.length + h.taskDelivered.length, 0);
  const event = await reviewEventDuring(h.base, () => send(h.base, 'POST', `${LOCAL}/drafts`, { anchor: DESIGN, text: 'x', session: SESSION_LOCAL }));
  assert.deepEqual(event, { type: 'review', workspace: 'hive' });
});
