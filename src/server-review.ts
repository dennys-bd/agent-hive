import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { isScope } from './diff.js';
import { isHash, isPath, isTaskSession, parseThreadAnchor, textOf } from './review-bodies.js';
import { addDraft, markReviewed, pinned, removeDraft, setDefaultSession, updateDraft } from './review-store.js';
import { type TaskRouteDeps, type Refusal, UNKNOWN_TASK_MESSAGE } from './server-tasks.js';
import type { Task, ReviewFile, State } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const MARK_MESSAGE = 'scope deve ser stage, worktree ou commit, path um texto não vazio, hash um sha256 e reviewed true ou false';

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

export const liveTask = (deps: Pick<TaskRouteDeps, 'requireLive'>, req: Request, res: Response): Task | undefined => liveTaskIn(deps, req, res)?.task;

/** An edit of the task's file then its review event (#591); the file as written, or undefined once a store failure answered 500. */
export async function storeEdit(deps: ReviewRouteDeps, res: Response, itemId: string, edit: (file: ReviewFile) => ReviewFile): Promise<ReviewFile | undefined> {
  let file: ReviewFile;
  try {
    file = await deps.reviews.update(itemId, edit);
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
    return undefined;
  }
  deps.notifyReview(itemId);
  return file;
}

/** storeEdit, then `answer`. */
export async function writeReview(deps: ReviewRouteDeps, res: Response, itemId: string, edit: (file: ReviewFile) => ReviewFile, answer: unknown = { ok: true }): Promise<void> {
  if (await storeEdit(deps, res, itemId, edit)) res.json(answer);
}

/** The task's file as stored (#591), or undefined once its 500 is out. */
export async function readReview(deps: ReviewRouteDeps, res: Response, itemId: string): Promise<ReviewFile | undefined> {
  try {
    return await deps.reviews.read(itemId);
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
    return undefined;
  }
}

/** GET /tasks/:id/review and POST /tasks/:id/review/reviewed (#591). */
export function registerReviewRoutes(app: Express, deps: ReviewRouteDeps): void {
  app.get('/tasks/:id/review', async (req: Request, res: Response) => {
    const task = liveTask(deps, req, res);
    if (!task) return;
    const file = await readReview(deps, res, task.item.itemId);
    if (file) res.json(file);
  });
  app.post('/tasks/:id/review/reviewed', async (req: Request, res: Response) => {
    const task = liveTask(deps, req, res);
    if (!task) return;
    const { scope, path, hash, reviewed } = (req.body ?? {}) as Record<string, unknown>;
    if (!isScope(scope) || !isPath(path) || !isHash(hash) || typeof reviewed !== 'boolean') return badRequest(res, MARK_MESSAGE);
    await writeReview(deps, res, task.item.itemId, (file) => markReviewed(file, { scope, path, hash }, reviewed));
  });
  registerDraftRoutes(app, deps);
  registerDraftRemoval(app, deps);
}

const DRAFT_MESSAGE = 'anchor, text (1 a 10000 caracteres) e session (uma sessão da tarefa, ou "new") são obrigatórios';
const SESSION_MESSAGE = 'session precisa ser uma sessão da tarefa, "new" ou null';
const UNKNOWN_DRAFT_MESSAGE = 'rascunho desconhecido';

// The draft a route names, or undefined once its 404 or 500 is out
async function draftOf(deps: ReviewRouteDeps, req: Request, res: Response, task: Task): Promise<string | undefined> {
  const file = await readReview(deps, res, task.item.itemId);
  const draft = file?.drafts.find((d) => d.id === req.params.draft);
  if (file && !draft) refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_DRAFT_MESSAGE });
  return draft?.id;
}

// adicionar à revisão and its editar (#591)
function registerDraftRoutes(app: Express, deps: ReviewRouteDeps): void {
  app.post('/tasks/:id/review/drafts', async (req: Request, res: Response) => {
    const found = liveTaskIn(deps, req, res);
    if (!found) return;
    const { task, state } = found;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const anchor = parseThreadAnchor(body.anchor);
    const text = textOf(body.text);
    const session = body.session;
    if (!anchor || text === undefined || !isTaskSession(state, task.item.itemId, session)) return badRequest(res, DRAFT_MESSAGE);
    const id = randomUUID();
    await writeReview(deps, res, task.item.itemId, (file) => addDraft(file, { id, anchor: pinned(file, anchor), session, text }), { id });
  });
  app.put('/tasks/:id/review/drafts/:draft', async (req: Request, res: Response) => {
    const found = liveTaskIn(deps, req, res);
    if (!found) return;
    const { task, state } = found;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = textOf(body.text);
    const session = body.session;
    if (text === undefined || !isTaskSession(state, task.item.itemId, session)) return badRequest(res, DRAFT_MESSAGE);
    const id = await draftOf(deps, req, res, task);
    if (id !== undefined) await writeReview(deps, res, task.item.itemId, (file) => updateDraft(file, id, { text, session }));
  });
}

// A draft dropped, and sessão padrão (#591)
function registerDraftRemoval(app: Express, deps: ReviewRouteDeps): void {
  app.delete('/tasks/:id/review/drafts/:draft', async (req: Request, res: Response) => {
    const task = liveTask(deps, req, res);
    if (!task) return;
    const id = await draftOf(deps, req, res, task);
    if (id !== undefined) await writeReview(deps, res, task.item.itemId, (file) => removeDraft(file, id));
  });
  app.put('/tasks/:id/review/default-session', async (req: Request, res: Response) => {
    const found = liveTaskIn(deps, req, res);
    if (!found) return;
    const { task, state } = found;
    const { session } = (req.body ?? {}) as { session?: unknown };
    if (session !== null && !isTaskSession(state, task.item.itemId, session)) return badRequest(res, SESSION_MESSAGE);
    await writeReview(deps, res, task.item.itemId, (file) => setDefaultSession(file, session ?? undefined));
  });
}
