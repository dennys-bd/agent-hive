import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { activityOf, taskOfPr } from './activities.js';
import { taskWorkspace } from './config.js';
import { DIFF_MAX_BYTES, DiffTooLarge, parseDiff, withHash } from './diff.js';
import { workspaceBase } from './fork.js';
import { prTextOf } from './pr-bodies.js';
import { parseThreads, PR_THREADS_QUERY, prDiffArgs, PrNotFound, requestTimesOf, timelineArgs, withRequestTimes } from './pr-github.js';
import { conflictedFiles } from './pr-conflicts.js';
import { addPrDraft, dropStalePrMarks, markPrReviewed, type PrReviewStore, removePrDraft, updatePrDraft } from './pr-review-store.js';
import { prLink, prNumber, prRepo } from './pull-requests.js';
import { sourceLogin } from './read-model/rows.js';
import { prDataOf, type StoredPr } from './read-model/views.js';
import { listRepositories, type RepoRef } from './repos/repositories.js';
import { isHash, isPath, parseLineAnchor } from './review-bodies.js';
import { readingOf, type Reading, type RepoReadModel } from './server-repos.js';
import { badRequest, errorMessage, refuse } from './server-review.js';
import type { LiveView, Refusal, TaskRouteDeps } from './server-tasks.js';
import type { Exec as GhExec, GqlJson } from './sources/github-gql.js';
import type { Logger } from './log.js';
import { type FileDiff, type Gql, type PrChecksRead, type PrData, type PrReviewFile, type PrReviewRequest, REVIEW_TEXT_MAX, type State, type Task } from './types.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
// the raw text, as #757's issue number: 1e2, 0x10 and 07 all parse to a number yet name no PR the URL spells
const PR_NUMBER = /^[1-9]\d{0,9}$/;
const NUMBER_MESSAGE = 'number must be a PR number';
const UNKNOWN_REPOSITORY_MESSAGE = 'repository is not one the Hive lists';
const HEAD_MOVED_MESSAGE = 'o PR mudou durante a leitura, atualize';
const TOO_LARGE_MESSAGE = 'diff grande demais para o visualizador'; // #270's words
const MARK_MESSAGE = 'path um texto não vazio, hash um sha256 e reviewed true ou false';
const DRAFT_MESSAGE = `anchor e text (1 a ${REVIEW_TEXT_MAX} caracteres) são obrigatórios`;
const TEXT_MESSAGE = `text precisa ter de 1 a ${REVIEW_TEXT_MAX} caracteres`;
const UNKNOWN_DRAFT_MESSAGE = 'rascunho desconhecido';

/** Every PR route's path (#758): the PR under a repository GET /repositories lists, by its number. */
export const PR_ROUTE = '/repositories/:owner/:name/pulls/:number';

/** What the PR routes read (#592, #758): the live state, the dispatch (a merge), git (the repositories' origins, the conflicted files), the
 * PR review files and their event, and gh, whatever auth.github says: the login the workers open their PRs with. */
export interface PrRouteDeps extends Pick<TaskRouteDeps, 'requireLive' | 'dispatch' | 'exec'> {
  log: Pick<Logger, 'debug' | 'error' | 'info' | 'warn'>; // warn: a refused GitHub call (#849)
  prReviews: PrReviewStore;
  notifyPrReview(url: string): void; // the named `prReview` event on /events after every write
  gql: Gql; // the reads: gh api graphql with its flags
  gqlJson: GqlJson; // the writes: gh api graphql --input -
  gh: GhExec; // the diff's gh api call
  readModel?: RepoReadModel; // #187: the page's reads and the writes' answers; absent (setup mode, a failed open): the reads answer 503
}

// A head that moved twice while GET …/pulls/:number read it (#592)
class HeadMoved extends Error {
  constructor() {
    super('the head moved while the PR was read');
    this.name = 'HeadMoved';
  }
}

/** A failed GitHub read or write as its answer (#592): no PR, a moving head, an oversized diff, or GitHub's own message as a 502. gh prints
 * no token, so the message carries none. */
export function githubFailure(err: unknown): Refusal {
  if (err instanceof PrNotFound) return { status: HTTP_NOT_FOUND, message: err.message };
  if (err instanceof HeadMoved) return { status: HTTP_CONFLICT, message: HEAD_MOVED_MESSAGE };
  if (err instanceof DiffTooLarge) return { status: HTTP_TOO_LARGE, message: TOO_LARGE_MESSAGE };
  return { status: HTTP_BAD_GATEWAY, message: errorMessage(err) };
}

/** githubFailure's answer (#849): a 502 first leaves GitHub's message in hive.log under `subject` (`pr #<n>`, or `pulls <owner>/<name>`), since
 * http.error carries no body (#742). gh prints no token, so the line carries none. */
export function githubRefusal(deps: Pick<PrRouteDeps, 'log'>, res: Response, err: unknown, subject: string, what: 'read' | 'write' = 'read'): void {
  const refusal = githubFailure(err);
  if (refusal.status === HTTP_BAD_GATEWAY) deps.log.warn(`${subject}: GitHub refused the ${what}: ${refusal.message.replace(/\s+/g, ' ')}`); // one line: GitHub echoes names (a ref) that may hold a newline
  refuse(res, refusal);
}

/** The repository a route's :owner/:name names (#758): one GET /repositories lists, #757's guard, with its ref (#854: its role and pair) and the
 * live config; undefined once its 404 is out. The Hive reads and writes the PRs of the repositories it lists only. */
export async function listedRepository(deps: Pick<PrRouteDeps, 'requireLive' | 'exec'>, req: Request, res: Response): Promise<{ state: State; repository: string; ref: RepoRef; config: LiveView['runtime']['config'] } | undefined> {
  const live = deps.requireLive(res);
  if (!live) return undefined;
  const repository = `${req.params.owner as string}/${req.params.name as string}`;
  const ref = (await listRepositories(live.runtime.config, live.state, deps.exec)).find((r) => r.repository === repository);
  if (ref) return { state: live.state, repository, ref, config: live.runtime.config };
  refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_REPOSITORY_MESSAGE });
  return undefined;
}

/** The PR a route names (#758): its link, the State and the live config it was named in, and the task that holds it, when one does. */
export interface PrTarget { url: string; state: State; config: LiveView['runtime']['config']; task?: Task }

/** The PR a route's :owner/:name/:number names, or undefined once the refusal is out: a malformed number 400, an unlisted repository 404. No
 * task is needed: a PR without one is read, reviewed and merged the same way. */
export async function prTarget(deps: Pick<PrRouteDeps, 'requireLive' | 'exec'>, req: Request, res: Response): Promise<PrTarget | undefined> {
  const raw = req.params.number;
  if (typeof raw !== 'string' || !PR_NUMBER.test(raw)) {
    badRequest(res, NUMBER_MESSAGE);
    return undefined;
  }
  const listed = await listedRepository(deps, req, res);
  if (!listed) return undefined;
  const url = prLink(listed.repository, Number(raw));
  const task = taskOfPr(listed.state, url);
  return { url, state: listed.state, config: listed.config, ...(task === undefined ? {} : { task }) };
}

// The diff GitHub holds, capped as #270's. ponytail: gh's own 20 MB buffer answers a larger one with its overflow, a 502
function cappedFiles(text: string): FileDiff[] {
  if (Buffer.byteLength(text, 'utf8') > DIFF_MAX_BYTES) throw new DiffTooLarge();
  return parseDiff(text).map(withHash);
}

// How far the base moved past the head (#854, #187): REST's compare, for every open PR now that no GraphQL read asks it. A deleted fork has no
// head to compare; a failure is no number
async function behindOf(deps: Pick<PrRouteDeps, 'gh'>, url: string, data: StoredPr): Promise<Pick<PrData, 'behindBy'>> {
  if (data.state !== 'open' || data.headOwner === '') return {};
  try {
    const compare = JSON.parse(await deps.gh(['api', `repos/${prRepo(url)}/compare/${encodeURIComponent(data.baseRef)}...${encodeURIComponent(data.headOwner)}:${encodeURIComponent(data.headRef)}`])) as { behind_by?: unknown };
    return typeof compare.behind_by === 'number' ? { behindBy: compare.behind_by } : {};
  } catch {
    return {};
  }
}

// When each pending request was made (#67, #187): the timeline's review_requested events, read only when a request is pending; a failure only
// drops the times
async function requestsOf(deps: Pick<PrRouteDeps, 'gh'>, url: string, data: StoredPr): Promise<PrReviewRequest[]> {
  if (data.reviewRequests.length === 0) return [];
  try {
    return withRequestTimes(data.reviewRequests, requestTimesOf(await deps.gh(timelineArgs(prRepo(url), Number(prNumber(url))))));
  } catch {
    return data.reviewRequests;
  }
}

/** GET …/pulls/:number's read (#187): the refetch (conditional; its failure is the loop's log line, and the model answers), the page from the
 * model, the diff, then the threads with the head they were read at. The diff carries no oid, so a head that moved past the stored one is
 * refetched and read once more, and a second move is HeadMoved, unless that refetch did not succeed: then the model answers at the threads' head. Then the compare and the request times. An item the parser skips is a debug
 * line, by number, never the link. */
export async function readPr(deps: Pick<PrRouteDeps, 'gql' | 'gh' | 'log'>, reading: Reading, url: string): Promise<PrData> {
  const repository = prRepo(url);
  const number = Number(prNumber(url)); // prNumber is the text of a link a route checked: digits
  const skip = (reason: string): void => deps.log.debug(`pr #${number}: an item skipped (${reason})`);
  for (const again of [false, true]) {
    const outcome = await reading.model.refetch(repository, number, { again });
    const page = reading.model.db.prPage(reading.source, repository, number);
    if (page === undefined) throw new PrNotFound();
    const files = cappedFiles(await deps.gh(prDiffArgs(url)));
    const read = parseThreads(await deps.gql(PR_THREADS_QUERY, { url }), skip);
    const head = page.pull?.headSha ?? read.head; // never polled (its refetch failed): the threads' head is all there is
    // A second mismatch is the PR moving again only when the refetch read GitHub; one that failed or was skipped left the model behind, and the
    // diff just read matches the threads' head
    const refetched = outcome !== 'failed' && outcome !== 'skipped';
    if (read.head !== head && (!again || refetched)) continue;
    const stored = { ...prDataOf(page, sourceLogin(reading.source)), head: read.head };
    const [behind, reviewRequests] = await Promise.all([behindOf(deps, url, stored), requestsOf(deps, url, stored)]);
    return { ...stored, ...behind, reviewRequests, threads: read.threads, truncated: read.truncated, files };
  }
  throw new HeadMoved();
}

// The conflicted files of a PR in conflict (#758), from its task's worktree; none on any other PR, without a task or without a worktree
async function conflictsOf(deps: PrRouteDeps, found: PrTarget, data: PrData): Promise<string[] | undefined> {
  if (data.mergeState !== 'conflicts' || found.task === undefined) return undefined;
  const live = activityOf(found.state, found.task.item.itemId);
  if (live?.worktree === undefined || live.worktreeGone) return undefined;
  const remote = workspaceBase(found.config, taskWorkspace(found.config, found.task)).remote; // #854: the PR's base is on the base remote
  return conflictedFiles(live.worktree, data.baseRef, data.head, deps.exec, deps.log, remote);
}

/** The PR's file as stored (#592), or undefined once its 500 is out. */
export async function readPrFile(deps: Pick<PrRouteDeps, 'prReviews'>, res: Response, url: string): Promise<PrReviewFile | undefined> {
  try {
    return await deps.prReviews.read(url);
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
    return undefined;
  }
}

/** An edit of the PR's file, its prReview event, then `answer` (#592); false once a store failure answered 500. */
export async function writePrFile(deps: Pick<PrRouteDeps, 'prReviews' | 'notifyPrReview'>, res: Response, url: string, edit: (file: PrReviewFile) => PrReviewFile, answer: unknown = { ok: true }): Promise<boolean> {
  try {
    await deps.prReviews.update(url, edit);
  } catch (err) {
    refuse(res, { status: HTTP_SERVER_ERROR, message: errorMessage(err) });
    return false;
  }
  deps.notifyPrReview(url);
  res.json(answer);
  return true;
}

// The marks whose file changed or left the diff go once the answer is out (#592), broadcast only when some went; a fixed log line, since a
// JSON error of the file quotes its content
async function dropStale(deps: PrRouteDeps, url: string, files: FileDiff[]): Promise<void> {
  try {
    const current = await deps.prReviews.read(url);
    if (dropStalePrMarks(current, files) === current) return;
    await deps.prReviews.update(url, (file) => dropStalePrMarks(file, files));
    deps.notifyPrReview(url);
  } catch (err) {
    deps.log.error(`pr review #${prNumber(url)}: the stale marks could not be dropped (${err instanceof Error ? err.name : 'error'})`);
  }
}

const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

// GET …/pulls/:number and its review file. Only the latest read of a PR drops marks: an older one finishing late would drop a mark made against
// a newer diff. ponytail: one entry per link, never pruned
function registerReadRoutes(app: Express, deps: PrRouteDeps): void {
  const latest = new Map<string, number>();
  app.get(PR_ROUTE, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    const reading = found && (await readingOf(deps, res));
    if (!found || !reading) return;
    const mine = (latest.get(found.url) ?? 0) + 1;
    latest.set(found.url, mine);
    try {
      const data = await readPr(deps, reading, found.url);
      const conflicts = await conflictsOf(deps, found, data);
      res.json(conflicts === undefined ? data : { ...data, conflicts });
      if (latest.get(found.url) === mine) await dropStale(deps, found.url, data.files);
    } catch (err) {
      githubRefusal(deps, res, err, `pr #${prNumber(found.url)}`);
    }
  });
  app.get(`${PR_ROUTE}/review`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const file = await readPrFile(deps, res, found.url);
    if (file) res.json(file);
  });
}

// revisado and adicionar à revisão (#592); the review's summary is sent with it, never stored (#758)
function registerFileRoutes(app: Express, deps: PrRouteDeps): void {
  app.post(`${PR_ROUTE}/reviewed`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const { path, hash, reviewed } = bodyOf(req);
    if (!isPath(path) || !isHash(hash) || typeof reviewed !== 'boolean') return badRequest(res, MARK_MESSAGE);
    await writePrFile(deps, res, found.url, (file) => markPrReviewed(file, { path, hash }, reviewed));
  });
  app.post(`${PR_ROUTE}/drafts`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const anchor = parseLineAnchor(bodyOf(req).anchor);
    const text = prTextOf(bodyOf(req).text);
    if (!anchor || text === undefined) return badRequest(res, DRAFT_MESSAGE);
    const draft = { id: randomUUID(), anchor, text };
    await writePrFile(deps, res, found.url, (file) => addPrDraft(file, draft), { id: draft.id });
  });
}

// The draft a route names, or undefined once its 404 or 500 is out
async function draftOf(deps: PrRouteDeps, req: Request, res: Response, url: string): Promise<string | undefined> {
  const file = await readPrFile(deps, res, url);
  const draft = file?.drafts.find((d) => d.id === req.params.draft);
  if (file && !draft) refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_DRAFT_MESSAGE });
  return draft?.id;
}

// editar and a draft sent now or dropped (#592)
function registerDraftEdits(app: Express, deps: PrRouteDeps): void {
  app.put(`${PR_ROUTE}/drafts/:draft`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const text = prTextOf(bodyOf(req).text);
    if (text === undefined) return badRequest(res, TEXT_MESSAGE);
    const id = await draftOf(deps, req, res, found.url);
    if (id !== undefined) await writePrFile(deps, res, found.url, (file) => updatePrDraft(file, id, text));
  });
  app.delete(`${PR_ROUTE}/drafts/:draft`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    if (!found) return;
    const id = await draftOf(deps, req, res, found.url);
    if (id !== undefined) await writePrFile(deps, res, found.url, (file) => removePrDraft(file, id));
  });
}

// The checks the open page reloads on a readModel event (#758, #187): from the model, no GitHub call
function registerChecksRoute(app: Express, deps: PrRouteDeps): void {
  app.get(`${PR_ROUTE}/checks`, async (req: Request, res: Response) => {
    const found = await prTarget(deps, req, res);
    const reading = found && (await readingOf(deps, res));
    if (!found || !reading) return;
    const page = reading.model.db.prPage(reading.source, prRepo(found.url), Number(prNumber(found.url)));
    if (page === undefined) return refuse(res, githubFailure(new PrNotFound()));
    const { checks, mergeState, updatedAt } = prDataOf(page, sourceLogin(reading.source));
    const answer: PrChecksRead = { mergeState, updatedAt, ...(checks === undefined ? {} : { checks }) };
    res.json(answer);
  });
}

/** The PR page's reads, its review file and its checks (#592, #758, #187): every route names the PR by its repository and number. */
export function registerPrRoutes(app: Express, deps: PrRouteDeps): void {
  registerReadRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerDraftEdits(app, deps);
  registerChecksRoute(app, deps);
}
