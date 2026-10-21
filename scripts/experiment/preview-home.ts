import { join } from 'node:path';
import { runConfig, runState } from './harness-config.js';
import { runBranch, runPrefix } from './plan.js';
import type { SeedTask, StagesSeed } from './seed.js';
import type { Arm } from './types.js';

// Fixed per arm so a preview reopens the same home; distinct so the two arms' task ids differ as in a pair
export const PREVIEW_TOKENS: Record<Arm, string> = { a: 'aaaaaa', b: 'bbbbbb' };

export interface PreviewHome { home: string; config: Record<string, unknown>; state: Record<string, unknown> }

/** One arm's home as a run writes it, for the user to review in the window before a night: the same config, but every task with auto
 *  off, so opening it starts no worker. The run branch it names does not exist; nothing reads it until a stage starts. */
export function previewHome(seed: { stages: StagesSeed; tasks: readonly SeedTask[] }, arm: Arm, workspace: string, state: string): PreviewHome {
  const token = PREVIEW_TOKENS[arm];
  const home = join(state, 'homes', `preview-${arm}`);
  const prefix = runPrefix(token);
  const config = runConfig(seed.stages, arm, runBranch(token), workspace, prefix, { state, home });
  const run = runState(seed.tasks, String(seed.stages.stages[0]?.name), prefix);
  const tasks = (run.tasks as Record<string, unknown>[]).map((task) => ({ ...task, auto: false }));
  return { home, config, state: { ...run, tasks } };
}
