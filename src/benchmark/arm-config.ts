import { join } from 'node:path';
import { workspaceByName } from '../config.js';
import { initialState } from '../orchestrator.js';
import { shellQuote } from '../shell-init.js';
import { HIVE_SOURCE } from '../tasks.js';
import { MCP_DEFAULTS, type Arm, type ArmSetup, type BenchStageRole, type BenchTask, type CombConfig, type Config, type Experiment, type IsolationRow, type Stage, type State, type Task, type Workspace } from '../types.js';
import { runBranch, runPrefix } from './git.js';
import { RUN_SANDBOX_FILE, SANDBOX_FILE } from './sandbox.js';
import type { WatchTask } from './watcher.js';
import { type RunPaths, runClaudeArgs } from './worker-rules.js';

export const RUN_STAGES: readonly { role: BenchStageRole; name: string }[] = [
  { role: 'spec', name: 'Spec' }, { role: 'plan', name: 'Plan' }, { role: 'build', name: 'Build' }, { role: 'pr', name: 'PR' },
];
export const DONE_STAGE = 'Done';

// Shallow on purpose: the arm screens reset and copy per section, so an override key replaces the base's whole value
export const mergeArm = (base: ArmSetup, overrides: Partial<ArmSetup>): ArmSetup => ({ ...base, ...overrides });

// hasOwn: an arm id like `constructor` must not reach Object.prototype
export const resolveRow = <T>(row: IsolationRow<T>, armId: string): T => (row.perArm !== undefined && Object.hasOwn(row.perArm, armId) ? row.perArm[armId] : row.all);

export function runStages(picks: ArmSetup['stages']): Pick<CombConfig, 'stages' | 'transitions'> {
  const stages: Stage[] = RUN_STAGES.map(({ role, name }, i) => {
    const pick = picks[role];
    // #925: a session resumes only under its own agent, so a stage whose agent changes starts a new one
    const continues = i > 0 && picks[RUN_STAGES[i - 1].role].agent === pick.agent;
    return { name, from: {}, prompt: pick.prompt, agent: pick.agent, ...(pick.model === undefined ? {} : { model: pick.model }), ...(continues ? { session: 'continue' as const } : {}) };
  });
  // Done holds a finished task: the watcher (3.3) counts what reaches it, and no prompt runs there
  const names = [...stages.map((s) => s.name), DONE_STAGE];
  return { stages: [...stages, { name: DONE_STAGE, from: {} }], transitions: names.slice(0, -1).map((from, i) => ({ from, to: names[i + 1], when: 'done' as const })) };
}

// COPY only reads inside the main checkout and sandbox.json lives in the run home, so the copy is a RUN line; the home goes through shellQuote
export const sandboxSetupLine = (home: string): string => `RUN mkdir -p .claude && cp ${shellQuote(join(home, RUN_SANDBOX_FILE))} ${SANDBOX_FILE}`;

export interface RunConfigPaths { clone: string; home: string; rules: RunPaths }

// The workspace's own, at the clone: its env with the arm's env row over it, its nested repos; its base branch would override the run
// branch, a fork has no meaning on a local origin, and the arm's worktree setup runs after the sandbox copy
function runWorkspace(main: Config, experiment: Experiment, arm: Arm, setup: ArmSetup, paths: RunConfigPaths): Workspace {
  const source = workspaceByName(main, experiment.seed.workspace);
  if (source === undefined) throw new Error(`workspace ${experiment.seed.workspace} is gone`);
  const { baseBranch: _base, setup: _setup, teardown: _teardown, ...kept } = source;
  const lines = [sandboxSetupLine(paths.home), setup.worktree.setup].filter((l) => l.trim() !== '').join('\n');
  const teardown = setup.worktree.teardown.trim() === '' ? {} : { teardown: setup.worktree.teardown };
  return { ...kept, path: paths.clone, fork: false, env: { ...source.env, ...resolveRow(experiment.isolation.env, arm.id) }, setup: lines, ...teardown };
}

// Claude Code's own settings bind the isolation rows; a Codex pick gets the main config's Codex args only (spec)
function claudeArgs(experiment: Experiment, arm: Arm, setup: ArmSetup, token: string, rules: RunPaths): string[] {
  const row = <T>(r: IsolationRow<T>): T => resolveRow(r, arm.id);
  const turns = row(experiment.isolation.limits).turns;
  return runClaudeArgs([
    '--permission-mode', row(experiment.isolation.permissionMode),
    ...(turns === undefined ? [] : ['--max-turns', String(turns)]),
    '--allowedTools', [...row(experiment.isolation.allowedTools), ...setup.rules.allow].join(' '),
    '--disallowedTools', [...row(experiment.isolation.deniedTools), ...setup.rules.deny].join(' '),
    ...setup.plugins.flatMap((dir) => ['--plugin-dir', dir]),
  ], runBranch(token), rules);
}

/** The main Hive's current config with the run's comb: every required settings key comes along without a hand-kept list. `branch` goes
 *  so task branches are hive/<PREFIX>-*, which stopRun removes. The MCP servers do not come along. limits.ms is 3.2's timeout. */
export function runConfig(main: Config, experiment: Experiment, arm: Arm, token: string, paths: RunConfigPaths): Config {
  const setup = mergeArm(experiment.base, arm.overrides);
  const { comb: _comb, baseBranch: _base, branch: _template, agentArgs, ...rest } = main;
  const comb = { prefix: runPrefix(token), workspaces: [runWorkspace(main, experiment, arm, setup, paths)], sources: [], ...runStages(setup.stages), commands: [], hiveSource: true, createIn: HIVE_SOURCE };
  // mcp: the user's own servers (and their tokens) are not the run's to hand to a worker
  return { ...rest, comb, mcp: MCP_DEFAULTS, baseBranch: runBranch(token), agentArgs: { ...agentArgs, claude: claudeArgs(experiment, arm, setup, token, paths.rules) } };
}

/** The arm's tasks as local tasks in the first stage; only the unblocked ones auto, since the watcher (3.3) releases the others. */
export function runState(tasks: readonly BenchTask[], token: string, workspace: string, maxConcurrent: number): State {
  const prefix = runPrefix(token);
  const local = tasks.map((task, i): Task => ({ item: { itemId: `local:${i + 1}`, id: `${prefix}-${i + 1}`, title: task.title, body: task.body, url: '' }, stage: RUN_STAGES[0].name, boardColumn: '', auto: task.blockedBy.length === 0, created: true, workspace }));
  return { ...initialState(maxConcurrent), tasks: local, localCount: tasks.length };
}

/** The run's blocker graph for the watcher (#473, the harness's): task n is local:<n> in seed order, as runState seeds it. */
export function watchTasks(tasks: readonly Pick<BenchTask, 'key' | 'title' | 'blockedBy'>[]): WatchTask[] {
  const idOf = (key: string): string => `local:${tasks.findIndex((t) => t.key === key) + 1}`;
  return tasks.map((task, i) => ({ itemId: `local:${i + 1}`, key: task.key, title: task.title, blockedBy: task.blockedBy.map(idOf) }));
}
