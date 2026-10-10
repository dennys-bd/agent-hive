import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { isTaskSession, parseAnchor, recipientsOf, textOf } from './review-bodies.js';
import type { Deliver } from './review-deliver.js';
import { batchText, commentText, missed } from './review-message.js';
import { appendMessage, convertDrafts, draftMentions, type Outcome, replyTarget, resolve, settleMessage, startThread } from './review-store.js';
import type { TaskRouteDeps } from './server-tasks.js';
import { badRequest, errorMessage, liveTaskIn, readReview, refuse, type ReviewRouteDeps, storeEdit, writeReview } from './server-review.js';
import type { Task, ReviewDraft, ReviewFile, ReviewMessage, ReviewThread, State } from './types.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const NO_DRAFT_MESSAGE = 'nenhum rascunho para enviar';
const COMMENT_MESSAGE = 'anchor, text (1 a 10000 caracteres) e to ou mentions (sessões da tarefa, ou "new") são obrigatórios';
const REPLY_MESSAGE = 'text (1 a 10000 caracteres) é obrigatório; to ou mentions, quando vêm, listam sessões da tarefa, ou "new"';
const RESOLVE_MESSAGE = 'resolved precisa ser true ou false';
const UNKNOWN_THREAD_MESSAGE = 'conversa desconhecida';
const UNKNOWN_MESSAGE_MESSAGE = 'mensagem desconhecida';
const NOTHING_TO_RETRY_MESSAGE = 'nada para reenviar';
const SUBMITTING_MESSAGE = 'a revisão já está sendo enviada';
const DELIVERING_MESSAGE = 'a mensagem já está sendo entregue';
const SKIP_MESSAGE = 'skip, quando vem, lista sessões da tarefa, ou "new"';

export type ThreadRouteDeps = ReviewRouteDeps & Pick<TaskRouteDeps, 'log'> & { deliver: Deliver };

// What is going out now (#591): a double click, ⌘⇧↵ twice or a retry racing the first delivery would paste the same text twice.
// ponytail: process-wide sets, one Hive per process; per-deps maps if two servers ever share a process
const submitting = new Set<string>(); // task item ids
const delivering = new Set<string>(); // message ids

/** Every recipient at once (#591), each with its own text: each delivery settles on its own, a failed one never holds the others. */
export async function deliverAll(deliver: Deliver, taskId: string, to: string[], textFor: (asked: string) => string): Promise<Outcome> {
  const results = await Promise.all(to.map(async (asked) => ({ asked, delivery: await deliver(taskId, asked, textFor(asked)) })));
  return {
    delivered: results.flatMap(({ asked, delivery }) => (delivery.ok ? [{ asked, session: delivery.session }] : [])),
    failed: results.flatMap(({ asked, delivery }) => (delivery.ok ? [] : [asked])),
  };
}

// Stored failed from the start (#591): should its settle never run (a crash, a store error), reenviar still finds it; settle strips both
export const userMessage = (text: string, to: string[], mentions?: string[]): ReviewMessage =>
  ({ id: randomUUID(), author: 'user', at: new Date().toISOString(), text, failed: true, pending: to, ...(mentions ? { mentions } : {}) });

// A message's chips (#591): absent is none; present they pick the recipients, over the box's picker and the reply target. null: refused
const mentionsOf = (state: State, task: Task, raw: unknown): string[] | undefined | null =>
  (raw === undefined ? undefined : recipientsOf(state, task.item.itemId, raw) ?? null);

// The stored message delivered to what it still owes, then settled (#591): the text was written first, so a failure never loses it
async function deliverAndSettle(deps: ThreadRouteDeps, res: Response, task: Task, thread: Pick<ReviewThread, 'id' | 'anchor'>, message: ReviewMessage): Promise<void> {
  if (delivering.has(message.id)) return refuse(res, { status: HTTP_CONFLICT, message: DELIVERING_MESSAGE });
  delivering.add(message.id);
  try {
    const taskId = task.item.itemId;
    // Read again through the store's queue, now that no other delivery of it can start: one that settled since the route's read owes nothing.
    // The stored thread says what each recipient has not received yet
    const found = await owed(deps, res, taskId, thread.id, message.id);
    if (found === undefined) return;
    const textFor = (asked: string): string => commentText(thread.anchor, thread.id, message, asked, missed(found.thread, message.id, asked));
    const outcome = await deliverAll(deps.deliver, taskId, found.pending, textFor);
    await writeReview(deps, res, taskId, (file) => settleMessage(file, thread.id, message.id, outcome), { thread: thread.id, message: message.id, failed: outcome.failed });
  } finally {
    delivering.delete(message.id);
  }
}

// What the stored message still owes, and its stored thread, read in the store's queue; undefined once its 409 or 500 is out
async function owed(deps: ThreadRouteDeps, res: Response, taskId: string, threadId: string, messageId: string): Promise<{ pending: string[]; thread: ReviewThread } | undefined> {
  let file: ReviewFile;
  try {
    file = await deps.reviews.update(taskId, (current) => current);
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
    return undefined;
  }
  const thread = file.threads.find((t) => t.id === threadId);
  const stored = thread?.messages.find((m) => m.id === messageId);
  if (thread && stored?.failed && stored.pending?.length) return { pending: stored.pending, thread };
  refuse(res, { status: HTTP_CONFLICT, message: NOTHING_TO_RETRY_MESSAGE });
  return undefined;
}

// The task and the conversation a route names, or undefined once its answer is out
async function threadOf(deps: ThreadRouteDeps, req: Request, res: Response): Promise<{ task: Task; state: State; thread: ReviewThread } | undefined> {
  const live = liveTaskIn(deps, req, res);
  if (!live) return undefined;
  const file = await readReview(deps, res, live.task.item.itemId);
  const thread = file?.threads.find((t) => t.id === req.params.thread);
  if (file && !thread) refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_THREAD_MESSAGE });
  return thread ? { ...live, thread } : undefined;
}

// enviar (#591): a comment sent now opens a conversation at its lines
function registerThreadRoute(app: Express, deps: ThreadRouteDeps): void {
  app.post('/tasks/:id/review/threads', async (req: Request, res: Response) => {
    const live = liveTaskIn(deps, req, res);
    if (!live) return;
    const { task, state } = live;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const anchor = parseAnchor(body.anchor);
    const text = textOf(body.text);
    const mentions = mentionsOf(state, task, body.mentions);
    const to = mentions ?? recipientsOf(state, task.item.itemId, body.to);
    if (!anchor || text === undefined || !to || mentions === null) return badRequest(res, COMMENT_MESSAGE);
    const message = userMessage(text, to, mentions);
    const thread: ReviewThread = { id: randomUUID(), anchor, participants: [], messages: [message] };
    if (await storeEdit(deps, res, task.item.itemId, (file) => startThread(file, thread))) await deliverAndSettle(deps, res, task, thread, message);
  });
}

// A reply (#591): to its mentions, else to the reply target; and reenviar, to what a failed delivery still owes
function registerMessageRoutes(app: Express, deps: ThreadRouteDeps): void {
  app.post('/tasks/:id/review/threads/:thread/messages', async (req: Request, res: Response) => {
    const found = await threadOf(deps, req, res);
    if (!found) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = replyTarget(found.thread);
    const mentions = mentionsOf(found.state, found.task, body.mentions);
    const to = mentions ?? (body.to === undefined ? (target === undefined ? undefined : [target]) : recipientsOf(found.state, found.task.item.itemId, body.to));
    const text = textOf(body.text);
    if (text === undefined || !to || mentions === null) return badRequest(res, REPLY_MESSAGE);
    const message = userMessage(text, to, mentions);
    if (await storeEdit(deps, res, found.task.item.itemId, (file) => appendMessage(file, found.thread.id, message))) await deliverAndSettle(deps, res, found.task, found.thread, message);
  });
  app.post('/tasks/:id/review/threads/:thread/messages/:message/retry', async (req: Request, res: Response) => {
    const found = await threadOf(deps, req, res);
    if (!found) return;
    const message = found.thread.messages.find((m) => m.id === req.params.message);
    if (!message) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_MESSAGE_MESSAGE });
    if (!message.failed || !message.pending?.length) return refuse(res, { status: HTTP_CONFLICT, message: NOTHING_TO_RETRY_MESSAGE });
    await deliverAndSettle(deps, res, found.task, found.thread, message);
  });
}

// resolver / reabrir (#591)
function registerResolveRoute(app: Express, deps: ThreadRouteDeps): void {
  app.post('/tasks/:id/review/threads/:thread/resolve', async (req: Request, res: Response) => {
    const found = await threadOf(deps, req, res);
    if (!found) return;
    const { resolved } = (req.body ?? {}) as { resolved?: unknown };
    if (typeof resolved !== 'boolean') return badRequest(res, RESOLVE_MESSAGE);
    await writeReview(deps, res, found.task.item.itemId, (file) => resolve(file, found.thread.id, resolved));
  });
}

/** The conversations of a task's review (#591). */
export function registerReviewThreadRoutes(app: Express, deps: ThreadRouteDeps): void {
  registerThreadRoute(app, deps);
  registerMessageRoutes(app, deps);
  registerResolveRoute(app, deps);
  registerSubmitRoute(app, deps);
}

type GroupResult = 'sent' | 'failed' | 'unsaved';

// The delivered batch's conversations written, a second time on a failure (#591). Given up, the text already reached the session: the
// drafts stay, logged by name only, since the error may quote the file
async function saveBatch(deps: ThreadRouteDeps, taskId: string, session: string, edit: Parameters<ThreadRouteDeps['reviews']['update']>[1]): Promise<boolean> {
  for (const attempt of [1, 2]) {
    try {
      await deps.reviews.update(taskId, edit);
      return true;
    } catch (err) {
      if (attempt === 2) deps.log.error(`review ${taskId}: the batch delivered to ${session} was not saved (${err instanceof Error ? err.name : 'error'})`);
    }
  }
  return false;
}

// One session's drafts in one message (#591): delivered first, turned into conversations only once it arrived, so nothing is half-sent
async function submitGroup(deps: ThreadRouteDeps, taskId: string, session: string, drafts: ReviewDraft[]): Promise<GroupResult> {
  const items = drafts.map((draft) => ({ draft, threadId: randomUUID(), messageId: randomUUID() }));
  const delivery = await deps.deliver(taskId, session, batchText(items.map(({ draft, threadId }) => ({ anchor: draft.anchor, threadId, text: draft.text, ...draftMentions(draft) })), session));
  if (!delivery.ok) return 'failed';
  const saved = await saveBatch(deps, taskId, session, (file) => convertDrafts(file, items, delivery.session, new Date().toISOString()));
  if (!saved) return 'unsaved';
  deps.notifyReview(taskId);
  return 'sent';
}

// skip: the sessions whose last batch arrived but was not saved; their drafts would paste it again (#591)
async function submitAll(deps: ThreadRouteDeps, res: Response, taskId: string, skip: string[]): Promise<void> {
  const file = await readReview(deps, res, taskId);
  if (!file) return;
  const drafts = file.drafts.filter((d) => !skip.includes(d.session));
  if (drafts.length === 0) return refuse(res, { status: HTTP_CONFLICT, message: NO_DRAFT_MESSAGE });
  const sessions = [...new Set(drafts.map((d) => d.session))];
  try {
    const results = await Promise.all(sessions.map((s) => submitGroup(deps, taskId, s, drafts.filter((d) => d.session === s))));
    const having = (result: GroupResult): string[] => sessions.filter((_s, i) => results[i] === result);
    res.json({ failed: having('failed'), ...(having('unsaved').length > 0 ? { unsaved: having('unsaved') } : {}) });
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
  }
}

// enviar revisão (#591): the drafts grouped by session, drafts for nova sessão opening one new session together; one submit per task at a time
function registerSubmitRoute(app: Express, deps: ThreadRouteDeps): void {
  app.post('/tasks/:id/review/submit', async (req: Request, res: Response) => {
    const live = liveTaskIn(deps, req, res);
    if (!live) return;
    const { task, state } = live;
    const { skip = [] } = (req.body ?? {}) as { skip?: unknown };
    if (!Array.isArray(skip) || !skip.every((id) => isTaskSession(state, task.item.itemId, id))) return badRequest(res, SKIP_MESSAGE);
    const taskId = task.item.itemId;
    if (submitting.has(taskId)) return refuse(res, { status: HTTP_CONFLICT, message: SUBMITTING_MESSAGE });
    submitting.add(taskId);
    try {
      await submitAll(deps, res, taskId, skip);
    } finally {
      submitting.delete(taskId);
    }
  });
}
