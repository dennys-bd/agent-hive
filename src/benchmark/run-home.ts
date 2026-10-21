import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentDir } from '../benchmark-guards.js';
import { CONFIG_FILE, workspaceByName } from '../config.js';
import type { Config, Experiment } from '../types.js';
import { inDir, type Run } from './exec.js';
import { BASELINE_BRANCH, CLONE_DIR, experimentBaseline, nestedBaseline, nestedOrigin, NESTED_DIR, ORIGIN_DIR, resolveBaseline, unsignedCommits } from './git.js';
import { excludeSandbox } from './sandbox.js';

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
  await privateDir(dir);
  try {
    await makeOrigin(deps.exec, workspace.path, join(dir, ORIGIN_DIR), (git) => experimentBaseline(git, { source: experiment.seed.commit, scratch: dir }));
    for (const path of workspace.nestedRepos) {
      await makeOrigin(deps.exec, join(workspace.path, path), nestedOrigin(dir, path), async (git) => nestedBaseline(git, { source: await resolveBaseline(git, NESTED_SOURCE), scratch: dir }));
    }
    await makeClones(deps.exec, dir, workspace.nestedRepos);
  } catch (err) {
    // ponytail: a crash (not a rejection) between the init and the clone still leaves repo.git; 3.2's per-experiment lock is where to add a ready marker
    await Promise.all([ORIGIN_DIR, NESTED_DIR, CLONE_DIR].map((d) => rm(join(dir, d), { recursive: true, force: true })));
    throw err;
  }
  deps.log?.(`benchmark ${experiment.id}: origins and clone ready`);
}
