// The experiments' routes (#459, api.benchmark.experiments): each validates its body, refuses what the experiment's state forbids, writes
// <home>/benchmark/<id>/ through benchmark/store.ts and dispatches one #458 event; the reducer only applies it. Later benchmark route files
// export their own register…Routes and are mounted from registerBenchmarkRoutes, so server.ts mounts the benchmark once.
import { randomInt } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { z } from 'zod';
import { isLocked } from './benchmark/arms.js';
import { seedHash, tasksHash, treeHash } from './benchmark/hash.js';
import { baseSnapshot, copyName, defaultName, duplicateOf, emptyExperiment, emptySeed, newId } from './benchmark/new-experiment.js';
import { pluginTrees } from './benchmark/pin.js';
import { CREATE, PATCH, type PatchBody } from './benchmark/schemas.js';
import { copyFolder, createFolder, experimentFolder, pinPlugin, removeFolder, SeedFileMissing, seedCommit, syncSeed } from './benchmark/store.js';
import { readCatalogue } from './items-catalogue.js';
import type { Logger } from './log.js';
import { type BenchmarkEvent, type Config, type Exec, EXPERIMENT_ID, type Experiment, type State, type Workspace } from './types.js';
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
  dispatch(event: BenchmarkEvent): Promise<unknown>;
  home: string;
  pluginSource: string;
  exec: Exec;
  log: Pick<Logger, 'error'>;
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
  await (from === undefined ? createFolder(dir) : copyFolder(from, dir));
  try {
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

// Name and archive are allowed while running (they change no run). Task 8 applies the sections first, so a refused one leaves both untouched
async function patchExperiment(ctx: Ctx, id: string, body: PatchBody): Promise<void> {
  const experiment = found(ctx, id);
  if (experiment === undefined) return;
  const { name, archived } = body;
  if (name !== undefined) await ctx.deps.dispatch({ type: 'benchmarkEdited', id, patch: { name } });
  if (archived !== undefined) await ctx.deps.dispatch({ type: 'benchmarkArchived', id, archived });
  ctx.res.json({ id });
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
  app.delete(`${E}/:id`, route(deps, queue, 'delete', async (req, ctx) => {
    const experiment = unlocked(ctx, idOf(req));
    if (experiment === undefined) return;
    await removeFolder(folder(ctx, experiment.id));
    await ctx.deps.dispatch({ type: 'benchmarkDeleted', id: experiment.id });
    ctx.res.status(HTTP_NO_CONTENT).end();
  }));
}

/** api.benchmark.experiments (#459), behind the server's host, secret and x-hive-ui gates; the later benchmark route files mount here. */
export function registerBenchmarkRoutes(app: Express, deps: BenchmarkRouteDeps): void {
  const queue = serial();
  registerExperimentRoutes(app, deps, queue);
}
