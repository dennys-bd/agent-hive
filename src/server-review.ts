import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { isScope } from './diff.js';
import { isHash, isPath, parseThreadAnchor, textOf } from './review-bodies.js';
import { addDraft, markReviewed, pinned, removeDraft, setDefaultSession, updateDraft } from './review-store.js';
import { type StoreSubject, type SubjectOf, taskStoreSubject } from './review-subject.js';
import { type TaskRouteDeps, type Refusal, UNKNOWN_TASK_MESSAGE } from './server-tasks.js';
import type { Task, ReviewFile, State } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const MARK_MESSAGE = 'scope deve ser stage, worktree ou commit, path um texto não vazio, hash um sha256 e reviewed true ou false';
const TASK_PREFIX = '/tasks/:id';

/** What the review routes read (#591): the live state, the store and the review event. */
export type ReviewRouteDeps = Pick<TaskRouteDeps, 'requireLive' | 'reviews' | 'notifyReview'>;

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};
export const badRequest = (res: Response, message: string): void => refuse(res, { status: HTTP_BAD_REQUEST, message });

/** The task a review route names (#591), or undefined once its answer (409 not configured, 404 unknown) is out. */
export function liveTaskIn(deps: Pick<TaskRouteDeps, 'requireLive'>, req: Request, res: Response): { task: Task; state: State } | undefined {
  const current = deps.requireLive(res);
  if (!current) return undefined;
  const task = current.state.tasks.find((c) => c.item.itemId === req.params.id);
  if (!task) refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE });
  return task && { task, state: current.state };
}

/** An edit of the subject's file then its review event (#591, #344); the file as written, or undefined once a store failure answered 500. */
export async function storeEdit(subject: StoreSubject, res: Response, edit: (file: ReviewFile) => ReviewFile): Promise<ReviewFile | undefined> {
  let file: ReviewFile;
  try {
    file = await subject.store.update(subject.key, edit);
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
    return undefined;
  }
  subject.notify();
  return file;
}

/** storeEdit, then `answer`. */
export async function writeReview(subject: StoreSubject, res: Response, edit: (file: ReviewFile) => ReviewFile, answer: unknown = { ok: true }): Promise<void> {
  if (await storeEdit(subject, res, edit)) res.json(answer);
}

/** The subject's file as stored (#591), or undefined once its 500 is out. */
export async function readReview(subject: Pick<StoreSubject, 'key' | 'store'>, res: Response): Promise<ReviewFile | undefined> {
  try {
    return await subject.store.read(subject.key);
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
    return undefined;
  }
}

/** A task's review file, its drafts and its reviewed marks (#591). The marks are the diff pane's, so only a task has them. */
export function registerReviewRoutes(app: Express, deps: ReviewRouteDeps): void {
  const subjectOf: SubjectOf<StoreSubject> = (req, res) => {
    const live = liveTaskIn(deps, req, res);
    return live && taskStoreSubject(deps, live.state, live.task);
  };
  app.post(`${TASK_PREFIX}/review/reviewed`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const { scope, path, hash, reviewed } = (req.body ?? {}) as Record<string, unknown>;
    if (!isScope(scope) || !isPath(path) || !isHash(hash) || typeof reviewed !== 'boolean') return badRequest(res, MARK_MESSAGE);
    await writeReview(subject, res, (file) => markReviewed(file, { scope, path, hash }, reviewed));
  });
  registerStoreRoutes(app, TASK_PREFIX, subjectOf);
}

/** A review's file and drafts under `prefix` (#591, #344): GET, adicionar à revisão, editar, remove and sessão padrão, on the subject
 * `subjectOf` resolves. */
export function registerStoreRoutes(app: Express, prefix: string, subjectOf: SubjectOf<StoreSubject>): void {
  app.get(`${prefix}/review`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const file = await readReview(subject, res);
    if (file) res.json(file);
  });
  registerDraftRoutes(app, prefix, subjectOf);
  registerDraftRemoval(app, prefix, subjectOf);
}

const DRAFT_MESSAGE = 'anchor, text (1 a 10000 caracteres) e session (uma sessão da tarefa, ou "new") são obrigatórios';
const SESSION_MESSAGE = 'session precisa ser uma sessão da tarefa, "new" ou null';
const UNKNOWN_DRAFT_MESSAGE = 'rascunho desconhecido';

// The draft a route names, or undefined once its 404 or 500 is out
async function draftOf(subject: StoreSubject, req: Request, res: Response): Promise<string | undefined> {
  const file = await readReview(subject, res);
  const draft = file?.drafts.find((d) => d.id === req.params.draft);
  if (file && !draft) refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_DRAFT_MESSAGE });
  return draft?.id;
}

// adicionar à revisão and its editar (#591)
function registerDraftRoutes(app: Express, prefix: string, subjectOf: SubjectOf<StoreSubject>): void {
  app.post(`${prefix}/review/drafts`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const anchor = parseThreadAnchor(body.anchor);
    const text = textOf(body.text);
    const session = body.session;
    if (!anchor || text === undefined || !subject.isSession(session)) return badRequest(res, DRAFT_MESSAGE);
    const id = randomUUID();
    await writeReview(subject, res, (file) => addDraft(file, { id, anchor: pinned(file, anchor), session, text }), { id });
  });
  app.put(`${prefix}/review/drafts/:draft`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = textOf(body.text);
    const session = body.session;
    if (text === undefined || !subject.isSession(session)) return badRequest(res, DRAFT_MESSAGE);
    const id = await draftOf(subject, req, res);
    if (id !== undefined) await writeReview(subject, res, (file) => updateDraft(file, id, { text, session }));
  });
}

// A draft dropped, and sessão padrão (#591)
function registerDraftRemoval(app: Express, prefix: string, subjectOf: SubjectOf<StoreSubject>): void {
  app.delete(`${prefix}/review/drafts/:draft`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const id = await draftOf(subject, req, res);
    if (id !== undefined) await writeReview(subject, res, (file) => removeDraft(file, id));
  });
  app.put(`${prefix}/review/default-session`, async (req: Request, res: Response) => {
    const subject = subjectOf(req, res);
    if (!subject) return;
    const { session } = (req.body ?? {}) as { session?: unknown };
    if (session !== null && !subject.isSession(session)) return badRequest(res, SESSION_MESSAGE);
    await writeReview(subject, res, (file) => setDefaultSession(file, session ?? undefined));
  });
}
