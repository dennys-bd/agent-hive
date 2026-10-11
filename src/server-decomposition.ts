import { readFile, stat } from 'node:fs/promises';
import type { Express, Request, Response } from 'express';
import { resultOf } from './activities.js';
import { activityParam, taskTarget } from './activity-routes.js';
import { taskWorkspace } from './config.js';
import { DONE_KEY, PR_KEY, decompositionPending, fileAddress, type ParsedDecomposition, parseDecomposition, recordedIssues } from './decomposition.js';
import { deliverDecomposition, deliveryRefusal, type FileCheckout, fileCheckout } from './decomposition-deliver.js';
import { readRepository, writeDecomposition, type WriteTarget } from './decomposition-write.js';
import { resolveActivityPath } from './ide.js';
import { issueOfLink } from './repos/issue-task.js';
import { originRepository } from './repos/repositories.js';
import { NOT_AWAITING_MESSAGE } from './server-approval.js';
import { activityFolders, DISK, MISSING_FILE_MESSAGE } from './server-files.js';
import type { Refusal } from './server-tasks.js';
import type { GqlJson } from './sources/github-gql.js';
import { fetchStatusField, type GithubSourceConfig } from './sources/github.js';
import type { Config, Decomposition, DecompositionPreview, DecompositionSource, Exec, Gql, HiveEvent, Stage, State, Task } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_SERVER_ERROR = 500; // a local read failed
const FILE_MAX = 256 * 1024; // bytes: a decomposition of 300 nodes is far below it
const HTTP_BAD_GATEWAY = 502; // GitHub refused a read or a write
const PATH = '/activities/:id/decomposition';
const NO_DECOMPOSITION_MESSAGE = 'tarefa sem decomposição no resultado';
const READ_MESSAGE = 'não foi possível ler o decomposition.md'; // fixed: Node's own text carries an absolute path
const TOO_LARGE_MESSAGE = 'o decomposition.md passa de 256 KB';
const WRITTEN_MESSAGE = 'a decomposição já foi escrita no GitHub';
const PROBLEMS_MESSAGE = 'decomposition.md tem problemas: corrija antes de criar as issues';
const NO_REPOSITORY_MESSAGE = 'o workspace não tem origin no GitHub';
const CHOICE_MESSAGE = 'source precisa ser uma source do GitHub e column uma opção do seu Status';
const NOT_MD_MESSAGE = 'a decomposição precisa ser um arquivo .md';
const WRITING_MESSAGE = 'as issues desta decomposição já estão sendo criadas';

/** What the decomposition's routes need (#865). */
export interface DecompositionRouteDeps {
  requireLive(res: Response): { state: State; runtime: { config: Pick<Config, 'comb'> } } | undefined;
  dispatch(event: HiveEvent): Promise<unknown>; // each step's decompositionIssue, then approve or closeTask
  exec: Exec; // git remote get-url origin: a local goal's repository; the file's checkout, and the delivery's status, add, commit and push (#936)
  gql: GqlJson; // gh api graphql --input -: the Hive's own login, as the issue page's writes (#757)
}

type Live = NonNullable<ReturnType<DecompositionRouteDeps['requireLive']>>;

// The goal as both routes read it: its task and result, its parsed file and the file's real path (#936: what its checkout is found from),
// where its issues go, and a GitHub goal's issue number
interface Goal { task: Task; result: Record<string, unknown>; parsed: ParsedDecomposition; file: string; repository?: string; number?: number }

const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// fetchStatusField takes the polling transport's shape; the Hive's login answers the same query through stdin
const asGql = (gql: GqlJson): Gql => (query, variables) => gql(query, variables ?? {});
const githubSources = (config: Pick<Config, 'comb'>): GithubSourceConfig[] => config.comb.sources.filter((s): s is GithubSourceConfig => s.type === 'github');

// The file the result names, wherever it is (#936: a docsRepo outside the worktree included), resolved as the file routes resolve it (#258,
// #697): absolute, or relative to the goal's worktree. Still under FILE_MAX, and a read failure keeps its fixed words
async function readDecompositionFile(config: Pick<Config, 'comb'>, target: { task: Task; activity: NonNullable<Parameters<typeof activityFolders>[1]['activity']> }, path: string): Promise<{ text: string; file: string } | Refusal> {
  const folders = activityFolders(config, target);
  if ('status' in folders) return folders;
  const resolved = await resolveActivityPath({ ...folders, path, ...DISK });
  if ('reason' in resolved) return { status: HTTP_NOT_FOUND, message: MISSING_FILE_MESSAGE };
  try {
    if ((await stat(resolved.file)).size > FILE_MAX) return { status: HTTP_TOO_LARGE, message: TOO_LARGE_MESSAGE };
    return { text: await readFile(resolved.file, 'utf8'), file: resolved.file };
  } catch {
    return { status: HTTP_SERVER_ERROR, message: READ_MESSAGE };
  }
}

// The live task awaiting approval, its decomposition.md parsed, and where its issues go: the goal issue's repository, else a local goal's
// workspace origin (absent when it is not on GitHub)
async function readGoal(deps: DecompositionRouteDeps, current: Live, activityId: string): Promise<Goal | Refusal> {
  const target = taskTarget(current.state, activityId);
  if ('status' in target) return target;
  if (!target.activity.approval) return { status: HTTP_CONFLICT, message: NOT_AWAITING_MESSAGE };
  const result = resultOf(current.state, target.task.item.itemId) ?? {};
  if (typeof result.decomposition !== 'string') return { status: HTTP_CONFLICT, message: NO_DECOMPOSITION_MESSAGE };
  if (!result.decomposition.endsWith('.md')) return { status: HTTP_CONFLICT, message: NOT_MD_MESSAGE };
  const read = await readDecompositionFile(current.runtime.config, target, result.decomposition);
  if ('status' in read) return read;
  const issue = issueOfLink(target.task.item.url);
  const repository = issue?.repository ?? (await originRepository(deps.exec, taskWorkspace(current.runtime.config, target.task)?.path));
  return {
    task: target.task, result, parsed: parseDecomposition(read.text), file: read.file,
    ...(repository === undefined ? {} : { repository }), ...(issue ? { number: issue.number } : {}),
  };
}

/** The column a new issue goes to by default (#865): the first stage's first column of that source, else the source's first Status option. */
export function suggestedColumn(stages: Stage[], source: string, statuses: string[]): string | undefined {
  const cited = stages[0]?.from[source]?.[0];
  return cited !== undefined && statuses.includes(cited) ? cited : statuses[0];
}

// The GitHub sources the dialog offers, the goal's own first, each with its Status options read with the Hive's login
async function sourcesOf(config: Pick<Config, 'comb'>, gql: GqlJson, own?: string): Promise<DecompositionSource[]> {
  const ordered = [...githubSources(config)].sort((a, b) => Number(b.name === own) - Number(a.name === own));
  return Promise.all(ordered.map(async (source) => {
    const statuses = (await fetchStatusField(source.owner, source.number, asGql(gql))).options.map((o) => o.name);
    const column = suggestedColumn(config.comb.stages, source.name, statuses);
    return { name: source.name, statuses, ...(column === undefined ? {} : { column }) };
  }));
}

// Where the file is delivered (#936): its checkout and the default branch of that checkout's repository. Throws when there is no checkout
interface Delivery { checkout: FileCheckout; docs: { id: string; defaultBranch: string } }
async function deliveryOf(deps: DecompositionRouteDeps, goal: Goal): Promise<Delivery> {
  const checkout = await fileCheckout(deps.exec, goal.file);
  return { checkout, docs: await readRepository(deps.gql, checkout.repository) };
}

// What the dialog shows of the delivery: the checkout's repository, branch and path, or the reason it cannot go. Nothing once pr is recorded
async function deliveryPreview(deps: DecompositionRouteDeps, goal: Goal): Promise<Pick<DecompositionPreview, 'delivery' | 'deliveryRefusal'>> {
  const recorded = recordedIssues(goal.result);
  if (recorded[PR_KEY] !== undefined) return {};
  try {
    const { checkout, docs } = await deliveryOf(deps, goal);
    const refusal = deliveryRefusal(checkout, docs.defaultBranch, recorded);
    return { delivery: { repository: checkout.repository, branch: checkout.branch, path: checkout.path }, ...(refusal === undefined ? {} : { deliveryRefusal: refusal }) };
  } catch (err) {
    return { deliveryRefusal: errorMessage(err) };
  }
}

function preview(goal: Goal, sources: DecompositionSource[], delivery: Pick<DecompositionPreview, 'delivery' | 'deliveryRefusal'>): DecompositionPreview {
  const { decomposition: d, problems, suggestions, warnings } = goal.parsed;
  const nodes = d?.nodes ?? [];
  return {
    ...(d ? { title: d.title } : {}), problems, warnings, suggestions, sources,
    issues: d === undefined ? 0 : nodes.length + (goal.number === undefined ? 1 : 0), // a local goal's root issue too
    blockers: nodes.reduce((n, node) => n + node.blockedBy.length, 0),
    ...(goal.repository === undefined ? {} : { repository: goal.repository }), ...delivery,
  };
}

// What a write needs of the goal, or why it cannot run
function writable(goal: Goal): { decomposition: Decomposition; repository: string } | Refusal {
  if (!decompositionPending(goal.result)) return { status: HTTP_CONFLICT, message: WRITTEN_MESSAGE };
  const { decomposition } = goal.parsed;
  if (decomposition === undefined) return { status: HTTP_CONFLICT, message: PROBLEMS_MESSAGE };
  if (goal.repository === undefined) return { status: HTTP_CONFLICT, message: NO_REPOSITORY_MESSAGE };
  return { decomposition, repository: goal.repository };
}

// The body's source (a GitHub source of the Comb) and column (one of its Status options), as the project's ids
async function choiceOf(config: Pick<Config, 'comb'>, gql: GqlJson, body: unknown): Promise<WriteTarget['project'] | Refusal> {
  const { source, column } = (body ?? {}) as { source?: unknown; column?: unknown };
  const found = githubSources(config).find((s) => s.name === source);
  if (!found || typeof column !== 'string') return { status: HTTP_BAD_REQUEST, message: CHOICE_MESSAGE };
  const field = await fetchStatusField(found.owner, found.number, asGql(gql));
  const option = field.options.find((o) => o.name === column);
  return option ? { projectId: field.projectId, fieldId: field.id, optionId: option.id } : { status: HTTP_BAD_REQUEST, message: CHOICE_MESSAGE };
}

// The write and the stage's end: the file's checkout resolved first (#936), so a file the Hive cannot deliver writes nothing; each step
// dispatched as decompositionIssue before the next; the file delivered and its PR recorded as pr; `done` once everything is done; then approve for
// a GitHub goal or closeTask for a local one, straight to the reducer, past the approve route's guard. An error is a 502 with GitHub's words, and the steps done stay
async function write(deps: DecompositionRouteDeps, current: Live, activityId: string, body: unknown, res: Response): Promise<void> {
  const goal = await readGoal(deps, current, activityId);
  if ('status' in goal) return refuse(res, goal);
  const ready = writable(goal);
  if ('status' in ready) return refuse(res, ready);
  const project = await choiceOf(current.runtime.config, deps.gql, body);
  if ('status' in project) return refuse(res, project);
  const taskId = goal.task.item.itemId;
  const record = async (id: string, number: number): Promise<void> => { await deps.dispatch({ type: 'decompositionIssue', taskId, id, number }); };
  const { checkout, docs } = await deliveryOf(deps, goal);
  const refusal = deliveryRefusal(checkout, docs.defaultBranch, recordedIssues(goal.result)); // before any issue: a refused delivery writes nothing
  if (refusal !== undefined) return refuse(res, { status: HTTP_CONFLICT, message: refusal });
  const issues = checkout.repository === ready.repository ? docs : await readRepository(deps.gql, ready.repository);
  const target: WriteTarget = {
    repository: ready.repository, repositoryId: issues.id, address: fileAddress(checkout.repository, docs.defaultBranch, checkout.path), project,
    ...(goal.number === undefined ? {} : { goal: goal.number }),
  };
  const written = await writeDecomposition({ gql: deps.gql, record }, ready.decomposition, target, recordedIssues(goal.result));
  if ('error' in written) return refuse(res, { status: HTTP_BAD_GATEWAY, message: written.error });
  const delivered = await deliverDecomposition({ exec: deps.exec, gql: deps.gql, record }, {
    checkout, repositoryId: docs.id, base: docs.defaultBranch, root: written.root, goal: ready.repository,
  }, recordedIssues(goal.result));
  if (delivered !== undefined) return refuse(res, { status: HTTP_BAD_GATEWAY, message: delivered });
  await record(DONE_KEY, written.root);
  await deps.dispatch(goal.number === undefined ? { type: 'closeTask', taskId } : { type: 'approve', activityId });
  res.json({ ok: true });
}

/** The decomposition's confirm (#865): GET reads the goal's decomposition.md for the dialog, POST writes it to GitHub with the Hive's own
 * login and ends the stage. One write per activity at a time: two quick presses never create issues twice. */
export function registerDecompositionRoutes(app: Express, deps: DecompositionRouteDeps): void {
  const writing = new Set<string>();
  app.get(PATH, async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    try {
      const goal = await readGoal(deps, current, activityParam(req));
      if ('status' in goal) return refuse(res, goal);
      res.json(preview(goal, await sourcesOf(current.runtime.config, deps.gql, goal.task.item.source), await deliveryPreview(deps, goal)));
    } catch (err) {
      refuse(res, { status: HTTP_BAD_GATEWAY, message: errorMessage(err) });
    }
  });
  app.post(PATH, async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const activityId = activityParam(req);
    if (writing.has(activityId)) return refuse(res, { status: HTTP_CONFLICT, message: WRITING_MESSAGE });
    writing.add(activityId);
    try {
      await write(deps, current, activityId, req.body, res);
    } catch (err) {
      refuse(res, { status: HTTP_BAD_GATEWAY, message: errorMessage(err) });
    } finally {
      writing.delete(activityId);
    }
  });
}
