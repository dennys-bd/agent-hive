import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { parseThreadAnchor, recipientsOf, textOf } from './review-bodies.js';
import type { Deliver } from './review-deliver.js';
import { batchText, commentText, missed } from './review-message.js';
import { appendMessage, convertDrafts, draftMentions, type Outcome, pinned, replyTarget, resolve, settleMessage, startThread } from './review-store.js';
import { type ReviewSubject, type SubjectOf, taskSubject } from './review-subject.js';
import type { TaskRouteDeps } from './server-tasks.js';
import { badRequest, errorMessage, liveTaskIn, readReview, refuse, type ReviewRouteDeps, storeEdit, writeReview } from './server-review.js';
import { isDesignAnchor, type ReviewDraft, type ReviewFile, type ReviewMessage, type ReviewThread } from './types.js';

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
const KIND_MESSAGE = 'kind, quando vem, é lines ou design';
const PATH_MESSAGE = 'path, quando vem, é texto e só com kind design';
const TO_MESSAGE = 'to, quando vem, é uma sessão da tarefa, ou "new"';

export type ThreadRouteDeps = ReviewRouteDeps & Pick<TaskRouteDeps, 'log'> & { deliver: Deliver };
type Log = TaskRouteDeps['log'];

// What is going out now (#591): a double click, ⌘⇧↵ twice or a retry racing the first delivery would paste the same text twice.
// ponytail: process-wide sets, one Hive per process; per-deps maps if two servers ever share a process
const submitting = new Set<string>(); // subjects' guards: task item ids, local activity ids (#344)
const delivering = new Set<string>(); // message ids

/** Every recipient at once (#591), each with its own text: each delivery settles on its own, a failed one never holds the others. */
export async function deliverAll(deliver: ReviewSubject['deliver'], to: string[], textFor: (asked: string) => string): Promise<Outcome> {
  const results = await Promise.all(to.map(async (asked) => ({ asked, delivery: await deliver(asked, textFor(asked)) })));
  return {
    delivered: results.flatMap(({ asked, delivery }) => (delivery.ok ? [{ asked, session: delivery.session }] : [])),
    failed: results.flatMap(({ asked, delivery }) => (delivery.ok ? [] : [asked])),
  };
}

// Stored failed from the start (#591): should its settle never run (a crash, a store error), reenviar still finds it; settle strips both
export const userMessage = (text: string, to: string[], mentions?: string[]): ReviewMessage =>
  ({ id: randomUUID(), author: 'user', at: new Date().toISOString(), text, failed: true, pending: to, ...(mentions ? { mentions } : {}) });

// A message's chips (#591): absent is none; present they pick the recipients, over the box's picker and the reply target. null: refused
const mentionsOf = (subject: ReviewSubject, raw: unknown): string[] | undefined | null =>
  (raw === undefined ? undefined : recipientsOf(subject.isSession, raw) ?? null);

// The stored message delivered to what it still owes, then settled (#591): the text was written first, so a failure never loses it
async function deliverAndSettle(res: Response, subject: ReviewSubject, thread: Pick<ReviewThread, 'id' | 'anchor'>, message: ReviewMessage): Promise<void> {
  if (delivering.has(message.id)) return refuse(res, { status: HTTP_CONFLICT, message: DELIVERING_MESSAGE });
  delivering.add(message.id);
  try {
    // Read again through the store's queue, now that no other delivery of it can start: one that settled since the route's read owes nothing.
    // The stored thread says what each recipient has not received yet
    const found = await owed(res, subject, thread.id, message.id);
    if (found === undefined) return;
    // #925: each mention by its session's agent, as the subject read them for this request
    const textFor = (asked: string): string => commentText(thread.anchor, thread.id, message, asked, subject.agentOf, missed(found.thread, message.id, asked));
    const outcome = await deliverAll(subject.deliver, found.pending, textFor);
    await writeReview(subject, res, (file) => settleMessage(file, thread.id, message.id, outcome), { thread: thread.id, message: message.id, failed: outcome.failed });
  } finally {
    delivering.delete(message.id);
  }
}

// What the stored message still owes, and its stored thread, read in the store's queue; undefined once its 409 or 500 is out
async function owed(res: Response, subject: ReviewSubject, threadId: string, messageId: string): Promise<{ pending: string[]; thread: ReviewThread } | undefined> {
  let file: ReviewFile;
  try {
    file = await subject.store.update(subject.key, (current) => current);
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

// The subject and the conversation a route names, or undefined once its answer is out
async function threadOf(subjectOf: SubjectOf<ReviewSubject>, req: Request, res: Response): Promise<{ subject: ReviewSubject; thread: ReviewThread } | undefined> {
  const subject = subjectOf(req, res);
  if (!subject) return undefined;
  const file = await readReview(subject, res);
  const thread = file?.threads.find((t) => t.id === req.params.thread);
  if (file && !thread) refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_THREAD_MESSAGE });
  return thread ? { subject, thread } : undefined;
}

// enviar (#591): a comment sent now opens a conversation at its lines
function registerThreadRoute(app: Express, prefix: string, subjectOf: SubjectOf<ReviewSubject>): void {
  app.post(`${prefix}/review/threads`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const anchor = parseThreadAnchor(body.anchor);
    const text = textOf(body.text);
    const mentions = mentionsOf(subject, body.mentions);
    const to = mentions ?? recipientsOf(subject.isSession, body.to);
    if (!anchor || text === undefined || !to || mentions === null) return badRequest(res, COMMENT_MESSAGE);
    const message = userMessage(text, to, mentions);
    const id = randomUUID();
    // Pinned inside the store's edit (#111); the stored thread is the one delivered, so the text and the file carry the same pin
    const stored = await storeEdit(subject, res, (file) => startThread(file, { id, anchor: pinned(file, anchor), participants: [], messages: [message] }));
    const thread = stored?.threads.find((candidate) => candidate.id === id);
    if (thread) await deliverAndSettle(res, subject, thread, message);
  });
}

// A reply (#591): to its mentions, else to the reply target; and reenviar, to what a failed delivery still owes
function registerMessageRoutes(app: Express, prefix: string, subjectOf: SubjectOf<ReviewSubject>): void {
  app.post(`${prefix}/review/threads/:thread/messages`, async (req: Request, res: Response) => {
    const found = await threadOf(subjectOf, req, res);
    if (!found) return;
    const { subject, thread } = found;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = replyTarget(thread);
    const mentions = mentionsOf(subject, body.mentions);
    const to = mentions ?? (body.to === undefined ? (target === undefined ? undefined : [target]) : recipientsOf(subject.isSession, body.to));
    const text = textOf(body.text);
    if (text === undefined || !to || mentions === null) return badRequest(res, REPLY_MESSAGE);
    const message = userMessage(text, to, mentions);
    if (await storeEdit(subject, res, (file) => appendMessage(file, thread.id, message))) await deliverAndSettle(res, subject, thread, message);
  });
  app.post(`${prefix}/review/threads/:thread/messages/:message/retry`, async (req: Request, res: Response) => {
    const found = await threadOf(subjectOf, req, res);
    if (!found) return;
    const message = found.thread.messages.find((m) => m.id === req.params.message);
    if (!message) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_MESSAGE_MESSAGE });
    if (!message.failed || !message.pending?.length) return refuse(res, { status: HTTP_CONFLICT, message: NOTHING_TO_RETRY_MESSAGE });
    await deliverAndSettle(res, found.subject, found.thread, message);
  });
}

// resolver / reabrir (#591)
function registerResolveRoute(app: Express, prefix: string, subjectOf: SubjectOf<ReviewSubject>): void {
  app.post(`${prefix}/review/threads/:thread/resolve`, async (req: Request, res: Response) => {
    const found = await threadOf(subjectOf, req, res);
    if (!found) return;
    const { resolved } = (req.body ?? {}) as { resolved?: unknown };
    if (typeof resolved !== 'boolean') return badRequest(res, RESOLVE_MESSAGE);
    await writeReview(found.subject, res, (file) => resolve(file, found.thread.id, resolved));
  });
}

/** A review's conversations and its submit under `prefix` (#591, #344), on the subject `subjectOf` resolves. */
export function registerThreadRoutes(app: Express, prefix: string, subjectOf: SubjectOf<ReviewSubject>, log: Log): void {
  registerThreadRoute(app, prefix, subjectOf);
  registerMessageRoutes(app, prefix, subjectOf);
  registerResolveRoute(app, prefix, subjectOf);
  registerSubmitRoute(app, prefix, subjectOf, log);
}

/** The conversations of a task's review (#591). */
export function registerReviewThreadRoutes(app: Express, deps: ThreadRouteDeps): void {
  registerThreadRoutes(app, '/tasks/:id', (req, res) => {
    const live = liveTaskIn(deps, req, res);
    return live && taskSubject(deps, live.state, live.task);
  }, deps.log);
}

type GroupResult = 'sent' | 'failed' | 'unsaved';

// The delivered batch's conversations written, a second time on a failure (#591). Given up, the text already reached the session: the
// drafts stay, logged by name only, since the error may quote the file
async function saveBatch(log: Log, subject: ReviewSubject, session: string, edit: (file: ReviewFile) => ReviewFile): Promise<boolean> {
  for (const attempt of [1, 2]) {
    try {
      await subject.store.update(subject.key, edit);
      return true;
    } catch (err) {
      if (attempt === 2) log.error(`review ${subject.key}: the batch delivered to ${session} was not saved (${err instanceof Error ? err.name : 'error'})`);
    }
  }
  return false;
}

// One session's drafts in one message (#591): delivered first, turned into conversations only once it arrived, so nothing is half-sent
async function submitGroup(log: Log, subject: ReviewSubject, session: string, drafts: ReviewDraft[]): Promise<GroupResult> {
  const items = drafts.map((draft) => ({ draft, threadId: randomUUID(), messageId: randomUUID() }));
  const delivery = await subject.deliver(session, batchText(items.map(({ draft, threadId }) => ({ anchor: draft.anchor, threadId, text: draft.text, ...draftMentions(draft) })), session, subject.agentOf));
  if (!delivery.ok) return 'failed';
  const saved = await saveBatch(log, subject, session, (file) => convertDrafts(file, items, delivery.session, new Date().toISOString()));
  if (!saved) return 'unsaved';
  subject.notify();
  return 'sent';
}

/** What a submit sends (#591, #111, #113): skip's sessions left out, kind's drafts, path's design file only, and every one to `to` when it comes. */
interface SubmitPick { skip: string[]; kind: 'lines' | 'design'; path?: string; to?: string }

// The submit's body read (#113: path and to): the pick, or the refusal's message when it does not hold
function submitPick(subject: Pick<ReviewSubject, 'isSession'>, body: Record<string, unknown>): SubmitPick | string {
  const { skip = [], kind = 'lines', path, to } = body;
  if (!Array.isArray(skip) || !skip.every((id) => subject.isSession(id))) return SKIP_MESSAGE;
  if (kind !== 'lines' && kind !== 'design') return KIND_MESSAGE;
  if (path !== undefined && (typeof path !== 'string' || kind !== 'design')) return PATH_MESSAGE;
  if (to !== undefined && !subject.isSession(to)) return TO_MESSAGE;
  return { skip, kind, ...(typeof path === 'string' ? { path } : {}), ...(typeof to === 'string' ? { to } : {}) };
}

// A draft the pick sends: kind's, on path's file when it names one; skip applies to the session it would go to, `to` when it comes
const isPicked = (pick: SubmitPick) => (draft: ReviewDraft): boolean =>
  !pick.skip.includes(pick.to ?? draft.session) && isDesignAnchor(draft.anchor) === (pick.kind === 'design')
  && (pick.path === undefined || (isDesignAnchor(draft.anchor) && draft.anchor.path === pick.path));

// skip: the sessions whose last batch arrived but was not saved; their drafts would paste it again (#591). kind: the pane's own drafts (#111).
// to (#113): the design pane's recipient, every picked draft in one message to it, whatever session each was saved for
async function submitAll(log: Log, res: Response, subject: ReviewSubject, pick: SubmitPick): Promise<void> {
  const file = await readReview(subject, res);
  if (!file) return;
  const drafts = file.drafts.filter(isPicked(pick));
  if (drafts.length === 0) return refuse(res, { status: HTTP_CONFLICT, message: NO_DRAFT_MESSAGE });
  const sessions = pick.to === undefined ? [...new Set(drafts.map((d) => d.session))] : [pick.to];
  const groupOf = (session: string): ReviewDraft[] => (pick.to === undefined ? drafts.filter((d) => d.session === session) : drafts);
  try {
    const results = await Promise.all(sessions.map((s) => submitGroup(log, subject, s, groupOf(s))));
    const having = (result: GroupResult): string[] => sessions.filter((_s, i) => results[i] === result);
    res.json({ failed: having('failed'), ...(having('unsaved').length > 0 ? { unsaved: having('unsaved') } : {}) });
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
  }
}

// enviar revisão (#591): the drafts grouped by session, or all to the design pane's recipient (#113); drafts for nova sessão opening one new
// session together; one submit per subject at a time
function registerSubmitRoute(app: Express, prefix: string, subjectOf: SubjectOf<ReviewSubject>, log: Log): void {
  app.post(`${prefix}/review/submit`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const pick = submitPick(subject, (req.body ?? {}) as Record<string, unknown>);
    if (typeof pick === 'string') return badRequest(res, pick);
    if (submitting.has(subject.guard)) return refuse(res, { status: HTTP_CONFLICT, message: SUBMITTING_MESSAGE });
    submitting.add(subject.guard);
    try {
      await submitAll(log, res, subject, pick);
    } finally {
      submitting.delete(subject.guard);
    }
  });
}
