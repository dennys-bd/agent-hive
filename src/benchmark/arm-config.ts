import { join } from 'node:path';
import { agentOf } from '../agents.js';
import { workspaceByName } from '../config.js';
import { resumedStage } from '../config-transitions.js';
import { initialState } from '../orchestrator.js';
import { shellQuote } from '../shell-init.js';
import { HIVE_SOURCE } from '../tasks.js';
import { runsAgent } from '../stage-agent.js';
import { type AgentId, type Arm, type ArmSetup, type BenchFlow, type BenchTask, type CombConfig, type Command, type Config, END, type Experiment, type IsolationRow, MCP_DEFAULTS, type Stage, type State, type Task, type Transition, type Workspace } from '../types.js';
import { mergeArm } from './arms.js';
import { runBranch, runPrefix } from './git.js';
import { RUN_SANDBOX_FILE, SANDBOX_FILE } from './sandbox.js';
import { DONE_STAGE, type WatchTask } from './watcher.js';
import { type RunPaths, runClaudeArgs } from './worker-rules.js';

export { mergeArm }; // runner-run.ts, run-home.ts and pr.ts keep importing it from here

// hasOwn: an arm id like `constructor` must not reach Object.prototype
export const resolveRow = <T>(row: IsolationRow<T>, armId: string): T => (row.perArm !== undefined && Object.hasOwn(row.perArm, armId) ? row.perArm[armId] : row.all);

// #925: a session resumes only under its own agent; an arm that changes one side of a resume starts a new session there instead
function resumesAnother(transition: Transition, stages: readonly Stage[], defaultAgent: AgentId): boolean {
  const to = stages.find((s) => s.name === transition.to);
  const from = to === undefined ? undefined : stages.find((s) => s.name === resumedStage(transition, to));
  if (to === undefined || from === undefined || !runsAgent(to) || !runsAgent(from)) return false;
  return agentOf(from, { defaultAgent }) !== agentOf(to, { defaultAgent });
}

/** The copied flow as the run's comb (#536): its stages as they are, `end` retargeted to DONE_STAGE, where the watcher (3.3) counts what
 *  reaches it and no prompt runs. */
export function runStages(flow: BenchFlow, defaultAgent: AgentId): Pick<CombConfig, 'stages' | 'transitions'> {
  const stages: Stage[] = [...flow.stages.map((s) => ({ ...s, from: {} })), { name: DONE_STAGE, from: {} }];
  const transitions = flow.transitions.map((t): Transition => {
    const retargeted = t.to === END ? { ...t, to: DONE_STAGE } : t;
    return resumesAnother(retargeted, stages, defaultAgent) ? { ...retargeted, session: 'new' } : retargeted;
  });
  return { stages, transitions };
}

// The copied lines run in the run's one workspace, so each is every workspace's; stages only, never the task menu
const runCommands = (flow: BenchFlow): Command[] => flow.commands.map((c) => ({ name: c.name, impls: [{ workspace: null, command: c.line }], menu: false, env: {} }));

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
  const comb = { prefix: runPrefix(token), workspaces: [runWorkspace(main, experiment, arm, setup, paths)], sources: [], ...runStages(setup.flow, main.defaultAgent), commands: runCommands(setup.flow), hiveSource: true, createIn: HIVE_SOURCE };
  // mcp: the user's own servers (and their tokens) are not the run's to hand to a worker
  return { ...rest, comb, mcp: MCP_DEFAULTS, baseBranch: runBranch(token), agentArgs: { ...agentArgs, claude: claudeArgs(experiment, arm, setup, token, paths.rules) } };
}

/** The arm's tasks as local tasks in the flow's first stage; only the unblocked ones auto, since the watcher (3.3) releases the others. */
export function runState(tasks: readonly BenchTask[], token: string, workspace: string, maxConcurrent: number, firstStage: string): State {
  const prefix = runPrefix(token);
  const local = tasks.map((task, i): Task => ({ item: { itemId: `local:${i + 1}`, id: `${prefix}-${i + 1}`, title: task.title, body: task.body, url: '' }, stage: firstStage, boardColumn: '', auto: task.blockedBy.length === 0, created: true, workspace }));
  return { ...initialState(maxConcurrent), tasks: local, localCount: tasks.length };
}

/** The run's blocker graph for the watcher (#473, the harness's): task n is local:<n> in seed order, as runState seeds it. */
export function watchTasks(tasks: readonly Pick<BenchTask, 'key' | 'title' | 'blockedBy'>[]): WatchTask[] {
  const idOf = (key: string): string => `local:${tasks.findIndex((t) => t.key === key) + 1}`;
  return tasks.map((task, i) => ({ itemId: `local:${i + 1}`, key: task.key, title: task.title, blockedBy: task.blockedBy.map(idOf) }));
}
