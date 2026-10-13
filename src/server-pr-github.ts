import type { Express, Request, Response } from 'express';
import { activityOf } from './activities.js';
import { ciQuery, parseCi } from './ci-checks.js';
import { isNodeId, isOid, prBodyOf, prTextOf } from './pr-bodies.js';
import {
  COMMENT_MUTATION, EDIT_MUTATION, isMergeMethod, isReviewEvent, MERGE_MUTATION, mergeVariables, parseGuard, parseThreads, PR_GUARD_QUERY, PR_THREADS_QUERY,
  PrNotFound, type PrGuard, REPLY_MUTATION, RESOLVE_MUTATION, REVIEW_MUTATION, reviewVariables, UNRESOLVE_MUTATION,
} from './pr-github.js';
import { isObject } from './pr-checks.js';
import { commentFromGql, pullFromGql, reviewFromGql } from './read-model/normalize.js';
import type { WriteAnswer } from './read-model/write-answer.js';
import { clearSubmitted } from './pr-review-store.js';
import { prNumber, prRepo } from './pull-requests.js';
import { parseLineAnchor } from './review-bodies.js';
import { githubRefusal, PR_ROUTE, type PrRouteDeps, type PrTarget, prTarget, readPrFile } from './server-pr.js';
import { badRequest, refuse } from './server-review.js';
import { type AnswerOf, BODY_MAX, editOf, storeWriteAnswer, TITLE_MAX } from './server-repos.js';
import { PR_BODY_MAX, type PrReviewEventInput, REVIEW_TEXT_MAX, type Task } from './types.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_FORBIDDEN = 403;
const MERGE_NO_PERMISSION = 'sem permissão de escrita neste repositório';
const RERUN_NO_PERMISSION = 'sem permissão para re-executar neste repositório';
const NOT_OPEN_MESSAGE = 'PR não está aberto';
const STALE_MESSAGE = 'o PR mudou desde a última leitura, atualize';
const COMMENT_MESSAGE = `head (o sha que a página mostrou), anchor e text (1 a ${REVIEW_TEXT_MAX} caracteres) são obrigatórios`;
const TEXT_MESSAGE = `text precisa ter de 1 a ${REVIEW_TEXT_MAX} caracteres`;
const RESOLVE_MESSAGE = 'resolved precisa ser true ou false';
const MERGE_MESSAGE = 'method (merge, squash ou rebase) e head são obrigatórios';
const METHOD_MESSAGE = 'método de merge não permitido neste repositório';
const NOTHING_MESSAGE = 'nothing to send: a comment review needs a summary or a draft';
const REVIEW_MESSAGE = `head (o sha que a página mostrou), event (comment, approve ou request_changes) e body (até ${PR_BODY_MAX} caracteres) são obrigatórios`;
const OWN_MESSAGE = 'o GitHub não deixa aprovar o próprio PR, nem pedir mudanças nele';
const EDIT_MESSAGE = `title (1 a ${TITLE_MAX} caracteres) ou body (até ${BODY_MAX}) e o updatedAt que a página leu são obrigatórios`;
const CHANGED_MESSAGE = 'o PR mudou no GitHub desde a leitura da página, atualize';
const PR_COMMENT_MESSAGE = `body must be 1 to ${PR_BODY_MAX} characters`;
const SUBMITTING_MESSAGE = 'a revisão já está sendo enviada';
const UNKNOWN_THREAD_MESSAGE = 'conversa desconhecida';

const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

// The PR as GitHub answers it on this request, open, and at `head` when one is given: never comment on, nor merge, code the page did not
// show. The merge route also takes a merged PR (#849), which it counts as its own. A lean read (#187): the guards' fields only. Undefined once
// the refusal is out
async function openPr(deps: PrRouteDeps, res: Response, url: string, head?: string, { allowMerged = false }: { allowMerged?: boolean } = {}): Promise<PrGuard | undefined> {
  let view: PrGuard;
  try {
    view = parseGuard(await deps.gql(PR_GUARD_QUERY, { url }));
  } catch (err) {
    githubRefusal(deps, res, err, `pr #${prNumber(url)}`);
    return undefined;
  }
  if (allowMerged && view.state === 'merged') return view;
  if (view.state !== 'open') refuse(res, { status: HTTP_CONFLICT, message: NOT_OPEN_MESSAGE });
  else if (head !== undefined && head !== view.head) refuse(res, { status: HTTP_CONFLICT, message: STALE_MESSAGE });
  else return view;
  return undefined;
}

// A mutation through gh: its data, or undefined once GitHub's refusal is out as the 502 with its message as it came (a missing scope, a merge
// queue, a moved head), logged too (#849)
async function mutate(deps: PrRouteDeps, res: Response, url: string, query: string, variables: Record<string, unknown>): Promise<{ data: unknown } | undefined> {
  try {
    return { data: await deps.gqlJson(query, variables) };
  } catch (err) {
    githubRefusal(deps, res, err, `pr #${prNumber(url)}`, 'write');
    return undefined;
  }
}

// Every write broadcasts prReview (#592): an open page on the link reads again
function done(deps: PrRouteDeps, res: Response, url: string): void {
  deps.notifyPrReview(url);
  res.json({ ok: true });
}

const at = (data: unknown, ...path: string[]): unknown => path.reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), data);

// A PR write's answer as rows (#187): the PR's issues row and flags, and what `more` adds under the PR's node id
const prAnswer = (url: string, pr: unknown, more: (source: string, pullNodeId: string) => WriteAnswer = () => ({})): AnswerOf => (source) => {
  const { issue, flags } = pullFromGql(source, prRepo(url), pr);
  return { issues: [issue], pullFlags: [flags], ...more(source, issue.nodeId) };
};
const reviewAnswer = (url: string, data: unknown): AnswerOf => {
  const review = at(data, 'addPullRequestReview', 'pullRequestReview');
  return prAnswer(url, at(review, 'pullRequest'), (source, pullNodeId) => {
    const row = reviewFromGql(source, prRepo(url), pullNodeId, review);
    return row === undefined ? {} : { reviews: [row] };
  });
};
const commentAnswer = (url: string, data: unknown): AnswerOf =>
  prAnswer(url, at(data, 'addComment', 'subject'), (source, pullNodeId) => ({ comments: [commentFromGql(source, prRepo(url), pullNodeId, at(data, 'addComment', 'commentEdge', 'node'))] }));

// GitHub took the write: its answer goes into the read model before the answer, so the next GET shows it (#187); then prReview and ok
async function doneWith(deps: PrRouteDeps, res: Response, url: string, answerOf: AnswerOf): Promise<void> {
  await storeWriteAnswer(deps, prRepo(url), answerOf);
  done(deps, res, url);
}

// enviar (#592): a review with that comment alone, published at once
function registerCommentRoute(app: Express, deps: PrRouteDeps): void {
  app.post(`${PR_ROUTE}/comment`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const { head } = bodyOf(req);
    const anchor = parseLineAnchor(bodyOf(req).anchor);
    const text = prTextOf(bodyOf(req).text);
    if (!isOid(head) || !anchor || text === undefined) return badRequest(res, COMMENT_MESSAGE);
    const view = await openPr(deps, res, found.url, head);
    const sent = view && (await mutate(deps, res, found.url, REVIEW_MUTATION, reviewVariables(view.id, head, 'comment', '', [{ anchor, text }])));
    if (sent) await doneWith(deps, res, found.url, reviewAnswer(found.url, sent.data));
  });
}

/** What the review popover sends (#758). */
interface ReviewAsk { head: string; event: PrReviewEventInput; body: string }

// The stored drafts as the threads of one review, with its event and summary; GitHub takes all of it or none, so they are cleared only once it
// did. An approval or a change request on the viewer's own PR is refused here: GitHub would refuse it after the read anyway
async function submitReview(deps: PrRouteDeps, res: Response, url: string, ask: ReviewAsk): Promise<void> {
  const file = await readPrFile(deps, res, url);
  if (!file) return;
  if (ask.event === 'comment' && file.drafts.length === 0 && ask.body === '') return refuse(res, { status: HTTP_CONFLICT, message: NOTHING_MESSAGE });
  const view = await openPr(deps, res, url, ask.head);
  if (!view) return;
  if (ask.event !== 'comment' && view.author === view.viewer) return badRequest(res, OWN_MESSAGE);
  const sent = await mutate(deps, res, url, REVIEW_MUTATION, reviewVariables(view.id, ask.head, ask.event, ask.body, file.drafts));
  if (!sent) return;
  await storeWriteAnswer(deps, prRepo(url), reviewAnswer(url, sent.data));
  // GitHub has the review by now: a failed clear must not answer 500, or the UI's retry posts it twice. The drafts stay and show again.
  try {
    await deps.prReviews.update(url, (current) => clearSubmitted(current, file.drafts.map((d) => d.id)));
  } catch (err) {
    deps.log.error(`pr review #${prNumber(url)}: the review was sent but its file could not be cleared (${err instanceof Error ? err.name : 'error'})`);
  }
  deps.notifyPrReview(url);
  res.json({ ok: true });
}

// send review (#592, #758): the popover's event and summary with every draft
function registerReviewRoute(app: Express, deps: PrRouteDeps): void {
  // One review per PR at a time (#592): GitHub takes a second as a second review. Per server, so two never share it
  const submitting = new Set<string>();
  app.post(`${PR_ROUTE}/review`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const { head, event } = bodyOf(req);
    const body = prBodyOf(bodyOf(req).body ?? '');
    if (!isOid(head) || !isReviewEvent(event) || body === undefined) return badRequest(res, REVIEW_MESSAGE);
    if (submitting.has(found.url)) return refuse(res, { status: HTTP_CONFLICT, message: SUBMITTING_MESSAGE });
    submitting.add(found.url);
    try {
      await submitReview(deps, res, found.url, { head, event, body });
    } finally {
      submitting.delete(found.url);
    }
  });
}

// The conversation a route names, one of the PR's as GitHub answers it now; undefined once the refusal is out
async function threadOn(deps: PrRouteDeps, req: Request, res: Response, url: string): Promise<string | undefined> {
  if (!(await openPr(deps, res, url))) return undefined;
  let ids: string[];
  try {
    ids = parseThreads(await deps.gql(PR_THREADS_QUERY, { url })).threads.map((thread) => thread.id);
  } catch (err) {
    githubRefusal(deps, res, err, `pr #${prNumber(url)}`);
    return undefined;
  }
  const id = req.params.thread;
  if (isNodeId(id) && ids.includes(id)) return id;
  refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_THREAD_MESSAGE });
  return undefined;
}

// A reply and resolver / reabrir (#592): straight to GitHub, one call each; a reply belongs to a public conversation, never a draft
function registerThreadRoutes(app: Express, deps: PrRouteDeps): void {
  app.post(`${PR_ROUTE}/threads/:thread/reply`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const text = prTextOf(bodyOf(req).text);
    if (text === undefined) return badRequest(res, TEXT_MESSAGE);
    const thread = await threadOn(deps, req, res, found.url);
    if (thread !== undefined && (await mutate(deps, res, found.url, REPLY_MUTATION, { thread, body: text }))) done(deps, res, found.url);
  });
  app.post(`${PR_ROUTE}/threads/:thread/resolve`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const { resolved } = bodyOf(req);
    if (typeof resolved !== 'boolean') return badRequest(res, RESOLVE_MESSAGE);
    const thread = await threadOn(deps, req, res, found.url);
    if (thread !== undefined && (await mutate(deps, res, found.url, resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { thread }))) done(deps, res, found.url);
  });
}

// #207's event with no wait for the poll, then, read again since the approval may have gone while the merge was out, #268's approve on a task
// still awaiting it: the Hive's own merge is the user's gesture of approval. No new reducer rule.
async function markMerged(deps: PrRouteDeps, res: Response, url: string, task: Task): Promise<void> {
  await deps.dispatch({ type: 'prStates', states: [{ url, state: 'merged' }] });
  const live = deps.requireLive(res);
  const awaiting = live && activityOf(live.state, task.item.itemId);
  if (awaiting?.approval) await deps.dispatch({ type: 'approve', activityId: awaiting.id });
}

// #849: a merge that finds the PR already merged (a second click, or a first merge whose follow-up failed) counts as this one: what the user
// asked is true, so the task is approved as a merge from the Hive approves it, and no mutation goes out
async function countMerged(deps: PrRouteDeps, res: Response, found: PrTarget): Promise<void> {
  deps.log.info(`pr #${prNumber(found.url)} already merged, counted as merged`);
  if (found.task !== undefined) await markMerged(deps, res, found.url, found.task);
  done(deps, res, found.url);
}

// mergear (#592): a method the repository allows, at the head the page showed; #592's rule on a task's PR. A PR without a task only merges (#758)
function registerMergeRoute(app: Express, deps: PrRouteDeps): void {
  app.post(`${PR_ROUTE}/merge`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const { method, head } = bodyOf(req);
    if (!isMergeMethod(method) || !isOid(head)) return badRequest(res, MERGE_MESSAGE);
    const view = await openPr(deps, res, found.url, head, { allowMerged: true });
    if (!view) return;
    if (view.state === 'merged') return countMerged(deps, res, found);
    if (!view.canPush) return refuse(res, { status: HTTP_FORBIDDEN, message: MERGE_NO_PERMISSION }); // #854: GitHub would refuse it after the read
    if (!view.methods.includes(method)) return badRequest(res, METHOD_MESSAGE);
    const sent = await mutate(deps, res, found.url, MERGE_MUTATION, mergeVariables(view.id, head, method));
    if (!sent) return;
    deps.log.info(`pr #${prNumber(found.url)} merged from the Hive (${method})`);
    if (found.task !== undefined) await markMerged(deps, res, found.url, found.task);
    await doneWith(deps, res, found.url, prAnswer(found.url, at(sent.data, 'mergePullRequest', 'pullRequest')));
  });
}

// The page's title and description, and a general comment (#758): straight to GitHub on an open PR. An edit checks the updatedAt the page read,
// so a newer PR on GitHub is a 409, as the issue page's (#757). ponytail: read then write, as #757's
function registerPageWrites(app: Express, deps: PrRouteDeps): void {
  app.post(PR_ROUTE, async (req: Request, res: Response) => {
    const asked = editOf(req.body);
    if (asked === undefined) return badRequest(res, EDIT_MESSAGE);
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const view = await openPr(deps, res, found.url);
    if (!view) return;
    if (view.updatedAt !== asked.updatedAt) return refuse(res, { status: HTTP_CONFLICT, message: CHANGED_MESSAGE });
    const sent = await mutate(deps, res, found.url, EDIT_MUTATION, { pr: view.id, ...asked.edit });
    if (sent) await doneWith(deps, res, found.url, prAnswer(found.url, at(sent.data, 'updatePullRequest', 'pullRequest')));
  });
  app.post(`${PR_ROUTE}/comments`, async (req: Request, res: Response) => {
    const body = prBodyOf(bodyOf(req).body);
    if (body === undefined || body === '') return badRequest(res, PR_COMMENT_MESSAGE);
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const view = await openPr(deps, res, found.url);
    const sent = view && (await mutate(deps, res, found.url, COMMENT_MUTATION, { pr: view.id, body }));
    if (sent) await doneWith(deps, res, found.url, commentAnswer(found.url, sent.data));
  });
}

// re-executar falhas (#854): the head's failed Actions runs, each once, through gh with an argv; refused without push rights on the PR's repository
function registerRerunRoute(app: Express, deps: PrRouteDeps): void {
  app.post(`${PR_ROUTE}/checks/rerun`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found || await openPr(deps, res, found.url) === undefined) return;
    const subject = `pr #${prNumber(found.url)}`;
    let read: ReturnType<typeof parseCi>[number] | undefined;
    try {
      [read] = parseCi([found.url], await deps.gql(ciQuery([found.url]) ?? ''));
    } catch (err) {
      return githubRefusal(deps, res, err, subject);
    }
    if (read === undefined) return githubRefusal(deps, res, new PrNotFound(), subject);
    if (read.canPush === false) return refuse(res, { status: HTTP_FORBIDDEN, message: RERUN_NO_PERMISSION });
    const runs = [...new Set(read.checks.flatMap((c) => (c.state === 'failure' && c.runId !== undefined ? [c.runId] : [])))];
    for (const runId of runs) {
      try {
        await deps.gh(['run', 'rerun', String(runId), '--failed', '-R', prRepo(found.url)]);
      } catch (err) {
        return githubRefusal(deps, res, err, subject, 'write');
      }
    }
    deps.notifyPrReview(found.url);
    res.json({ ok: true, runs: runs.length });
  });
}

/** The PR page's writes to GitHub (#592, #758): each reads the PR first through the lean guard, answers 409 unless it is open (a merge also takes a merged PR, #849), 502 with GitHub's message on a refusal, logged (#849), and upserts its answer into the read model (#187). */
export function registerPrGithubRoutes(app: Express, deps: PrRouteDeps): void {
  registerCommentRoute(app, deps);
  registerReviewRoute(app, deps);
  registerThreadRoutes(app, deps);
  registerMergeRoute(app, deps);
  registerRerunRoute(app, deps);
  registerPageWrites(app, deps);
}
