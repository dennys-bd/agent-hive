import type { Express, Request, Response } from 'express';
import { inBackoff } from './polling.js';
import { comment, type CommentAnswer, editIssue, IssueChanged, type IssueEdit, setLabels, UnknownLabel } from './repos/github-repos.js';
import { issueUrl, taskOfIssue } from './repos/issue-task.js';
import type { Logger } from './log.js';
import type { ReadModel, SyncKind } from './read-model/db.js';
import type { ReadModelLoop } from './read-model/loop.js';
import { commentFromGql, issueFromGql } from './read-model/normalize.js';
import { applyWriteAnswer, type WriteAnswer } from './read-model/write-answer.js';
import { issuePageOf, issuesOf, summaryOf } from './read-model/views.js';
import { listRepositories, type RepoRef } from './repos/repositories.js';
import type { GqlJson } from './sources/github-gql.js';
import { quotaFrom } from './sources/github.js';
import type { GhRateLimit } from './sources/github-queries.js';
import type { Config, Exec, RepoIssues, SourceQuota, State } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MODEL_CLOSED_MESSAGE = 'the read model is not open yet';
const NO_LOGIN_MESSAGE = 'no GitHub login';
const UNREACHABLE_MESSAGE = 'could not reach GitHub';
export const TITLE_MAX = 256; // GitHub's own cap on an issue or a PR title
export const BODY_MAX = 65_536; // GitHub's own cap on an issue body or a comment
const EDIT_MESSAGE = `title (1 to ${TITLE_MAX} characters) or body (up to ${BODY_MAX}), and the updatedAt the page read`;
const LABELS_MESSAGE = 'add and remove must be lists of label names';
const COMMENT_MESSAGE = `body must be 1 to ${BODY_MAX} characters`;
const STATE_MESSAGE = 'state must be open or closed';
const NUMBER_MESSAGE = 'number must be an issue number';
const UNKNOWN_REPOSITORY_MESSAGE = 'repository is not one the Hive lists';
const STATES: readonly RepoIssues['state'][] = ['open', 'closed'];
const ISSUE_NUMBER = /^[1-9]\d{0,9}$/;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502; // GitHub refused a read or a write the UI asked for
const QUOTA_MESSAGE = 'GitHub quota is low';

/** What the repository routes need (#757). */
export interface RepoRouteDeps {
  requireLive(res: Response): { state: State; runtime: { config: Pick<Config, 'comb'> } } | undefined;
  exec: Exec; // git remote get-url, one per workspace on each request
  gql: GqlJson; // the writes' GraphQL (gh api graphql --input -): the Hive's own login, as the PR page's writes (#592, #758); a repository is no source's
  poll(names: string[]): Promise<void>; // /sources/refresh's path, for these sources only: after a write on a task's issue
  log: Pick<Logger, 'error'>;
  readModel?: RepoReadModel; // absent: the daemon could not open the model, or setup mode (#181)
}

/** What the read routes answer from (#181), and where a write's answer goes (#183): the model, whose rows to read, the issue page's refetch
 * and the readModel event. */
export interface RepoReadModel { db: ReadModel; source(): Promise<string | undefined>; refetch: ReadModelLoop['refetch']; notify(repository: string, kinds: SyncKind[]): void }

interface Refusal { status: number; message: string }

// A failure as its answer (#757): an unknown label is a 400, an issue changed since the page read it is a 409; GitHub's refusal a 502 with its words
function refusalOf(err: unknown): Refusal {
  if (err instanceof UnknownLabel) return { status: HTTP_BAD_REQUEST, message: err.message };
  if (err instanceof IssueChanged) return { status: HTTP_CONFLICT, message: err.message };
  return { status: HTTP_BAD_GATEWAY, message: err instanceof Error ? err.message : String(err) };
}

const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

// What every route shares: the deps and the client that keeps the last quota reading. One reading for the Hive's login, in memory: lost on
// restart, and with none yet every route reads
interface RepoContext { deps: RepoRouteDeps; gql: GqlJson; quota(): SourceQuota | undefined }

function contextOf(deps: RepoRouteDeps): RepoContext {
  let quota: SourceQuota | undefined;
  const gql: GqlJson = async (query, variables) => {
    const data = await deps.gql(query, variables);
    quota = quotaFrom((data as { rateLimit?: GhRateLimit | null } | null)?.rateLimit) ?? quota;
    return data;
  };
  return { deps, gql, quota: () => quota };
}

// The live state and the repositories it lists, or undefined once the refusal is out: no config (requireLive's 409)
async function listed(ctx: RepoContext, res: Response): Promise<{ state: State; refs: RepoRef[] } | undefined> {
  const live = ctx.deps.requireLive(res);
  if (!live) return undefined;
  return { state: live.state, refs: await listRepositories(live.runtime.config, live.state, ctx.deps.exec) };
}

// The repository a route's :owner/:name names, one listRepositories gives, or undefined once the refusal is out: the Hive's login reads and
// writes only the repositories the Hive lists
async function named(ctx: RepoContext, req: Request, res: Response): Promise<{ state: State; repository: string } | undefined> {
  const found = await listed(ctx, res);
  if (!found) return undefined;
  const repository = `${req.params.owner as string}/${req.params.name as string}`;
  if (found.refs.some((ref) => ref.repository === repository)) return { state: found.state, repository };
  refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_REPOSITORY_MESSAGE });
  return undefined;
}

// The route's :number, a positive integer, or undefined
function numberOf(req: Request): number | undefined {
  const raw = req.params.number;
  // the raw text, not Number(): 1e2, 0x10 and 01 all parse to an integer yet name no issue the URL spells
  return typeof raw === 'string' && ISSUE_NUMBER.test(raw) ? Number(raw) : undefined;
}

/** An edit's body (#757, #758): the updatedAt the page read, and a non-empty title of up to TITLE_MAX characters or a body of up to BODY_MAX, or both; an issue's or a PR's. */
export function editOf(raw: unknown): { edit: IssueEdit; updatedAt: string } | undefined {
  const { title, body, updatedAt } = (raw ?? {}) as Record<string, unknown>;
  if (typeof updatedAt !== 'string' || (title === undefined && body === undefined)) return undefined;
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > TITLE_MAX)) return undefined;
  if (body !== undefined && (typeof body !== 'string' || body.length > BODY_MAX)) return undefined;
  return { edit: { ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }) }, updatedAt };
}

const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string');
const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

interface Target { state: State; repository: string; number: number }

// After a write on an issue that is a task of a source: that source polled, so the flow shows the new title or labels at once (#757)
async function pollOwner(ctx: RepoContext, { state, repository, number }: Target): Promise<void> {
  const source = taskOfIssue(state.tasks, issueUrl(repository, number))?.item.source;
  if (source !== undefined) await ctx.deps.poll([source]);
}

// A write's confirmed answer as rows, under the source the reads use: the source is read only once GitHub took the write (#183)
type AnswerOf = (source: string) => WriteAnswer;

const issueAnswer = (repository: string, issue: unknown): AnswerOf => (source) => ({ issues: [issueFromGql(source, repository, issue)] });

// The comment's row goes under the node id of the issue the same answer brings
const commentAnswer = (repository: string, answer: CommentAnswer): AnswerOf => (source) => {
  const issue = issueFromGql(source, repository, answer.issue);
  return { issues: [issue], comments: [commentFromGql(source, repository, issue.nodeId, answer.comment)] };
};

// The answer into the read model, so the next GET shows it (#183). GitHub already took the write: a failure here (a malformed answer, the
// store) is only logged, and the next round brings the row. No model or no login: nothing stored, the sync catches up
async function storeAnswer(ctx: RepoContext, repository: string, answerOf: AnswerOf | undefined): Promise<void> {
  const model = ctx.deps.readModel;
  if (model === undefined || answerOf === undefined) return;
  try {
    const source = await model.source();
    if (source !== undefined) applyWriteAnswer(model, repository, answerOf(source));
  } catch (err) {
    ctx.deps.log.error(`repositories: the answer of a write on ${repository} was not stored: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// A write's answer: { ok: true } once GitHub took it and its answer is in the read model (#183); the poll when `pollAfter` runs after the
// answer, so a slow or failing poll never turns a write GitHub took into a refusal; its failure the refusal it maps to
async function write(ctx: RepoContext, res: Response, target: Target, run: () => Promise<AnswerOf | undefined>, pollAfter: boolean): Promise<void> {
  if (inQuotaBackoff(ctx, res)) return;
  let answerOf: AnswerOf | undefined;
  try {
    answerOf = await run();
  } catch (err) {
    return refuse(res, refusalOf(err));
  }
  await storeAnswer(ctx, target.repository, answerOf);
  res.json({ ok: true });
  if (pollAfter) {
    pollOwner(ctx, target).catch((err: unknown) => {
      ctx.deps.log.error(`repositories: the poll after a write on ${target.repository}#${target.number} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// The issue page's writes (#757), each straight to GitHub with the Hive's login, the body checked before GitHub is asked; each answer upserted into the read model (#183)
function registerWriteRoutes(app: Express, ctx: RepoContext): void {
  app.post('/repositories/:owner/:name/issues/:number', async (req: Request, res: Response) => {
    const number = numberOf(req);
    const body = editOf(req.body);
    if (number === undefined || body === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: EDIT_MESSAGE });
    const found = await named(ctx, req, res);
    if (found) await write(ctx, res, { ...found, number }, async () => issueAnswer(found.repository, await editIssue(ctx.gql, found.repository, number, body.edit, body.updatedAt)), true);
  });
  app.post('/repositories/:owner/:name/issues/:number/labels', async (req: Request, res: Response) => {
    const number = numberOf(req);
    const { add, remove } = bodyOf(req);
    if (number === undefined || !isNames(add) || !isNames(remove)) return refuse(res, { status: HTTP_BAD_REQUEST, message: LABELS_MESSAGE });
    const found = await named(ctx, req, res);
    if (!found) return;
    await write(ctx, res, { ...found, number }, async () => {
      const labelable = await setLabels(ctx.gql, found.repository, number, add, remove);
      return labelable === undefined ? undefined : issueAnswer(found.repository, labelable); // nothing sent: nothing to store
    }, true);
  });
  // A comment changes nothing the flow shows: no poll
  app.post('/repositories/:owner/:name/issues/:number/comments', async (req: Request, res: Response) => {
    const number = numberOf(req);
    const { body } = bodyOf(req);
    if (number === undefined || typeof body !== 'string' || body.trim() === '' || body.length > BODY_MAX) return refuse(res, { status: HTTP_BAD_REQUEST, message: COMMENT_MESSAGE });
    const found = await named(ctx, req, res);
    if (found) await write(ctx, res, { ...found, number }, async () => commentAnswer(found.repository, await comment(ctx.gql, found.repository, number, body)), false);
  });
}

// The writes' GraphQL backoff (#757): under QUOTA_RESERVE before its reset a write is refused; the reads make no GraphQL call (#181)
function inQuotaBackoff(ctx: RepoContext, res: Response): boolean {
  const quota = ctx.quota();
  if (!inBackoff({ quota }, Date.now())) return false;
  res.status(HTTP_TOO_MANY_REQUESTS).json({ error: QUOTA_MESSAGE, resetsAt: quota?.resetsAt });
  return true;
}

interface Reading { model: RepoReadModel; source: string }

// The read model and whose rows to read, or undefined once the 503 is out: a read never falls back to GitHub (#181)
async function readingOf(ctx: RepoContext, res: Response): Promise<Reading | undefined> {
  const model = ctx.deps.readModel;
  if (model === undefined) return void refuse(res, { status: HTTP_SERVICE_UNAVAILABLE, message: MODEL_CLOSED_MESSAGE });
  let source: string | undefined;
  try {
    source = await model.source();
  } catch (err) {
    ctx.deps.log.error(`repositories: the read model's source could not be read: ${err instanceof Error ? err.message : String(err)}`); // the text stays in the log: a store error may name a path
  }
  if (source === undefined) return void refuse(res, { status: HTTP_SERVICE_UNAVAILABLE, message: NO_LOGIN_MESSAGE });
  return { model, source };
}

type NamedReading = Reading & { repository: string };

async function namedReading(ctx: RepoContext, req: Request, res: Response): Promise<NamedReading | undefined> {
  const found = await named(ctx, req, res);
  const reading = found && (await readingOf(ctx, res));
  return found && reading ? { ...reading, repository: found.repository } : undefined;
}

// The issue page (#181): a stored row at once, its refetch started and not awaited (the loop logs a failure; a change comes back as a
// readModel event); a missing one waits for the refetch, so an issue the sync has not reached yet is no 404
async function issuePage(res: Response, reading: NamedReading, number: number): Promise<void> {
  const { model, source, repository } = reading;
  const stored = issuePageOf(model.db, source, repository, number);
  if (stored !== undefined) {
    void model.refetch(repository, number);
    res.json(stored);
    return;
  }
  const outcome = await model.refetch(repository, number);
  // a round may have stored it meanwhile: only a row still missing is refused
  const page = outcome === 'gone' ? undefined : issuePageOf(model.db, source, repository, number);
  if (page !== undefined) {
    res.json(page);
    return;
  }
  if (outcome === 'failed' || outcome === 'skipped') return refuse(res, { status: HTTP_SERVICE_UNAVAILABLE, message: UNREACHABLE_MESSAGE });
  refuse(res, { status: HTTP_NOT_FOUND, message: `issue not found: ${repository}#${number}` });
}

// GET /repositories and a repository's issues, page and labels (#757), from the read model alone (#181)
function registerReadRoutes(app: Express, ctx: RepoContext): void {
  app.get('/repositories', async (_req: Request, res: Response) => {
    const found = await listed(ctx, res);
    const reading = found && (await readingOf(ctx, res));
    if (found && reading) res.json(found.refs.map((ref) => summaryOf(reading.model.db, reading.source, ref)));
  });
  app.get('/repositories/:owner/:name/issues', async (req: Request, res: Response) => {
    const state = STATES.find((s) => s === req.query.state);
    if (state === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: STATE_MESSAGE });
    const reading = await namedReading(ctx, req, res);
    if (reading) res.json(issuesOf(reading.model.db, reading.source, reading.repository, state));
  });
  app.get('/repositories/:owner/:name/issues/:number', async (req: Request, res: Response) => {
    const number = numberOf(req);
    if (number === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: NUMBER_MESSAGE });
    const reading = await namedReading(ctx, req, res);
    if (reading) await issuePage(res, reading, number);
  });
  app.get('/repositories/:owner/:name/labels', async (req: Request, res: Response) => {
    const reading = await namedReading(ctx, req, res);
    if (reading) res.json(reading.model.db.labels(reading.source, reading.repository));
  });
}

/** The repositories' routes (#757): read from the read model (#181), written with the Hive's own login (#757). */
export function registerRepoRoutes(app: Express, deps: RepoRouteDeps): void {
  const ctx = contextOf(deps);
  registerReadRoutes(app, ctx);
  registerWriteRoutes(app, ctx);
}
