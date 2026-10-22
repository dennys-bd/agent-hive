import { join } from 'node:path';
import { MCP_DEFAULTS, MEMORY_CAP_DEFAULT, SIGNALS_DEFAULTS, WORKSPACE_PRESET_COLORS } from '../../src/types.js';
import { SANDBOX_FILE } from '../../src/benchmark/sandbox.js';
import type { SeedTask, StageRole, StagesSeed } from './seed.js';
import type { Arm } from './types.js';
import type { WatchTask } from '../../src/benchmark/watcher.js';
import { type RunPaths, runClaudeArgs } from '../../src/benchmark/worker-rules.js';

export const EXPERIMENT_PREFIX = 'MON'; // the sample and the evaluation; a run uses its own prefix (plan.ts runPrefix)
export const WORKSPACE_NAME = 'agent-hive';
export const MAX_CONCURRENT = 3; // per arm; Build caps at 2, so a pair runs at most 4 Build workers (#105, the user)
const SETUP_TIMEOUT = '10m';
const MAIN_CHECKOUT = '"$(git rev-parse --path-format=absolute --git-common-dir)/.."';

/** Every task worktree gets the workers' sandbox (sandbox.ts) before its first worker, a docs worktree, and can run pnpm test, Merge's
 *  included. The docs worktree is CLAUDE.md's setup line, but a new branch starts from the docs run branch, which holds the docs baseline,
 *  not from origin/main, which holds the real docs and the experiment's own (#79). runBranch is a plain ref (plan.ts runBranch). */
export function workspaceSetup(runBranch: string): string {
  const docs = `git -C "$main/docs"`;
  return [
    `COPY ${SANDBOX_FILE}`,
    `RUN main=${MAIN_CHECKOUT} && branch="$(git branch --show-current)" && ${docs} fetch -q origin && { ${docs} worktree add "$PWD/docs" "$branch" 2>/dev/null || ${docs} worktree add --no-track -b "$branch" "$PWD/docs" "origin/${runBranch}"; }`,
    'RUN pnpm install --frozen-lockfile',
  ].join('\n');
}
/** CLAUDE.md's teardown line: no --force, so a doc a worker left uncommitted fails it instead of being lost. */
export const WORKSPACE_TEARDOWN = 'RUN git -C "$(git rev-parse --path-format=absolute --git-common-dir)/../docs" worktree remove "$PWD/docs"';

export const ARM_COMMANDS: Record<Arm, Record<StageRole, string>> = {
  a: { spec: 'hive-spec', plan: 'hive-plan', build: 'hive-build' },
  b: { spec: 'hive:new-spec', plan: 'hive:new-plan', build: 'hive:new-build' },
};

/** Two harmless run commands, so delivery 6's chip can show running, done and failed in the evaluation. Constant lines, no user value. */
export const EVAL_COMMANDS = [
  { name: 'hive test', impls: [{ workspace: WORKSPACE_NAME, command: 'sleep 5 && echo ok' }], menu: true, env: {}, timeout: '1m' },
  { name: 'falha', impls: [{ workspace: WORKSPACE_NAME, command: 'sleep 2 && exit 1' }], menu: true, env: {}, timeout: '1m' },

];

// Every required key besides the Comb, the same in both arms and the evaluation. No `port`: each daemon binds a free one (#466)
const SETTINGS = {
  onClose: 'quit', deleteActivity: { session: false, transcripts: false, nonAutoTasks: false }, shutdownIdleMinutes: 30, approvalMinutes: 10, rateLimitWaitMinutes: 300,
  showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: false, closeStageTabNotice: false, sleepNotice: false, sleepAutoNotice: false, sleepIdleNotice: false, sleepAllNotice: false, closeTerminalTab: 'keep', closeTerminalTabNotice: false,
  defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, mcp: MCP_DEFAULTS,
  editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} },
};

const fill = (text: string, values: Record<string, string>): string => Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(`{${key}}`, value), text);

/** {command} becomes the arm's command for the stage's role, {runBranch} the run branch; {title}, {body} and {id} stay for the Hive. */
export function armStages(seed: StagesSeed, arm: Arm, runBranch: string): Record<string, unknown>[] {
  return seed.stages.map(({ role, prompt, ...stage }) => {
    if (typeof prompt !== 'string') return stage;
    const command = role === undefined ? '' : ARM_COMMANDS[arm][role as StageRole];
    return { ...stage, prompt: fill(prompt, { command, runBranch }) };
  });
}

export interface HarnessPaths { state: string; home: string }
/** The harness's rules: every home under the state folder's homes/ keeps its daemon files from the workers, and its experiments/ folder is unread. */
export const harnessRulePaths = ({ state, home }: HarnessPaths): RunPaths => ({ home, homes: [join(state, 'homes', '*')], denied: [join(state, 'experiments')] });

/** One run's config: `prefix` keeps its task ids, branches and worktrees apart from the other arm's, running beside it; `paths` scope the
 *  workers' own rules to this run (worker-rules.ts). */
export function runConfig(seed: StagesSeed, arm: Arm, runBranch: string, workspace: string, prefix: string, paths: HarnessPaths): Record<string, unknown> {
  return {
    comb: {
      prefix, workspaces: [{ name: WORKSPACE_NAME, path: workspace, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: MEMORY_CAP_DEFAULT, benchmarkPrIn: 'worktree', color: WORKSPACE_PRESET_COLORS[0], setup: workspaceSetup(runBranch), setupTimeout: SETUP_TIMEOUT, teardown: WORKSPACE_TEARDOWN }],
      sources: [], stages: armStages(seed, arm, runBranch), commands: [], hiveSource: true, createIn: 'hive',
    },
    baseBranch: runBranch, agentArgs: { claude: runClaudeArgs(seed.claudeArgs, runBranch, harnessRulePaths(paths)), codex: [] }, ...SETTINGS,
  };
}

export function evalConfig(seed: StagesSeed, workspace: string): Record<string, unknown> {
  const stages = seed.stages.map(({ name, from }) => ({ name, from, maxWorkers: 0 }));
  return {
    comb: { prefix: EXPERIMENT_PREFIX, workspaces: [{ name: WORKSPACE_NAME, path: workspace, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: MEMORY_CAP_DEFAULT, benchmarkPrIn: 'worktree', color: WORKSPACE_PRESET_COLORS[0] }], sources: [], stages, commands: EVAL_COMMANDS, hiveSource: true, createIn: 'hive' },
    language: 'pt', agentArgs: { claude: [], codex: [] }, ...SETTINGS,
  };
}

/** The State keys besides the tasks, as a fresh home holds them; the sample (snapshot.ts) shares them. */
export const stateBase = (): Record<string, unknown> => ({
  signal: 'green', signals: SETTINGS.signals, workers: [], activities: [], activityRecords: [], terminals: [], stages: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, sourceOrder: [],
  localSessions: {}, usage: [], budget: {}, usageRules: [], disabledRules: [],
  deleteActivity: SETTINGS.deleteActivity, shutdownIdleMinutes: SETTINGS.shutdownIdleMinutes, approvalMinutes: SETTINGS.approvalMinutes, rateLimitWaitMinutes: SETTINGS.rateLimitWaitMinutes,
});

/** Local tasks in the first stage, free ones auto at boot. Blockers are not written: the watcher releases, so no local blocker decides. */
export function runState(tasks: readonly SeedTask[], firstStage: string, prefix: string): Record<string, unknown> {
  // No `workers`: loadState makes one free worker per maxConcurrent only when the key is absent; a saved [] leaves the daemon none to start with
  const { workers: _workers, ...base } = stateBase();
  return {
    ...base, maxConcurrent: MAX_CONCURRENT, localCount: tasks.length,
    tasks: tasks.map((task, i) => {
      const item = { itemId: `local:${i + 1}`, id: `${prefix}-${i + 1}`, title: task.title, body: task.body, url: '' };
      return { item, stage: firstStage, boardColumn: '', auto: task.blockedBy.length === 0, created: true, workspace: WORKSPACE_NAME };
    }),
  };
}

export function watchTasks(tasks: readonly SeedTask[]): WatchTask[] {
  const idOf = (key: string): string => `local:${tasks.findIndex((t) => t.key === key) + 1}`;
  return tasks.map((task, i) => ({ itemId: `local:${i + 1}`, key: task.key, title: task.title, blockedBy: task.blockedBy.map(idOf) }));
}
