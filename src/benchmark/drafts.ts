// The experiment writes that answer no HTTP (#459, #478): the routes and benchmark_draft call the same functions through one serial queue,
// so one write at a time touches <home>/benchmark/ and the tool cannot drift from the routes. A refusal is returned, never answered.
import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readCatalogue } from '../items-catalogue.js';
import type { BenchmarkEvent, BenchSeed, Config, Exec, Experiment, ExperimentPatch, Workspace } from '../types.js';
import type { Logger } from '../log.js';
import { type Git, gitOrWords } from '../worktree-base.js';
import { seedHash, tasksHash, treeHash } from './hash.js';
import { composeDraft, DRAFT, type DraftInput, resultIssues, zodIssues } from './draft-schema.js';
import { baseSnapshot, copyName, defaultName, duplicateOf, emptyExperiment, emptySeed, forkName, forkOf, newId } from './new-experiment.js';
import { pluginTrees } from './pin.js';
import { copyFolder, createFolder, experimentFolder, pinPlugin, removeFolder, SeedFileMissing, seedCommit, syncSeed } from './store.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
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
export type Sections = Pick<ExperimentPatch, 'name' | 'arms' | 'base' | 'seed' | 'pace' | 'isolation' | 'blindness' | 'evaluation'>;

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
  const base = baseSnapshot(config, workspace, await readCatalogue({ home: deps.home, pluginSource: deps.pluginSource, workspaces: config.comb.workspaces }), deps.now());
  if ('refused' in base) return { status: HTTP_UNPROCESSABLE, error: 'flow_refused', message: `the workspace's flow cannot be copied: ${base.refused}` };
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

const HTTP_CONFLICT = 409;
const NO_CONFIG = 'the Hive has no config yet';
const badBody = (lines: readonly string[]): DraftRefusal => ({ status: HTTP_BAD_REQUEST, error: 'bad_body', message: lines.join('\n') });
const armId = (taken: readonly string[]): string => newId(taken, draw);

// The composed result, or every issue it has; nothing is written yet
function checked(start: Experiment, body: DraftInput): Experiment | DraftRefusal {
  const composed = composeDraft(start, body, armId);
  if (Array.isArray(composed)) return badBody(composed);
  const issues = resultIssues(composed);
  return issues.length > 0 ? badBody(issues) : composed;
}

// A replace (#478): only a draft no round has read; it keeps its id, createdBy and createdAt, and is one benchmarkEdited
async function replaceDraft(ctx: DraftCtx, id: string, body: DraftInput): Promise<string | DraftRefusal> {
  const draft = ctx.experiments.find((e) => e.id === id);
  if (draft === undefined) return unknownExperiment(id);
  if (draft.status !== 'draft' || draft.rounds.length > 0) return { status: HTTP_CONFLICT, error: 'not_draft', message: `${id} is not a draft without rounds: only such a draft can be replaced` };
  const result = checked(draft, body);
  if (isRefusal(result)) return result;
  const { id: _id, from: _from, workspace: _workspace, arms, ...sections } = body;
  return editSections(ctx, draft, { ...sections, ...(arms === undefined ? {} : { arms: result.arms }) });
}

/** benchmark_draft's write (#478): the start in memory, the sections and arms over it, the whole result checked, and only then one write. */
export async function draftExperiment(ctx: DraftCtx, input: unknown, createdBy: Experiment['createdBy']): Promise<string | DraftRefusal> {
  const parsed = DRAFT.safeParse(input);
  if (!parsed.success) return badBody(zodIssues(parsed.error));
  const body = parsed.data;
  if (body.id !== undefined) return replaceDraft(ctx, body.id, body);
  const start = body.from === undefined ? await emptyStart(ctx, body.workspace ?? '', undefined, createdBy) : duplicateStart(ctx, body.from, createdBy);
  if (isRefusal(start)) return start;
  if (body.workspace !== undefined && body.workspace !== start.experiment.workspace) return badBody([`workspace: ${body.from} belongs to ${start.experiment.workspace}`]);
  const result = checked(start.experiment, body);
  if (isRefusal(result)) return result;
  const made = await writeNew(ctx, start, result);
  return isRefusal(made) ? made : made.id;
}

export interface Drafter { draft(input: unknown, createdBy: Experiment['createdBy']): Promise<{ id: string } | { refused: string }> }

/** benchmark_draft's side of McpDeps (#478): the routes' queue, the live state, and an answer the tool turns into its text. */
export function drafter(deps: DraftDeps & { queue: Queue; log: Pick<Logger, 'error'>; live(): { config: Config; experiments: readonly Experiment[] } | undefined }): Drafter {
  return {
    draft: (input, createdBy) => deps.queue(async () => {
      const live = deps.live();
      if (live === undefined) return { refused: NO_CONFIG };
      try {
        const answer = await draftExperiment({ deps, config: live.config, experiments: live.experiments }, input, createdBy);
        return isRefusal(answer) ? { refused: answer.message } : { id: answer };
      } catch (err) {
        if (err instanceof SeedFileMissing) return { refused: `${err.message} is not in the seed's commit or uploads` };
        deps.log.error(`benchmark: draft failed: ${errorCode(err)}`); // the code only: a message names paths under the home
        return { refused: BENCHMARK_IO_MESSAGE };
      }
    }),
  };
}
