// The experiments' routes (#459, api.benchmark.experiments): each validates its body, refuses what the experiment's state forbids, writes
// <home>/benchmark/<id>/ through benchmark/store.ts and dispatches one #458 event; the reducer only applies it. Later benchmark route files
// export their own register…Routes and are mounted from registerBenchmarkRoutes, so server.ts mounts the benchmark once.
import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Express, Request, Response } from 'express';
import type { z } from 'zod';
import { type ArmRefusal, armFrom, checkArm, checkRemove, checkTargets, isArmRefusal, isLocked } from './benchmark/arms.js';
import type { BenchEvaluator } from './benchmark/evaluate-service.js';
import type { BenchRunner } from './benchmark/runner.js';
import { seedHash, tasksHash, treeHash } from './benchmark/hash.js';
import { baseSnapshot, copyName, defaultName, duplicateOf, emptyExperiment, emptySeed, forkName, forkOf, newId } from './benchmark/new-experiment.js';
import { pluginTrees } from './benchmark/pin.js';
import { execRun } from './benchmark/exec.js';
import { ARM_PATCH, COPY, CREATE, NEW_ARM, PATCH, type PatchBody, UPLOAD } from './benchmark/schemas.js';
import { copyFolder, createFolder, experimentFolder, pinPlugin, removeFolder, SeedFileMissing, seedCommit, seedEntries, syncSeed, UPLOAD_NAME, UPLOAD_NAME_MESSAGE, UPLOAD_PREFIX, writeUpload } from './benchmark/store.js';
import { registerBenchmarkPrRoutes } from './server-benchmark-pr.js';
import { readCatalogue } from './items-catalogue.js';
import type { Logger } from './log.js';
import { type BenchmarkEvent, type BenchSeed, type Config, type Exec, EXPERIMENT_ID, type Experiment, type ExperimentPatch, type State, type Workspace } from './types.js';
import { registerBenchmarkControlRoutes } from './server-benchmark-control.js';
import { registerBenchmarkEvaluateRoutes } from './server-benchmark-evaluate.js';
import { type Git, gitOrWords } from './worktree-base.js';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
export const BENCHMARK_IO_MESSAGE = 'the experiment folder could not be read or written; see hive.log';
const E = '/benchmark/experiments';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_CHARS = 8;

export interface BenchmarkRouteDeps {
  requireLive(res: Response): { runtime: { config: Config }; state: State } | undefined;
  getLive(): { runtime: { config: Config }; state: State } | undefined; // the PR routes' own 404s answer when the Hive is not live (#477)
  dispatch(event: BenchmarkEvent): Promise<unknown>;
  home: string;
  pluginSource: string;
  exec: Exec;
  log: Logger; // the PR routes also warn (#477)
  evaluator: BenchEvaluator; // #474
  runner: Pick<BenchRunner, 'run' | 'sleep' | 'wake' | 'isLive' | 'blindness'>; // #472
  version(): Promise<string>; // the Hive's version: the shipped plugin's (pluginVersion), as custom-store's hiveVersion
  now(): Date;
}
interface Ctx { deps: BenchmarkRouteDeps; config: Config; experiments: readonly Experiment[]; res: Response }
type Handle = (req: Request, ctx: Ctx) => Promise<void>;
type Queue = <T>(work: () => Promise<T>) => Promise<T>;

const draw = (): string => Array.from({ length: ID_CHARS }, () => BASE36[randomInt(BASE36.length)]).join('');
const fail = (res: Response, status: number, error: string, message: string): void => void res.status(status).json({ error, message });
const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.constructor.name : typeof err);
const idOf = (req: Request): string => String(req.params.id);

function parsed<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  fail(res, HTTP_BAD_REQUEST, 'bad_body', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  return undefined;
}

// One write at a time: two seed edits must not interleave their removals and writes under seed/, and each handler reads the state the
// previous one's dispatch left
function serial(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
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

const workspaceOf = (config: Config, name: string): Workspace | undefined => config.comb.workspaces.find((w) => w.name === name);
const repoGit = (deps: BenchmarkRouteDeps, workspace: Workspace): Git => (...args) => gitOrWords(workspace.path, args, deps.exec);
const ids = (ctx: Ctx): string[] => ctx.experiments.map((e) => e.id);
const folder = (ctx: Ctx, id: string): string => experimentFolder(ctx.deps.home, id);

// A folder whose experiment never reached the state is removed: a failed creation leaves no orphan under <home>/benchmark
async function inNewFolder(dir: string, fill: () => Promise<void>, from?: string): Promise<void> {
  try {
    await (from === undefined ? createFolder(dir) : copyFolder(from, dir));
    await fill();
  } catch (err) {
    await removeFolder(dir);
    throw err;
  }
}

async function createEmpty(ctx: Ctx, body: { workspace: string; name?: string }): Promise<void> {
  const { deps, config, experiments, res } = ctx;
  const workspace = workspaceOf(config, body.workspace);
  if (workspace === undefined) return fail(res, HTTP_NOT_FOUND, 'unknown_workspace', `no workspace ${body.workspace}`);
  const git = repoGit(deps, workspace);
  const seed = emptySeed(workspace.name, await seedCommit(config, workspace, git));
  const id = newId(ids(ctx), draw);
  const dir = folder(ctx, id);
  await inNewFolder(dir, async () => {
    await pinPlugin(dir, deps.pluginSource, deps.home);
    await syncSeed(dir, seed, git);
    const base = baseSnapshot(config, workspace, await readCatalogue({ home: deps.home, pluginSource: deps.pluginSource, workspaces: config.comb.workspaces }));
    const experiment = emptyExperiment({
      id, armId: newId([], draw), name: body.name ?? defaultName(experiments, workspace.name), createdAt: deps.now().toISOString(), seed, base,
      judge: config.defaultAgent, plugin: { version: await deps.version(), hash: await treeHash(pluginTrees(dir)) }, seedHash: await seedHash(seed, dir), tasksHash: tasksHash(base.tasks),
    });
    await deps.dispatch({ type: 'benchmarkCreated', experiment });
    res.status(HTTP_CREATED).json(experiment);
  });
}

async function createDuplicate(ctx: Ctx, of: string): Promise<void> {
  const source = found(ctx, of);
  if (source === undefined) return;
  const id = newId(ids(ctx), draw);
  await inNewFolder(folder(ctx, id), async () => {
    const experiment = duplicateOf(source, { id, name: copyName(source.name), createdAt: ctx.deps.now().toISOString() });
    await ctx.deps.dispatch({ type: 'benchmarkCreated', experiment });
    ctx.res.status(HTTP_CREATED).json(experiment);
  }, folder(ctx, source.id));
}

type Sections = Omit<PatchBody, 'name' | 'archived'>;

async function edit(ctx: Ctx, experiment: Experiment, sections: Sections, git: Git | undefined): Promise<string> {
  const dir = folder(ctx, experiment.id);
  const { seed, base } = sections;
  if (seed !== undefined && git !== undefined) await syncSeed(dir, seed, git);
  const patch: ExperimentPatch = {
    ...sections, ...(base === undefined ? {} : { tasksHash: tasksHash(base.tasks) }), ...(seed === undefined ? {} : { seedHash: await seedHash(seed, dir) }),
  };
  await ctx.deps.dispatch({ type: 'benchmarkEdited', id: experiment.id, patch });
  return experiment.id;
}

// A seed edit on an experiment with rounds: a new draft whose pin is copied (its hash kept) and whose seed/ is copied, then synced
async function fork(ctx: Ctx, experiment: Experiment, sections: Sections & { seed: BenchSeed }, git: Git): Promise<string> {
  const { deps, experiments } = ctx;
  const id = newId(ids(ctx), draw);
  const dir = folder(ctx, id);
  await inNewFolder(dir, async () => {
    await syncSeed(dir, sections.seed, git);
    const copy = { id, name: forkName(experiment.name, experiments.map((e) => e.name)), createdAt: deps.now().toISOString(), seed: sections.seed, seedHash: await seedHash(sections.seed, dir) };
    const tasks = sections.base === undefined ? {} : { tasksHash: tasksHash(sections.base.tasks) };
    await deps.dispatch({ type: 'benchmarkForked', from: experiment.id, experiment: { ...forkOf(experiment, copy), ...sections, seedHash: copy.seedHash, ...tasks } });
  }, folder(ctx, experiment.id));
  return id;
}

// undefined: refused and answered
async function applySections(ctx: Ctx, experiment: Experiment, sections: Sections): Promise<string | undefined> {
  const { seed, ...others } = sections;
  if (seed === undefined) return edit(ctx, experiment, sections, undefined);
  if (seed.workspace !== experiment.workspace) return void fail(ctx.res, HTTP_BAD_REQUEST, 'bad_body', 'seed.workspace: an experiment keeps the workspace it was created in');
  const workspace = workspaceOf(ctx.config, experiment.workspace);
  if (workspace === undefined) return void fail(ctx.res, HTTP_NOT_FOUND, 'unknown_workspace', `no workspace ${experiment.workspace}`);
  // The same seed is no edit: nothing to resync, and an experiment with rounds must not fork for it
  if (isDeepStrictEqual(seed, experiment.seed)) return edit(ctx, experiment, others, undefined);
  const git = repoGit(ctx.deps, workspace);
  return experiment.rounds.length > 0 ? fork(ctx, experiment, { ...sections, seed }, git) : edit(ctx, experiment, sections, git);
}

async function patchExperiment(ctx: Ctx, id: string, body: PatchBody): Promise<void> {
  const experiment = found(ctx, id);
  if (experiment === undefined) return;
  const { name, archived, ...sections } = body;
  const hasSections = Object.keys(sections).length > 0;
  if (hasSections && isLocked(experiment)) return refuseLocked(ctx.res);
  const answer = hasSections ? await applySections(ctx, experiment, sections) : id;
  if (answer === undefined) return;
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

function registerExperimentRoutes(app: Express, deps: BenchmarkRouteDeps, queue: Queue): void {
  app.post(E, route(deps, queue, 'create', async (req, ctx) => {
    const body = parsed(CREATE, req, ctx.res);
    if (body === undefined) return;
    await (body.kind === 'empty' ? createEmpty(ctx, body) : createDuplicate(ctx, body.of));
  }));
  app.patch(`${E}/:id`, route(deps, queue, 'edit', async (req, ctx) => {
    const body = parsed(PATCH, req, ctx.res);
    if (body !== undefined) await patchExperiment(ctx, idOf(req), body);
  }));
  app.put(`${E}/:id/seed/files/:name`, route(deps, queue, 'upload', upload));
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
const refuse = (ctx: Ctx, refused: ArmRefusal): void => fail(ctx.res, refused.status, refused.error, refused.message);

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

/** api.benchmark.experiments (#459), behind the server's host, secret and x-hive-ui gates; the later benchmark route files mount here. */
export function registerBenchmarkRoutes(app: Express, deps: BenchmarkRouteDeps): void {
  const queue = serial();
  registerExperimentRoutes(app, deps, queue);
  registerArmRoutes(app, deps, queue);
  registerBenchmarkPrRoutes(app, { getState: () => deps.getLive()?.state, getConfig: () => deps.getLive()?.runtime.config, hiveDir: deps.home, exec: execRun, gh: execRun, now: Date.now, log: deps.log }); // #477: GET and POST …/runs/:token/pr
  registerBenchmarkEvaluateRoutes(app, { requireLive: deps.requireLive, evaluator: deps.evaluator, log: deps.log }); // #474
  registerBenchmarkControlRoutes(app, { requireLive: deps.requireLive, runner: deps.runner, dispatch: deps.dispatch, log: deps.log }); // #472
}
