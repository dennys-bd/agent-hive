import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentDir, runHome } from '../benchmark-guards.js';
import { CONFIG_FILE, workspaceByName } from '../config.js';
import { type ItemKey, listFiles, childFolders, parseItemId, versionDir } from '../item-sources.js';
import { pluginRenderPath } from '../plugin-render.js';
import { VERSION_FILE, parseVersionJson, writeVersionJson } from '../custom-versions.js';
import type { Arm, ArmSetup, BenchRun, Config, Experiment, Workspace } from '../types.js';
import { mergeArm, RUN_STAGES, resolveRow, runConfig, runState } from './arm-config.js';
import { type BlindInput, blindLeak } from './blind-check.js';
import { inDir, type Run } from './exec.js';
import { BASELINE_BRANCH, CLONE_DIR, createRunBranch, experimentBaseline, nestedBaseline, nestedOrigin, NESTED_DIR, ORIGIN_DIR, resolveBaseline, runBranch, unsignedCommits } from './git.js';
import { excludeSandbox, RUN_SANDBOX_FILE, sandboxSettings } from './sandbox.js';
import type { RunPaths } from './worker-rules.js';

export const STATE_FILE = 'state.json'; // state-store.ts keeps its name private
const NESTED_SOURCE = 'origin/HEAD'; // the seed fixes only the outer commit; #653 starts nested worktrees from the nested origin
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A fresh home, as test-hive.ts's resetHome builds one: written before the daemon boots, never while it runs. 0700: it holds the secret. */
export async function writeHome(home: string, config: unknown, state: unknown): Promise<void> {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, CONFIG_FILE), json(config), { mode: 0o600 });
  await writeFile(join(home, STATE_FILE), json(state), { mode: 0o600 });
}

/** mkdir + chmod 0700: mkdir's mode is cut by the umask and skipped for a folder that exists. */
export async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

// A nested repo path joins the clone's and reaches git's argv: relative, no dot-dot, no leading dash (the config's own check is looser)
function nestedPaths(workspace: Workspace): readonly string[] {
  for (const path of workspace.nestedRepos) {
    if (path === '' || path.startsWith('/') || path.startsWith('-') || path.split('/').some((segment) => segment === '..')) throw new Error(`benchmark: nested repo path is not a plain relative path: ${JSON.stringify(path)}`);
  }
  return workspace.nestedRepos;
}

export interface ExperimentDeps { hiveDir: string; config: Config; exec: Run; log?: (line: string) => void }

async function makeOrigin(exec: Run, source: string, origin: string, baseline: (git: Run) => Promise<string>): Promise<void> {
  const git = inDir(exec, source);
  const sha = await baseline(git);
  await exec('git', ['init', '--bare', '-q', '--initial-branch', BASELINE_BRANCH, origin]);
  await git('git', ['push', '-q', origin, `${sha}:refs/heads/${BASELINE_BRANCH}`]);
}

async function makeClones(exec: Run, dir: string, nested: readonly string[]): Promise<void> {
  const clone = join(dir, CLONE_DIR);
  await exec('git', ['clone', '-q', '--', join(dir, ORIGIN_DIR), clone]);
  await unsignedCommits(inDir(exec, clone));
  for (const path of nested) {
    await exec('git', ['clone', '-q', '--', nestedOrigin(dir, path), join(clone, path)]);
    await unsignedCommits(inDir(exec, join(clone, path)));
  }
  // The sandbox file differs per run (spec): only its name is kept out of git here, each run's setup copies its own
  await excludeSandbox(join(clone, '.git'));
}

/** A no-op when repo.git exists. Otherwise the bare origins with their baselines, the clone and its nested clones, unsigned, the sandbox
 *  file excluded; a failure removes what it made, so the next run prepares again. */
export async function prepareExperiment(experiment: Experiment, deps: ExperimentDeps): Promise<void> {
  const dir = experimentDir(deps.hiveDir, experiment.id);
  if (existsSync(join(dir, ORIGIN_DIR))) return;
  const workspace = workspaceByName(deps.config, experiment.seed.workspace);
  if (workspace === undefined) throw new Error(`workspace ${experiment.seed.workspace} is gone`);
  const nested = nestedPaths(workspace);
  await privateDir(dir);
  try {
    await makeOrigin(deps.exec, workspace.path, join(dir, ORIGIN_DIR), (git) => experimentBaseline(git, { source: experiment.seed.commit, scratch: dir }));
    for (const path of nested) {
      await makeOrigin(deps.exec, join(workspace.path, path), nestedOrigin(dir, path), async (git) => nestedBaseline(git, { source: await resolveBaseline(git, NESTED_SOURCE), scratch: dir }));
    }
    await makeClones(deps.exec, dir, nested);
  } catch (err) {
    // ponytail: a crash (not a rejection) between the init and the clone still leaves repo.git; 3.2's per-experiment lock is where to add a ready marker
    await Promise.all([ORIGIN_DIR, NESTED_DIR, CLONE_DIR].map((d) => rm(join(dir, d), { recursive: true, force: true })));
    throw err;
  }
  deps.log?.(`benchmark ${experiment.id}: origins and clone ready`);
}

export const MARKER_FILE = 'benchmark.json';
const TOKEN_LENGTH = 8;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const ALPHABET = `${LETTERS}0123456789`;

export interface RunMarker { experiment: { id: string; name: string }; arm: { letter: string; name: string }; round: number; pairs: number; token: string; frozen: boolean }
export interface RunDeps extends ExperimentDeps { random?: () => number }

/** 8 chars [a-z0-9], a letter first: upper-cased it is the comb prefix, which COMB_PREFIX wants to start with one. */
export function newToken(random: () => number, taken: ReadonlySet<string>): string {
  const pick = (chars: string): string => chars[Math.floor(random() * chars.length)];
  const draw = (): string => pick(LETTERS) + Array.from({ length: TOKEN_LENGTH - 1 }, () => pick(ALPHABET)).join('');
  let token = draw();
  while (taken.has(token)) token = draw();
  return token;
}

interface ArmVersion { key: ItemKey; version: string; dir: string; files: string[] }

// The custom store's versions the arm names, read before anything is written: an unknown one refuses the run
async function armVersions(hiveDir: string, items: Record<string, string>): Promise<ArmVersion[]> {
  return Promise.all(Object.entries(items).map(async ([id, version]) => {
    const key = parseItemId(id);
    if (key === undefined) throw new Error(`benchmark: ${id} is not an item id`);
    const dir = versionDir(hiveDir, key, version);
    if (!existsSync(join(dir, VERSION_FILE))) throw new Error(`benchmark: ${id} has no version ${version}`);
    return { key, version, dir, files: await listFiles(dir) };
  }));
}

// A file holding a NUL byte is binary (a screenshot): no word a worker reads as text
async function fileInputs(root: string, files: readonly string[], label: string): Promise<BlindInput[]> {
  const read = await Promise.all(files.map(async (path) => ({ where: `${label}/${path}`, buffer: await readFile(join(root, path)) })));
  return read.filter(({ buffer }) => !buffer.includes(0)).map(({ where, buffer }) => ({ where, text: buffer.toString('utf8') }));
}

async function refuseLeak(experiment: Experiment, arm: Arm, setup: ArmSetup, versions: readonly ArmVersion[], seedDir: string): Promise<void> {
  const inputs: BlindInput[] = [
    ...setup.tasks.map((task) => ({ where: `task ${task.key}`, text: `${task.title}\n${task.body}` })),
    ...RUN_STAGES.map(({ role }) => ({ where: `stage ${role}`, text: setup.stages[role].prompt })),
    // the setup and teardown lines run in the worker's worktree, and the env values reach its process: both are read there
    { where: 'worktree setup', text: setup.worktree.setup }, { where: 'worktree teardown', text: setup.worktree.teardown },
    ...Object.entries(resolveRow(experiment.isolation.env, arm.id)).map(([name, value]) => ({ where: `env ${name}`, text: `${name}=${value}` })),
    ...(await fileInputs(seedDir, await listFiles(seedDir), 'seed')),
    ...(await Promise.all(versions.map((v) => fileInputs(v.dir, v.files, `custom/${v.key.origin}/${v.key.name}/${v.version}`)))).flat(),
  ];
  const leak = blindLeak(inputs, experiment.blindness.forbiddenWords);
  if (leak) throw new Error(`blindness: "${leak.word}" in ${leak.where}`);
}

async function takenTokens(experiment: Experiment, dir: string): Promise<Set<string>> {
  const used = experiment.rounds.flatMap((round) => round.runs.map((r) => r.token));
  return new Set([...used, ...(await childFolders(join(dir, 'runs')))]);
}

async function createRunBranches(exec: Run, dir: string, nested: readonly string[], token: string): Promise<void> {
  const clone = join(dir, CLONE_DIR);
  for (const path of ['', ...nested]) await createRunBranch(inDir(exec, join(clone, path)), runBranch(token), `origin/${BASELINE_BRANCH}`);
}

// Copied so the run daemon's own render delivers it, to the run workspace only
async function copyVersions(home: string, versions: readonly ArmVersion[], workspace: string): Promise<void> {
  for (const v of versions) {
    const to = versionDir(home, v.key, v.version);
    // A symlink would carry a file outside the store into the worker's reach
    await cp(v.dir, to, { recursive: true, filter: async (src) => !(await lstat(src)).isSymbolicLink() });
    await writeVersionJson(to, { ...parseVersionJson(await readFile(join(to, VERSION_FILE), 'utf8'), v.version), workspaces: [workspace] });
  }
}

interface RunInputs { experiment: Experiment; arm: Arm; setup: ArmSetup; round: number; token: string; versions: readonly ArmVersion[]; nested: readonly string[]; checkout: string }

async function writeRunHome(inputs: RunInputs, deps: RunDeps): Promise<void> {
  const { experiment, arm, setup, token, versions, nested, checkout } = inputs;
  const home = runHome(deps.hiveDir, experiment.id, token);
  const dir = experimentDir(deps.hiveDir, experiment.id);
  const clone = join(dir, CLONE_DIR);
  const all = join(deps.hiveDir, 'benchmark', '*');
  const rules: RunPaths = { home, homes: [deps.hiveDir, all, join(all, 'runs', '*')], denied: ['seed', 'plugin', 'report.md'].map((f) => join(all, f)) };
  const origins = [join(dir, ORIGIN_DIR), ...nested.map((p) => nestedOrigin(dir, p))];
  const sandbox = sandboxSettings({
    repos: [{ gitDir: join(clone, '.git'), origin: origins[0] }, ...nested.map((p, i) => ({ gitDir: join(clone, p, '.git'), origin: origins[i + 1] }))],
    // the whole Hive home (config, state, port, secret, custom, prompts, every experiment); the clone with its nested clones, the origins and
    // the run's own rendered plugin are re-allowed by exact path. The user's checkout still holds the harness and the experiment's own docs
    denied: [deps.hiveDir, checkout],
    allowRead: [clone, ...origins, pluginRenderPath(home, experiment.seed.workspace)],
    allowedDomains: resolveRow(experiment.isolation.network, arm.id),
  });
  const marker: RunMarker = { experiment: { id: experiment.id, name: experiment.name }, arm: { letter: arm.letter, name: arm.name }, round: inputs.round, pairs: experiment.pace.pairs, token, frozen: false };
  await writeHome(home, runConfig(deps.config, experiment, arm, token, { clone, home, rules }), runState(setup.tasks, token, experiment.seed.workspace, experiment.pace.workersPerArm));
  await copyVersions(home, versions, experiment.seed.workspace);
  await writeFile(join(home, RUN_SANDBOX_FILE), json(sandbox), { mode: 0o600 });
  await writeFile(join(home, MARKER_FILE), json(marker), { mode: 0o600 });
}

// Best effort, and the original error is what the caller sees: a branch that never reached an origin has nothing to delete
async function undoRun(deps: RunDeps, dir: string, nested: readonly string[], token: string, home: string): Promise<void> {
  const branch = runBranch(token);
  for (const path of ['', ...nested]) {
    const git = inDir(deps.exec, join(dir, CLONE_DIR, path));
    await git('git', ['push', 'origin', '--delete', branch]).catch(() => undefined);
    await git('git', ['branch', '-D', branch]).catch(() => undefined);
  }
  await rm(home, { recursive: true, force: true });
}

/** The blindness check first, before any git or file; then the run branch on every origin and runs/<token>/ (config, state, custom/,
 *  sandbox.json, benchmark.json). Answers the queued BenchRun. Two runs preparing at once need a serialized exec (serialGit). */
export async function prepareRun(experiment: Experiment, arm: Arm, round: number, deps: RunDeps): Promise<BenchRun> {
  const workspace = workspaceByName(deps.config, experiment.seed.workspace);
  if (workspace === undefined) throw new Error(`workspace ${experiment.seed.workspace} is gone`);
  const nested = nestedPaths(workspace);
  const dir = experimentDir(deps.hiveDir, experiment.id);
  const setup = mergeArm(experiment.base, arm.overrides);
  const versions = await armVersions(deps.hiveDir, setup.items);
  if (experiment.blindness.on) await refuseLeak(experiment, arm, setup, versions, join(dir, 'seed'));
  // Math.random: the token names folders and is no secret
  const token = newToken(deps.random ?? Math.random, await takenTokens(experiment, dir));
  try {
    await createRunBranches(deps.exec, dir, nested, token);
    await writeRunHome({ experiment, arm, setup, round, token, versions, nested, checkout: workspace.path }, deps);
  } catch (err) {
    await undoRun(deps, dir, nested, token, runHome(deps.hiveDir, experiment.id, token));
    throw err;
  }
  deps.log?.(`benchmark ${experiment.id} ${token}: run branch and home ready`);
  return { token, armId: arm.id, round, status: 'queued', home: runHome(deps.hiveDir, experiment.id, token), branch: runBranch(token), sleptMs: 0, delivered: 0, total: setup.tasks.length, interventions: [] };
}
