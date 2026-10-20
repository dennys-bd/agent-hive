import { createHash } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeStep, parseSetup, type SetupStep } from './setup-script.js';
import type { Exec, Workspace } from './types.js';
import { expandSteps, gitDirOf, type Resume, runSteps, type StepDeps, WORKTREE_NAME } from './worktree-steps.js';

/** The file in the worktree's own git dir that says its setup ran (#299): outside the working tree, so `git status` never shows it, and
 * gone with the worktree, so a recreated one runs the setup again. */
export const SETUP_MARKER = 'hive-setup-done';

/** The steps a setup that failed already passed (#390), next to SETUP_MARKER and with its lifetime: `{ steps: <sha256 of the expanded steps'
 * describeStep lines>, done: <n> }`, written after each step that passes and removed when the marker is written. */
export const SETUP_PROGRESS = 'hive-setup-progress';

const hashOf = (steps: SetupStep[]): string => createHash('sha256').update(steps.map(describeStep).join('\n')).digest('hex');

// How many steps this run skips (#390): the record's count when it was written for this very list (a setup edited, or a LOADed file changed,
// hashes differently); a record missing, unreadable or out of range is 0
async function passedSteps(path: string, hash: string, total: number): Promise<number> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    const { steps, done } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const count = typeof done === 'number' && Number.isInteger(done) ? done : -1;
    return steps === hash && count >= 0 && count <= total ? count : 0;
  } catch {
    return 0;
  }
}

// A setup run's resume (#390): what it skips, and the record each passing step writes
async function resumeOf(gitDir: string, steps: SetupStep[]): Promise<Resume> {
  const path = join(gitDir, SETUP_PROGRESS);
  const hash = hashOf(steps);
  return { skip: await passedSteps(path, hash, steps.length), passed: (done) => writeFile(path, JSON.stringify({ steps: hash, done })) };
}
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

/** A setup that failed on a worktree that reused an existing branch (#267) says which: that branch is the likeliest cause, as on #105, where a
 * branch from before the docs split broke the docs step. The server's English, as every setup error is; no reused branch, the error as is. */
export function withReused(err: unknown, reused: string | undefined): unknown {
  if (reused === undefined) return err;
  return new Error(`${err instanceof Error ? err.message : String(err)}\nThe worktree reused the existing branch ${reused}.`);
}

/**
 * The workspace's worktree setup (#299), after ensureWorktree and before the worker or the session: nothing without steps, nothing once the
 * marker is in the worktree's git dir. It reads the main checkout and writes the worktree (runSteps). The LOAD lines are expanded here and
 * the list hashed (#390): a run after a failure skips the steps that passed while the list is the same. A failure throws `setup failed at step <i> of
 * <n> (line <l>, <step>): <reason>` (#267) and writes no marker, so the next spawn or open runs it again from that step; success writes it and removes the
 * progress record. Answers the number of steps it ran (0 when it skipped).
 */
export async function runSetup(workspace: Workspace, worktree: string, deps: SetupDeps): Promise<number> {
  const steps = parseSetup(workspace.setup ?? '', { allowLoad: true });
  if (steps.length === 0) return 0;
  const gitDir = await gitDirOf(worktree, deps.exec);
  const marker = join(gitDir, SETUP_MARKER);
  if (await access(marker).then(() => true, () => false)) return 0;
  const phase = { name: 'setup', from: workspace.path, fromName: workspace.name, to: worktree, toName: WORKTREE_NAME, timeout: workspace.setupTimeout } as const;
  const expanded = await expandSteps(phase, workspace, steps); // #390: hashed before it runs, so a resume never skips a step that changed
  const ran = await runSteps(phase, workspace, worktree, expanded, { ...deps, resume: await resumeOf(gitDir, expanded) });
  await writeFile(marker, '');
  await rm(join(gitDir, SETUP_PROGRESS), { force: true });
  return ran;
}
