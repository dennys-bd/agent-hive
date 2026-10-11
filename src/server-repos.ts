import type { Express, Request, Response } from 'express';
import { inBackoff } from './polling.js';
import { comment, editIssue, IssueChanged, type IssueEdit, readIssue, readIssues, readLabels, readSummaries, setLabels, UnknownLabel } from './repos/github-repos.js';
import { issueUrl, taskOfIssue } from './repos/issue-task.js';
import type { Logger } from './log.js';
import { listRepositories, type RepoRef } from './repos/repositories.js';
import type { GqlJson } from './sources/github-gql.js';
import { quotaFrom } from './sources/github.js';
import type { GhRateLimit } from './sources/github-queries.js';
import type { ReadModel } from './read-model/db.js';
import { commentFromGql, issueFromGql } from './read-model/normalize.js';
import { issuePageView, issuesView } from './read-model/views.js';
import type { Config, Exec, RepoIssues, SourceQuota, State } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
export const TITLE_MAX = 256; // GitHub's own cap on an issue or a PR title
export const BODY_MAX = 65_536; // GitHub's own cap on an issue body or a comment
const EDIT_MESSAGE = `title (1 to ${TITLE_MAX} characters) or body (up to ${BODY_MAX}), and the updatedAt the page read`;
const LABELS_MESSAGE = 'add and remove must be lists of label names';
const COMMENT_MESSAGE = `body must be 1 to ${BODY_MAX} characters`;
const STATE_MESSAGE = 'state must be open or closed';
const NUMBER_MESSAGE = 'number must be an issue number';
const UNKNOWN_REPOSITORY_MESSAGE = 'repository is not one the Hive lists';
const ISSUE_NOT_STORED = 'issue not in the read model yet';
const STATES: readonly RepoIssues['state'][] = ['open', 'closed'];
const ISSUE_NUMBER = /^[1-9]\d{0,9}$/;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502; // GitHub refused a read or a write the UI asked for
const QUOTA_MESSAGE = 'GitHub quota is low';

/** The read model the repository views answer from (#765 spike): its rows for the Hive's login, and an issue's refetch, whose result comes
 * back as a readModel event. */
export interface RepoReadModel { db: ReadModel; source: string; refetch(repository: string, number: number): void }

/** What the repository routes need (#757). */
export interface RepoRouteDeps {
  requireLive(res: Response): { state: State; runtime: { config: Pick<Config, 'comb'> } } | undefined;
  exec: Exec; // git remote get-url, one per workspace on each request
  gql: GqlJson; // gh api graphql --input -: the Hive's own login, as the PR page's writes (#592, #758); a repository is no source's
  poll(names: string[]): Promise<void>; // /sources/refresh's path, for these sources only: after a write on a task's issue
  log: Pick<Logger, 'error'>;
  readModel?: RepoReadModel; // #765 spike: absent (every #757 test, setup mode), the views read GitHub as before
}

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

// The live state and the repositories it lists, or undefined once the refusal is out: no config (requireLive's 409), or the quota under
// QUOTA_RESERVE before its reset, the shape inBackoff checks for a source
async function listed(ctx: RepoContext, res: Response): Promise<{ state: State; refs: RepoRef[] } | undefined> {
  const live = ctx.deps.requireLive(res);
  if (!live) return undefined;
  const quota = ctx.quota();
  if (inBackoff({ quota }, Date.now())) {
    res.status(HTTP_TOO_MANY_REQUESTS).json({ error: QUOTA_MESSAGE, resetsAt: quota?.resetsAt });
    return undefined;
  }
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

// A read's answer: its JSON, or the refusal its failure maps to
async function answer(res: Response, read: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await read());
  } catch (err) {
    refuse(res, refusalOf(err));
  }
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

// A write's answer: { ok: true } once GitHub took it; the poll when `pollAfter` runs after the answer, so a slow or failing poll never
// turns a write GitHub took into a refusal; its failure the refusal it maps to
async function write(ctx: RepoContext, res: Response, target: Target, run: () => Promise<void>, pollAfter: boolean): Promise<void> {
  try {
    await run();
  } catch (err) {
    return refuse(res, refusalOf(err));
  }
  res.json({ ok: true });
  if (pollAfter) {
    pollOwner(ctx, target).catch((err: unknown) => {
      ctx.deps.log.error(`repositories: the poll after a write on ${target.repository}#${target.number} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// The issue page's writes (#757), each straight to GitHub with the Hive's login, the body checked before GitHub is asked
// A write's answer in the read model (#765 spike). GitHub took the write already, so an answer the normalizer refuses is logged, never a refusal;
// what the answer does not cover (automations, close on merge) arrives through the read sync
function stored(ctx: RepoContext, repository: string, store: (model: RepoReadModel) => void): void {
  const model = ctx.deps.readModel;
  if (model === undefined) return;
  try {
    store(model);
  } catch (err) {
    ctx.deps.log.error(`repositories: ${repository} not stored in the read model: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const storeIssue = (ctx: RepoContext, repository: string, issue: unknown): void => {
  if (issue !== undefined) stored(ctx, repository, (m) => { m.db.upsertIssue(issueFromGql(m.source, repository, issue)); }); // undefined: no mutation sent
};

const storeComment = (ctx: RepoContext, repository: string, written: { comment: unknown; issue: unknown }): void => {
  stored(ctx, repository, (m) => {
    const issue = issueFromGql(m.source, repository, written.issue);
    const row = commentFromGql(m.source, repository, issue.nodeId, written.comment);
    m.db.transaction(() => {
      m.db.upsertIssue(issue);
      m.db.upsertComment(row);
    });
  });
};

function registerWriteRoutes(app: Express, ctx: RepoContext): void {
  app.post('/repositories/:owner/:name/issues/:number', async (req: Request, res: Response) => {
    const number = numberOf(req);
    const body = editOf(req.body);
    if (number === undefined || body === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: EDIT_MESSAGE });
    const found = await named(ctx, req, res);
    if (found) await write(ctx, res, { ...found, number }, async () => storeIssue(ctx, found.repository, await editIssue(ctx.gql, found.repository, number, body.edit, body.updatedAt)), true);
  });
  app.post('/repositories/:owner/:name/issues/:number/labels', async (req: Request, res: Response) => {
    const number = numberOf(req);
    const { add, remove } = bodyOf(req);
    if (number === undefined || !isNames(add) || !isNames(remove)) return refuse(res, { status: HTTP_BAD_REQUEST, message: LABELS_MESSAGE });
    const found = await named(ctx, req, res);
    if (found) await write(ctx, res, { ...found, number }, async () => storeIssue(ctx, found.repository, await setLabels(ctx.gql, found.repository, number, add, remove)), true);
  });
  // A comment changes nothing the flow shows: no poll
  app.post('/repositories/:owner/:name/issues/:number/comments', async (req: Request, res: Response) => {
    const number = numberOf(req);
    const { body } = bodyOf(req);
    if (number === undefined || typeof body !== 'string' || body.trim() === '' || body.length > BODY_MAX) return refuse(res, { status: HTTP_BAD_REQUEST, message: COMMENT_MESSAGE });
    const found = await named(ctx, req, res);
    if (found) await write(ctx, res, { ...found, number }, async () => storeComment(ctx, found.repository, await comment(ctx.gql, found.repository, number, body)), false);
  });
}

// The page from the read model (#765 spike), its refetch started first: an issue the sync has not stored yet is a 404 until its readModel event
function storedIssue(model: RepoReadModel, res: Response, repository: string, number: number): void {
  model.refetch(repository, number);
  const row = model.db.issue(model.source, repository, number);
  if (row === undefined) {
    refuse(res, { status: HTTP_NOT_FOUND, message: ISSUE_NOT_STORED });
    return;
  }
  res.json(issuePageView(row, model.db.comments(model.source, row.nodeId)));
}

// GET /repositories (#757): the sidebar's list, read when it mounts and on the repository header's refresh, never polled; then a repository's issues
function registerReadRoutes(app: Express, ctx: RepoContext): void {
  app.get('/repositories', async (_req: Request, res: Response) => {
    const found = await listed(ctx, res);
    if (found) await answer(res, () => readSummaries(ctx.gql, found.refs));
  });
  app.get('/repositories/:owner/:name/issues', async (req: Request, res: Response) => {
    const state = STATES.find((s) => s === req.query.state);
    if (state === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: STATE_MESSAGE });
    const found = await named(ctx, req, res);
    const model = ctx.deps.readModel;
    if (found) await answer(res, async () => (model ? issuesView(model.db.issues(model.source, found.repository, state), state) : readIssues(ctx.gql, found.repository, state)));
  });
  app.get('/repositories/:owner/:name/issues/:number', async (req: Request, res: Response) => {
    const number = numberOf(req);
    if (number === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: NUMBER_MESSAGE });
    const found = await named(ctx, req, res);
    if (!found) return;
    const model = ctx.deps.readModel;
    if (model) return storedIssue(model, res, found.repository, number);
    await answer(res, () => readIssue(ctx.gql, found.repository, number));
  });
  app.get('/repositories/:owner/:name/labels', async (req: Request, res: Response) => {
    const found = await named(ctx, req, res);
    if (found) await answer(res, () => readLabels(ctx.gql, found.repository));
  });
}

/** The repositories' routes (#757): what the Hive knows of each repository, read with the Hive's own login. */
export function registerRepoRoutes(app: Express, deps: RepoRouteDeps): void {
  const ctx = contextOf(deps);
  registerReadRoutes(app, ctx);
  registerWriteRoutes(app, ctx);
}
