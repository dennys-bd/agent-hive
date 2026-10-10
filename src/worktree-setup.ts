import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSetup } from './setup-script.js';
import type { Exec, Workspace } from './types.js';
import { gitDirOf, runSteps, type StepDeps, WORKTREE_NAME } from './worktree-steps.js';

/** The file in the worktree's own git dir that says its setup ran (#299): outside the working tree, so `git status` never shows it, and
 * gone with the worktree, so a recreated one runs the setup again. */
export const SETUP_MARKER = 'hive-setup-done';
export interface SetupDeps extends StepDeps {
  onStep(step: string): void; // the step about to run, as describeStep writes it: the task's progress line
}

/** Whether the workspace's setup has anything to run (#351), from the text alone. A text that does not parse counts: runSetup then fails
 * with the parse error, which reaches the user like any failed step instead of being skipped in silence. */
export function hasSetup(workspace: Workspace): boolean {
  try {
    return parseSetup(workspace.setup ?? '', { allowLoad: true }).length > 0;
  } catch {
    return true;
  }
}

/** runSetup's two "nothing to do" checks (#351): no steps, or the marker already in the worktree's git dir. */
export async function needsSetup(workspace: Workspace, worktree: string, exec: Exec): Promise<boolean> {
  if (!hasSetup(workspace)) return false;
  const marker = join(await gitDirOf(worktree, exec), SETUP_MARKER);
  return !(await access(marker).then(() => true, () => false));
}

/** Whether a worktree that is already on disk has nothing to set up (#351), asked with the plain exec before any mark, so a start or an
 * open on a set-up worktree gets no mark and no console run. A folder not there yet (a new or gone worktree) is never set up and asks no
 * git; git that names no git dir (a folder git does not know) counts as not set up, and the git that follows will say why. */
export async function isSetUp(workspace: Workspace, worktree: string, exec: Exec): Promise<boolean> {
  if (!(await access(worktree).then(() => true, () => false))) return false;
  return !(await needsSetup(workspace, worktree, exec).catch(() => true));
}

/**
 * The workspace's worktree setup (#299), after ensureWorktree and before the worker or the session: nothing without steps, nothing once the
 * marker is in the worktree's git dir. It reads the main checkout and writes the worktree (runSteps). A failure throws `setup failed at line
 * <n> (<step>): <reason>` and writes no marker, so the next spawn or open runs it again; success writes it. Answers the number of steps it ran (0 when it skipped).
 */
export async function runSetup(workspace: Workspace, worktree: string, deps: SetupDeps): Promise<number> {
  const steps = parseSetup(workspace.setup ?? '', { allowLoad: true });
  if (steps.length === 0) return 0;
  const marker = join(await gitDirOf(worktree, deps.exec), SETUP_MARKER);
  if (await access(marker).then(() => true, () => false)) return 0;
  const phase = { name: 'setup', from: workspace.path, fromName: workspace.name, to: worktree, toName: WORKTREE_NAME, timeout: workspace.setupTimeout } as const;
  const ran = await runSteps(phase, workspace, worktree, steps, deps);
  await writeFile(marker, '');
  return ran;
}
