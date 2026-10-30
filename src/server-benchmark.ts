// The experiments' routes (#459, api.benchmark.experiments): each validates its body, refuses what the experiment's state forbids, writes
// <home>/benchmark/<id>/ through benchmark/store.ts and dispatches one #458 event; the reducer only applies it. Later benchmark route files
// export their own register…Routes and are mounted from registerBenchmarkRoutes, so server.ts mounts the benchmark once.
import { type BenchmarkRunRoutes, registerBenchmarkRunRoutes } from './server-benchmark-run.js';
import type { Express, Request, Response } from 'express';
import type { z } from 'zod';
import { type ArmRefusal, armFrom, checkArm, checkRemove, checkTargets, isArmRefusal, isLocked } from './benchmark/arms.js';
import { byCodePoint } from './benchmark/canonical.js';
import { overrideIssues } from './benchmark/flow-copy.js';
import type { BenchEvaluator } from './benchmark/evaluate-service.js';
import type { BenchRunner } from './benchmark/runner.js';
import { type AskSessionDeps, registerBenchmarkAgentRoutes } from './server-benchmark-agent.js';
import { BENCHMARK_IO_MESSAGE, createEmptyExperiment, type DraftCtx, type DraftDeps, type DraftRefusal, draw, duplicateExperiment, editSections, errorCode, isRefusal, type Queue, serial } from './benchmark/drafts.js';
import { newId } from './benchmark/new-experiment.js';
import { pinHome, pluginTrees } from './benchmark/pin.js';
import { execRun } from './benchmark/exec.js';
import { ARM_PATCH, COPY, CREATE, NEW_ARM, PATCH, type PatchBody, UPLOAD } from './benchmark/schemas.js';
import { experimentFolder, removeFolder, SeedFileMissing, seedEntries, UPLOAD_NAME, UPLOAD_NAME_MESSAGE, UPLOAD_PREFIX, writeUpload } from './benchmark/store.js';
import { readCatalogue } from './items-catalogue.js';
import { registerBenchmarkPrRoutes } from './server-benchmark-pr.js';
import type { Logger } from './log.js';
import { type Config, EXPERIMENT_ID, type Experiment, type State } from './types.js';
import { registerBenchmarkControlRoutes } from './server-benchmark-control.js';
import { registerBenchmarkEvaluateRoutes } from './server-benchmark-evaluate.js';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const E = '/benchmark/experiments';

export interface BenchmarkRouteDeps extends DraftDeps {
  requireLive(res: Response): { runtime: { config: Config }; state: State } | undefined;
  getLive(): { runtime: { config: Config }; state: State } | undefined; // the PR routes' own 404s answer when the Hive is not live (#477)
  log: Logger; // the PR routes also warn (#477)
  evaluator: BenchEvaluator; // #474
  runner: Pick<BenchRunner, 'run' | 'sleep' | 'wake' | 'isLive' | 'blindness'>; // #472
  session: AskSessionDeps; // #478: ask the agent's local session
  queue?: Queue; // #478: the one queue benchmark_draft shares, so a tool write and a route write never interleave; none: the routes' own
}
interface Ctx extends DraftCtx { deps: BenchmarkRouteDeps; res: Response }
type Handle = (req: Request, ctx: Ctx) => Promise<void>;

const fail = (res: Response, status: number, error: string, message: string): void => void res.status(status).json({ error, message });
const idOf = (req: Request): string => String(req.params.id);

function parsed<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  fail(res, HTTP_BAD_REQUEST, 'bad_body', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  return undefined;
}

// A missing seed file is the request's 404; anything else the disk or git threw is a 500 whose code (never its message: it names paths
// under the home) goes to hive.log with the step and the experiment
function route(deps: BenchmarkRouteDeps, queue: Queue, step: string, handle: Handle) {
  return (req: Request, res: Response): Promise<void> => queue(async () => {
    const live = deps.requireLive(res);
    if (!live) return;
    try {
      await handle(req, { deps, config: live.runtime.config, experiments: live.state.benchmark.experiments, res });
    } catch (err) {
      if (err instanceof SeedFileMissing) return fail(res, HTTP_NOT_FOUND, 'unknown_path', `${err.message} is not in the seed's commit or uploads`);
      deps.log.error(`benchmark: ${step} ${EXPERIMENT_ID.test(idOf(req)) ? idOf(req) : 'new'} failed: ${errorCode(err)}`);
      if (!res.headersSent) fail(res, HTTP_SERVER_ERROR, 'io', BENCHMARK_IO_MESSAGE);
    }
  });
}

function found(ctx: Ctx, id: string): Experiment | undefined {
  const experiment = ctx.experiments.find((e) => e.id === id);
  if (experiment === undefined) fail(ctx.res, HTTP_NOT_FOUND, 'unknown_experiment', `no experiment ${id}`);
  return experiment;
}

const refuseLocked = (res: Response): void => fail(res, HTTP_CONFLICT, 'running', 'the experiment is running or sleeping');

/** The experiment, unless it is unknown (404) or running or sleeping (409): a running round reads its config. */
function unlocked(ctx: Ctx, id: string): Experiment | undefined {
  const experiment = found(ctx, id);
  if (experiment === undefined || !isLocked(experiment)) return experiment;
  refuseLocked(ctx.res);
  return undefined;
}

const folder = (ctx: Ctx, id: string): string => experimentFolder(ctx.deps.home, id);

async function patchExperiment(ctx: Ctx, id: string, body: PatchBody): Promise<void> {
  const experiment = found(ctx, id);
  if (experiment === undefined) return;
  const { name, archived, ...sections } = body;
  const hasSections = Object.keys(sections).length > 0;
  if (hasSections && isLocked(experiment)) return refuseLocked(ctx.res);
  const answer = hasSections ? await editSections(ctx, experiment, sections) : id;
  if (isRefusal(answer)) return refuse(ctx, answer);
  // A fork answers a new id: name and archived belong to it, the experiment that ran stays as it was
  if (name !== undefined) await ctx.deps.dispatch({ type: 'benchmarkEdited', id: answer, patch: { name } });
  if (archived !== undefined) await ctx.deps.dispatch({ type: 'benchmarkArchived', id: answer, archived });
  ctx.res.json({ id: answer });
}

// Only writes the file: the seed lists it as upload:<name> through PATCH, which rehashes or forks. A name the seed of an experiment with
// rounds lists is part of what those rounds ran: overwriting it would change a hashed seed without a fork
async function upload(req: Request, ctx: Ctx): Promise<void> {
  const name = String(req.params.name);
  if (!UPLOAD_NAME.test(name)) return fail(ctx.res, HTTP_BAD_REQUEST, 'bad_name', UPLOAD_NAME_MESSAGE);
  const experiment = unlocked(ctx, idOf(req));
  if (experiment === undefined) return;
  if (experiment.rounds.length > 0 && seedEntries(experiment.seed).includes(`${UPLOAD_PREFIX}${name}`)) {
    return fail(ctx.res, HTTP_CONFLICT, 'seed_locked', `${name} is in a seed that has run: upload it under a new name`);
  }
  const body = parsed(UPLOAD, req, ctx.res);
  if (body === undefined) return;
  await writeUpload(folder(ctx, experiment.id), name, Buffer.from(body.content, 'base64'));
  ctx.res.status(HTTP_NO_CONTENT).end();
}

// The versions a run can find (#462): every run renders from the pin (#459), so the choices come from it, never from the current store.
// A workspace's own items are listed from its checkout as the render reads them; their versions from the pin
async function pinnedItems(req: Request, ctx: Ctx): Promise<void> {
  const experiment = found(ctx, idOf(req));
  if (experiment === undefined) return;
  const dir = folder(ctx, experiment.id);
  const catalogue = await readCatalogue({ home: pinHome(dir), pluginSource: pluginTrees(dir).source, workspaces: ctx.config.comb.workspaces });
  const items = catalogue.map((i) => ({ id: i.id, name: i.name, kind: i.kind, versions: i.versions.map((v) => v.name) })).sort((a, b) => byCodePoint(a.id, b.id));
  ctx.res.json({ items });
}

const USER: Experiment['createdBy'] = { kind: 'user' };

function registerExperimentRoutes(app: Express, deps: BenchmarkRouteDeps, queue: Queue): void {
  app.post(E, route(deps, queue, 'create', async (req, ctx) => {
    const body = parsed(CREATE, req, ctx.res);
    if (body === undefined) return;
    const made = body.kind === 'empty'
      ? await createEmptyExperiment(ctx, { workspace: body.workspace, ...(body.name === undefined ? {} : { name: body.name }), createdBy: USER })
      : await duplicateExperiment(ctx, body.of, USER);
    if (isRefusal(made)) return refuse(ctx, made);
    ctx.res.status(HTTP_CREATED).json(made);
  }));
  app.patch(`${E}/:id`, route(deps, queue, 'edit', async (req, ctx) => {
    const body = parsed(PATCH, req, ctx.res);
    if (body !== undefined) await patchExperiment(ctx, idOf(req), body);
  }));
  app.put(`${E}/:id/seed/files/:name`, route(deps, queue, 'upload', upload));
  app.get(`${E}/:id/items`, route(deps, queue, 'items', pinnedItems));
  app.delete(`${E}/:id`, route(deps, queue, 'delete', async (req, ctx) => {
    const experiment = unlocked(ctx, idOf(req));
    if (experiment === undefined) return;
    await removeFolder(folder(ctx, experiment.id));
    await ctx.deps.dispatch({ type: 'benchmarkDeleted', id: experiment.id });
    ctx.res.status(HTTP_NO_CONTENT).end();
  }));
}

const ARM = `${E}/:id/arms/:armId`;
const armIdOf = (req: Request): string => String(req.params.armId);
const refuse = (ctx: Ctx, refused: ArmRefusal | DraftRefusal): void => fail(ctx.res, refused.status, refused.error, refused.message);

async function addArm(req: Request, ctx: Ctx): Promise<void> {
  const experiment = unlocked(ctx, idOf(req));
  const body = experiment && parsed(NEW_ARM, req, ctx.res);
  if (experiment === undefined || body === undefined) return;
  const arm = armFrom(experiment, body.from, newId(experiment.arms.map((a) => a.id), draw));
  if (isArmRefusal(arm)) return refuse(ctx, arm);
  await ctx.deps.dispatch({ type: 'benchmarkArmAdded', id: experiment.id, arm });
  ctx.res.status(HTTP_CREATED).json(arm);
}

async function editArm(req: Request, ctx: Ctx): Promise<void> {
  const experiment = unlocked(ctx, idOf(req));
  const body = experiment && parsed(ARM_PATCH, req, ctx.res);
  if (experiment === undefined || body === undefined) return;
  const arm = checkArm(experiment, armIdOf(req));
  if (isArmRefusal(arm)) return refuse(ctx, arm);
  const issues = overrideIssues(experiment.base.flow, body.overrides?.stages ?? {});
  if (issues.length > 0) return fail(ctx.res, HTTP_BAD_REQUEST, 'bad_body', issues.map((i) => `arm ${body.name ?? arm.name}: ${i}`).join('\n'));
  await ctx.deps.dispatch({ type: 'benchmarkArmEdited', id: experiment.id, armId: arm.id, patch: body });
  ctx.res.status(HTTP_NO_CONTENT).end();
}

async function removeArm(req: Request, ctx: Ctx): Promise<void> {
  const experiment = unlocked(ctx, idOf(req));
  if (experiment === undefined) return;
  const refused = checkRemove(experiment, armIdOf(req));
  if (refused !== undefined) return refuse(ctx, refused);
  await ctx.deps.dispatch({ type: 'benchmarkArmRemoved', id: experiment.id, armId: armIdOf(req) });
  ctx.res.status(HTTP_NO_CONTENT).end();
}

async function copyArm(req: Request, ctx: Ctx): Promise<void> {
  const experiment = unlocked(ctx, idOf(req));
  const body = experiment && parsed(COPY, req, ctx.res);
  if (experiment === undefined || body === undefined) return;
  const source = checkArm(experiment, armIdOf(req));
  const refused = isArmRefusal(source) ? source : checkTargets(experiment, body.to);
  if (refused !== undefined) return refuse(ctx, refused);
  await ctx.deps.dispatch({ type: 'benchmarkArmsCopied', id: experiment.id, from: armIdOf(req), what: body.what, to: body.to });
  ctx.res.status(HTTP_NO_CONTENT).end();
}

function registerArmRoutes(app: Express, deps: BenchmarkRouteDeps, queue: Queue): void {
  app.post(`${E}/:id/arms`, route(deps, queue, 'add arm', addArm));
  app.patch(ARM, route(deps, queue, 'edit arm', editArm));
  app.delete(ARM, route(deps, queue, 'remove arm', removeArm));
  app.post(`${ARM}/copy`, route(deps, queue, 'copy arm', copyArm));
}

/** api.benchmark.experiments (#459), behind the server's host, secret and x-hive-ui gates; the later benchmark route files mount here. Answers the run-hive routes' shutdown hook, which server.ts's close() calls. */
export function registerBenchmarkRoutes(app: Express, deps: BenchmarkRouteDeps): BenchmarkRunRoutes {
  const queue = deps.queue ?? serial();
  registerExperimentRoutes(app, deps, queue);
  registerArmRoutes(app, deps, queue);
  registerBenchmarkPrRoutes(app, { getState: () => deps.getLive()?.state, getConfig: () => deps.getLive()?.runtime.config, hiveDir: deps.home, exec: execRun, gh: execRun, now: Date.now, log: deps.log }); // #477: GET and POST …/runs/:token/pr
  registerBenchmarkEvaluateRoutes(app, { requireLive: deps.requireLive, evaluator: deps.evaluator, log: deps.log }); // #474
  registerBenchmarkAgentRoutes(app, { requireLive: deps.requireLive, log: deps.log, session: deps.session }); // #478: POST /benchmark/agent
  registerBenchmarkControlRoutes(app, { requireLive: deps.requireLive, runner: deps.runner, dispatch: deps.dispatch, log: deps.log }); // #472
  return registerBenchmarkRunRoutes(app, { getState: () => deps.getLive()?.state, log: deps.log }); // #475: …/runs/:token/open, and its shutdown hook
}
