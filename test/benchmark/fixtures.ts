import type { Snapshot, WatchTask } from '../../src/benchmark/watcher.js';
import type { TestContext } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunDeps } from '../../src/benchmark/run-home.js';
import { tempDir } from '../temp-dir.js';
import type { ChildLike } from '../../src/benchmark/daemon.js';
import type { Run } from '../../src/benchmark/exec.js';
import { initialState } from '../../src/orchestrator.js';
import { parseConfig } from '../../src/config.js';
import { combConfig } from '../fakes.js';
import type { Activity, Arm, ArmSetup, BenchIsolation, BenchRun, BenchStagePick, Config, Experiment, Stage, State, Task, Worker } from '../../src/types.js';

const pick = (skill: string): BenchStagePick => ({ agent: 'claude', skill, prompt: `${skill} {title}\n\n{body}` });
export const SETUP: ArmSetup = {
  stages: { spec: pick('/hive:new-spec'), plan: pick('/hive:new-plan'), build: pick('/hive:new-build'), pr: pick('/hive:new-pr') },
  plugins: [], rules: { allow: [], deny: [] }, tasks: [{ key: 'T1', title: 'One', body: 'b', blockedBy: [] }],
  items: {}, worktree: { setup: 'RUN pnpm install', teardown: '' },
};

export const ISOLATION: BenchIsolation = {
  environment: { all: 'local' }, network: { all: [] }, permissionMode: { all: 'dontAsk' }, allowedTools: { all: [] }, deniedTools: { all: [] },
  limits: { all: { turns: 200 } }, env: { all: { CI: '1' } }, betweenRounds: { all: 'fresh-worktree' },
};

export const arm = (id: string, letter: string, overrides: Partial<ArmSetup> = {}): Arm => ({ id, letter, name: `arm ${letter}`, overrides });

// The home under the fake Hive home /hive: the guard wants exactly <hiveDir>/benchmark/<id>/runs/<token>
export const run = (token: string, patch: Partial<BenchRun> = {}): BenchRun => ({
  token, armId: 'a1', round: 1, status: 'running', home: `/hive/benchmark/exp-1/runs/${token}`, branch: `neutral/${token}`,
  startedAt: '2026-10-21T10:00:00.000Z', sleptMs: 0, delivered: 0, total: 1, interventions: [], ...patch,
});

export const experiment = (patch: Partial<Experiment> = {}): Experiment => ({
  id: 'exp-1', name: 'Skills', status: 'draft', createdAt: '2026-10-21T09:00:00.000Z', createdBy: { kind: 'user' },
  workspace: 'hive', plugin: { version: '0.1.0', hash: 'p'.repeat(64) }, seedHash: 's'.repeat(64), tasksHash: 't'.repeat(64),
  base: SETUP, arms: [arm('a1', 'A'), arm('a2', 'B')],
  seed: { workspace: 'hive', commit: 'a'.repeat(40), reference: [], sample: { command: 'pnpm dev', url: '', files: [] }, scenarios: [] },
  pace: { pairs: 3, until: '07:00', runTimeoutMs: 72_000_000, workersPerArm: 3, cap: {} },
  isolation: ISOLATION, blindness: { on: true, forbiddenWords: ['benchmark'] },
  evaluation: { collectors: [], dynamic: true, judge: { agent: 'claude' }, rubric: '' },
  rounds: [], sleeps: [], ...patch,
});

export const stateWith = (...experiments: Experiment[]): State => ({ ...initialState(0), benchmark: { experiments } });

// A write into a frozen object throws in an ES module, so a reducer that mutates fails the test where it writes
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export interface Call { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

export function fakeRun(answer: (call: Call) => string | Error = () => ''): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (file, args, opts = {}) => {
    const call: Call = { file, args, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...(opts.env === undefined ? {} : { env: opts.env }) };
    calls.push(call);
    const out = answer(call);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { run, calls };
}

export const line = (call: Call): string => [call.file, ...call.args].join(' ');

export function fakeChild(exitCode: number | null = null): { child: ChildLike; kills: string[] } {
  const kills: string[] = [];
  return { kills, child: { pid: 7, exitCode, kill: (signal?: NodeJS.Signals): boolean => { kills.push(signal ?? 'SIGTERM'); return true; } } };
}

export const WS_PATH = '/work/hive';
// The main Hive's config: the workspace has a nested repo, its own env, base branch, setup and teardown, and the Hive a branch template
export const mainConfig = (): Config => parseConfig(combConfig({
  path: WS_PATH, branch: 'feat/{id}', stages: [{ name: 'Todo', from: {} }],
  workspaces: [{ name: 'hive', path: WS_PATH, env: { A: '1' }, fork: null, nestedRepos: ['docs'], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', baseBranch: 'develop', setup: 'RUN old', teardown: 'RUN old' }],
}));

// A Hive home whose experiment pinned two versions of hive:new-spec (only `terse` mapped by the tests) and one seed file. The current store
// holds another text for `terse` and a version `fresh` the pin lacks: a run must read the pin, never the current store (#459)
export async function benchHome(t: TestContext): Promise<{ hiveDir: string; calls: Call[]; lines: string[]; deps: RunDeps }> {
  const hiveDir = await tempDir(t, 'bench-');
  const writeVersion = async (home: string, version: string, text: string): Promise<void> => {
    const dir = join(home, 'custom', 'hive', 'new-spec', version);
    await mkdir(join(dir, 'files'), { recursive: true });
    await writeFile(join(dir, 'version.json'), JSON.stringify({ name: version, from: null, workspaces: ['other'] }));
    await writeFile(join(dir, 'files', 'SKILL.md'), text);
  };
  const pin = join(hiveDir, 'benchmark', 'exp-1', 'plugin');
  for (const version of ['terse', 'long']) await writeVersion(pin, version, `Spec skill for this arm, ${version}.`);
  await writeVersion(hiveDir, 'terse', 'Current text, edited after the pin.');
  await writeVersion(hiveDir, 'fresh', 'Made after the pin.');
  await mkdir(join(hiveDir, 'benchmark', 'exp-1', 'seed'), { recursive: true });
  await writeFile(join(hiveDir, 'benchmark', 'exp-1', 'seed', 'ref.md'), 'Reference.');
  const { run, calls } = fakeRun();
  const lines: string[] = [];
  let i = 0;
  return { hiveDir, calls, lines, deps: { hiveDir, config: mainConfig(), exec: run, random: () => ((i++ * 7) % 36) / 36, log: (l) => lines.push(l) } };
}

export function task(n: number, stage: string, extra: Partial<Task> = {}): Task {
  return { item: { itemId: `local:${n}`, id: `MON-${n}`, title: `Task ${n}`, body: '', url: '' }, stage, boardColumn: '', auto: n === 1, created: true, ...extra };
}
const activityId = (itemId: string): string => `act-${itemId.replace('local:', '')}`;
/** Each task gets its activity and record (#629: error, stopped and the slug live there, not on the task); `acts[i]` adds to the i-th task's activity. */
export function snap(tasks: Task[], workers: Worker[] = [], acts: Partial<Activity>[] = []): Snapshot {
  const ids = tasks.map((t) => activityId(t.item.itemId));
  return {
    tasks, workers,
    activities: ids.map((id, i): Activity => ({ id, kind: 'task', workspace: 'agent-hive', slug: `hive-mon-${i + 1}-task-${i + 1}`, ...acts[i] })),
    activityRecords: ids.map((id, i) => ({ id, taskIds: [tasks[i].item.itemId], sessions: [] })),
  };
}
export const worker = (n: number, runId: string, extra: Partial<Worker> = {}): Worker => ({ id: `w-${runId}`, runId, activityId: `act-${n}`, status: 'working', ...extra });

/** A clock that moves only when slept on. */
export function clock(start: Date): { now(): Date; sleep(ms: number): Promise<void>; slept: number[] } {
  let at = start.getTime();
  const slept: number[] = [];
  return { now: () => new Date(at), sleep: async (ms) => { slept.push(ms); at += ms; }, slept };
}

/** A task of the run's graph: item id local:<n>, the seed's key and title (#473), blockers by number. */
export const watchTask = (n: number, blockedBy: number[] = [], key = `T${n}`, title = `Task ${n}`): WatchTask =>
  ({ itemId: `local:${n}`, key, title, blockedBy: blockedBy.map((b) => `local:${b}`) });

export const SHA = 'c'.repeat(40);
// spec by prompt (codex, a model), plan by a skill stage, build by a /hive-build prompt after a /hive-pr-review decoy; pr unmatched
export const BENCH_STAGES: Stage[] = [
  { name: 'Spec', from: {}, prompt: '/hive:new-spec {id}', agent: 'codex', model: 'gpt-5' },
  { name: 'Plan', from: {}, action: 'skill', skill: 'new-plan' },
  { name: 'Check', from: {}, prompt: '/hive-pr-review {id}' },
  { name: 'Build', from: {}, prompt: '/hive-build {title}' },
  { name: 'Done', from: {} },
];
export const CLAUDE_ARGS = ['--plugin-dir', '/plugins/extra', '--allowedTools', 'Read Bash(npm run test:coverage *)', '--disallowedTools', 'Bash(gh:*)', '--plugin-dir', '/plugins/two'];

/** A parsed config around one workspace `bench` at `repo`; its stages and agent args are replaced after the parse (the routes only read them). */
export function benchConfig(repo: string): Config {
  const parsed = parseConfig(combConfig({ stages: [{ name: 'Todo', from: {} }], workspaces: [{ name: 'bench', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', setup: 'RUN pnpm install' }] }));
  return { ...parsed, defaultAgent: 'claude', agentArgs: { ...parsed.agentArgs, claude: CLAUDE_ARGS }, comb: { ...parsed.comb, stages: BENCH_STAGES } };
}

export const benchExperiment = (patch: Partial<Experiment> = {}): Experiment =>
  experiment({ workspace: 'bench', seed: { ...experiment().seed, workspace: 'bench', commit: SHA }, ...patch });

export const PR_ROOT = 'b'.repeat(40);
export const PR_URL = 'https://github.com/owner/repo/pull/7';

// The git and gh answers of a benchmark PR's sequence (#477): no branch on origin, three commits after the orphan root, a clean checkout on
// main, gh answering the PR's URL. An override whose key starts a call's line answers that call instead; every other call answers ''.
export function prAnswers(overrides: Record<string, string | Error> = {}): (call: Call) => string | Error {
  const defaults: [string, string][] = [
    ['git rev-list --max-parents=0', `${PR_ROOT}\n`], ['git rev-list --count', '3\n'], ['git rev-parse --short', 'a42b2fc\n'],
    ['git symbolic-ref --short -q HEAD', 'main\n'], ['gh pr create', `${PR_URL}\n`],
  ];
  return (call) => {
    const text = line(call);
    const hit = Object.entries(overrides).find(([prefix]) => text.startsWith(prefix)) ?? defaults.find(([prefix]) => text.startsWith(prefix));
    return hit === undefined ? '' : hit[1];
  };
}
