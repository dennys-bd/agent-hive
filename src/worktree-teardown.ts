import { access, lstat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseSetup, type SetupStep } from './setup-script.js';
import type { Exec, Workspace } from './types.js';
import { type Phase, runSteps, type StepDeps, WORKTREE_NAME } from './worktree-steps.js';
import { gitOrWords } from './worktree.js';

/** The file in the worktree's own git dir that says its teardown went through (#654), beside the setup's marker and gone with the worktree:
 * a removal that fails after the teardown (a locked worktree, dirt it left) is retried without taking the services down twice. */
export const TEARDOWN_MARKER = 'hive-teardown-done';

// The marker's path (#654), derived from the main repo and never from the worktree: a worker controls the worktree's `.git` file, so asking git
// there could skip the teardown or land the write elsewhere. The admin dir of a worktree is <common dir>/worktrees/<folder name>.
async function markerOf(workspace: Workspace, worktree: string, exec: Exec): Promise<string> {
  const common = (await gitOrWords(workspace.path, ['rev-parse', '--git-common-dir'], exec)).trim();
  if (common === '') throw new Error(`git named no git dir for ${workspace.path}`);
  return join(resolve(workspace.path, common), 'worktrees', basename(worktree), TEARDOWN_MARKER);
}

/** What runTeardown did: ran it, or why not (no lines, already torn down, no folder to run in). */
export type TeardownOutcome = 'ran' | 'none' | 'done' | 'gone';
export interface TeardownResult { outcome: TeardownOutcome; steps: number } // steps: how many ran, for the run's summary
/** The setup's deps without onStep: a teardown has no progress line on the task. */
export type TeardownDeps = Omit<StepDeps, 'onStep'>;

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const isMarked = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined))?.isFile() === true;
const unlinkIfLink = async (path: string): Promise<void> => {
  const found = await lstat(path).catch(() => undefined);
  if (found?.isSymbolicLink()) await unlink(path);
};
const skipped = (outcome: Exclude<TeardownOutcome, 'ran'>): TeardownResult => ({ outcome, steps: 0 });

// POST /settings parses it first, so a bad line here is a config edited by hand: named after the script, as the 400 is
function teardownSteps(workspace: Workspace): SetupStep[] {
  try {
    return parseSetup(workspace.teardown ?? '', { allowLoad: true });
  } catch (err) {
    throw new Error(`teardown ${(err as Error).message}`);
  }
}

/**
 * The workspace's teardown in `worktree` (#654), after git's refusal checks and before the worktree goes. It reads the worktree and writes
 * the main checkout. Skipped when the folder is gone, when there are no lines, or once the marker is in the git dir. A failing step throws
 * `teardown failed at line <n> (<step>): <reason>` and writes no marker; success writes it.
 */
export async function runTeardown(workspace: Workspace, worktree: string, deps: TeardownDeps): Promise<TeardownResult> {
  if (!(await exists(worktree))) return skipped('gone');
  const steps = teardownSteps(workspace);
  if (steps.length === 0) return skipped('none');
  const marker = await markerOf(workspace, worktree, deps.exec);
  if (await isMarked(marker)) return skipped('done'); // a symlink there is a worker's planting, not our marker
  const phase: Phase = { name: 'teardown', from: worktree, fromName: WORKTREE_NAME, to: workspace.path, toName: workspace.name, timeout: workspace.teardownTimeout };
  const ran = await runSteps(phase, workspace, worktree, steps, deps);
  await unlinkIfLink(marker); // a symlink at the marker path would send the write elsewhere
  await writeFile(marker, '');
  return { outcome: 'ran', steps: ran };
}

/** Deletes the teardown's marker (#654) when the worktree is used again (a stage spawn, a first /open): a worktree brought back to life gets
 * its teardown on the next removal. Quiet when there is no folder, no git dir or no marker, and when the marker cannot be deleted. */
export async function clearTeardownMarker(workspace: Workspace, worktree: string, exec: Exec): Promise<void> {
  if (!(await exists(worktree))) return;
  const marker = await markerOf(workspace, worktree, exec).catch(() => undefined);
  if (marker === undefined) return;
  // Any failure is swallowed: the marker only decides whether a later removal repeats its teardown, and no logger reaches here, so a stale
  // marker must not fail the spawn or the open that called this.
  await unlink(marker).catch(() => undefined);
}
