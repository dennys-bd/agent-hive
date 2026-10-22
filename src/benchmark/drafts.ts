// The experiment writes that answer no HTTP (#459, #478): the routes and benchmark_draft call the same functions through one serial queue,
// so one write at a time touches <home>/benchmark/ and the tool cannot drift from the routes. A refusal is returned, never answered.
import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readCatalogue } from '../items-catalogue.js';
import type { BenchmarkEvent, BenchSeed, Config, Exec, Experiment, ExperimentPatch, Workspace } from '../types.js';
import { type Git, gitOrWords } from '../worktree-base.js';
import { seedHash, tasksHash, treeHash } from './hash.js';
import { baseSnapshot, copyName, defaultName, duplicateOf, emptyExperiment, emptySeed, forkName, forkOf, newId } from './new-experiment.js';
import { pluginTrees } from './pin.js';
import { copyFolder, createFolder, experimentFolder, pinPlugin, removeFolder, seedCommit, syncSeed } from './store.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_CHARS = 8;
export const BENCHMARK_IO_MESSAGE = 'the experiment folder could not be read or written; see hive.log';

export type Queue = <T>(work: () => Promise<T>) => Promise<T>;

export interface DraftDeps {
  dispatch(event: BenchmarkEvent): Promise<unknown>;
  home: string;
  pluginSource: string;
  exec: Exec;
  version(): Promise<string>; // the Hive's version: the shipped plugin's (pluginVersion), as custom-store's hiveVersion
  now(): Date;
}
export interface DraftCtx { deps: DraftDeps; config: Config; experiments: readonly Experiment[] }
export interface DraftRefusal { status: number; error: string; message: string }
export type Sections = Pick<ExperimentPatch, 'name' | 'base' | 'seed' | 'pace' | 'isolation' | 'blindness' | 'evaluation'>;

export const draw = (): string => Array.from({ length: ID_CHARS }, () => BASE36[randomInt(BASE36.length)]).join('');
export const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.constructor.name : typeof err);

/** An Experiment has no `error` key, so the key alone tells a refusal from a result. */
export const isRefusal = (value: Experiment | NewStart | string | DraftRefusal): value is DraftRefusal => typeof value === 'object' && 'error' in value;

// One write at a time: two seed edits must not interleave their removals and writes under seed/, and each handler reads the state the
// previous one's dispatch left
export function serial(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
}

const unknownWorkspace = (name: string): DraftRefusal => ({ status: HTTP_NOT_FOUND, error: 'unknown_workspace', message: `no workspace ${name}` });
const unknownExperiment = (id: string): DraftRefusal => ({ status: HTTP_NOT_FOUND, error: 'unknown_experiment', message: `no experiment ${id}` });
const workspaceOf = (config: Config, name: string): Workspace | undefined => config.comb.workspaces.find((w) => w.name === name);
const repoGit = (deps: DraftDeps, workspace: Workspace): Git => (...args) => gitOrWords(workspace.path, args, deps.exec);
const ids = (ctx: DraftCtx): string[] => ctx.experiments.map((e) => e.id);
const folder = (ctx: DraftCtx, id: string): string => experimentFolder(ctx.deps.home, id);

// A folder whose experiment never reached the state is removed: a failed creation leaves no orphan under <home>/benchmark
async function inNewFolder<T>(dir: string, fill: () => Promise<T>, from?: string): Promise<T> {
  try {
    await (from === undefined ? createFolder(dir) : copyFolder(from, dir));
    return await fill();
  } catch (err) {
    await removeFolder(dir);
    throw err;
  }
}

/** What a new experiment is written from: no source is the workspace's empty experiment (its plugin is pinned here); git only when the seed syncs. */
interface NewStart { experiment: Experiment; source?: Experiment; git?: Git }

// The plugin's hash, the seed's and the tasks' are read off what was just written: only the ones the start does not already hold
async function hashed(start: NewStart, experiment: Experiment, dir: string, isSeedNew: boolean): Promise<Experiment> {
  const isBaseNew = start.source === undefined || !isDeepStrictEqual(experiment.base.tasks, start.source.base.tasks);
  return {
    ...experiment,
    ...(start.source === undefined ? { plugin: { ...experiment.plugin, hash: await treeHash(pluginTrees(dir)) } } : {}),
    ...(isSeedNew ? { seedHash: await seedHash(experiment.seed, dir) } : {}),
    ...(isBaseNew ? { tasksHash: tasksHash(experiment.base.tasks) } : {}),
  };
}

// One new folder and one benchmarkCreated; a failure removes the folder, so nothing reaches the state half-written
async function writeNew(ctx: DraftCtx, start: NewStart, experiment: Experiment): Promise<Experiment | DraftRefusal> {
  const isSeedNew = start.source === undefined || !isDeepStrictEqual(experiment.seed, start.source.seed);
  const git = start.git;
  if (isSeedNew && git === undefined) return unknownWorkspace(experiment.workspace);
  const dir = folder(ctx, experiment.id);
  return inNewFolder(dir, async () => {
    if (start.source === undefined) await pinPlugin(dir, ctx.deps.pluginSource, ctx.deps.home);
    if (isSeedNew && git !== undefined) await syncSeed(dir, experiment.seed, git);
    const made = await hashed(start, experiment, dir, isSeedNew);
    await ctx.deps.dispatch({ type: 'benchmarkCreated', experiment: made });
    return made;
  }, start.source === undefined ? undefined : folder(ctx, start.source.id));
}

async function emptyStart(ctx: DraftCtx, name: string, label: string | undefined, createdBy: Experiment['createdBy']): Promise<NewStart | DraftRefusal> {
  const { deps, config, experiments } = ctx;
  const workspace = workspaceOf(config, name);
  if (workspace === undefined) return unknownWorkspace(name);
  const git = repoGit(deps, workspace);
  const seed = emptySeed(workspace.name, await seedCommit(config, workspace, git));
  const base = baseSnapshot(config, workspace, await readCatalogue({ home: deps.home, pluginSource: deps.pluginSource, workspaces: config.comb.workspaces }));
  const experiment = emptyExperiment({
    id: newId(ids(ctx), draw), armId: newId([], draw), name: label ?? defaultName(experiments, workspace.name), createdAt: deps.now().toISOString(), seed, base,
    judge: config.defaultAgent, plugin: { version: await deps.version(), hash: '' }, seedHash: '', tasksHash: tasksHash(base.tasks),
  });
  return { experiment: { ...experiment, createdBy }, git };
}

function duplicateStart(ctx: DraftCtx, of: string, createdBy: Experiment['createdBy']): NewStart | DraftRefusal {
  const source = ctx.experiments.find((e) => e.id === of);
  if (source === undefined) return unknownExperiment(of);
  const workspace = workspaceOf(ctx.config, source.workspace);
  const experiment = { ...duplicateOf(source, { id: newId(ids(ctx), draw), name: copyName(source.name), createdAt: ctx.deps.now().toISOString() }), createdBy };
  return { experiment, source, ...(workspace === undefined ? {} : { git: repoGit(ctx.deps, workspace) }) };
}

export async function createEmptyExperiment(ctx: DraftCtx, body: { workspace: string; name?: string; createdBy: Experiment['createdBy'] }): Promise<Experiment | DraftRefusal> {
  const start = await emptyStart(ctx, body.workspace, body.name, body.createdBy);
  return isRefusal(start) ? start : writeNew(ctx, start, start.experiment);
}

export function duplicateExperiment(ctx: DraftCtx, of: string, createdBy: Experiment['createdBy']): Promise<Experiment | DraftRefusal> {
  const start = duplicateStart(ctx, of, createdBy);
  return isRefusal(start) ? Promise.resolve(start) : writeNew(ctx, start, start.experiment);
}

async function edit(ctx: DraftCtx, experiment: Experiment, sections: Sections, git: Git | undefined): Promise<string> {
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
async function fork(ctx: DraftCtx, experiment: Experiment, sections: Sections & { seed: BenchSeed }, git: Git): Promise<string> {
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

/** Writes the sections: the experiment's id, or a new draft's when a seed edit forks an experiment with rounds. */
export async function editSections(ctx: DraftCtx, experiment: Experiment, sections: Sections): Promise<string | DraftRefusal> {
  const { seed, ...others } = sections;
  if (seed === undefined) return edit(ctx, experiment, sections, undefined);
  if (seed.workspace !== experiment.workspace) return { status: HTTP_BAD_REQUEST, error: 'bad_body', message: 'seed.workspace: an experiment keeps the workspace it was created in' };
  const workspace = workspaceOf(ctx.config, experiment.workspace);
  if (workspace === undefined) return unknownWorkspace(experiment.workspace);
  // The same seed is no edit: nothing to resync, and an experiment with rounds must not fork for it
  if (isDeepStrictEqual(seed, experiment.seed)) return edit(ctx, experiment, others, undefined);
  const git = repoGit(ctx.deps, workspace);
  return experiment.rounds.length > 0 ? fork(ctx, experiment, { ...sections, seed }, git) : edit(ctx, experiment, sections, git);
}
