import { writeFile } from 'node:fs/promises';
import type { Cookie, Launch } from '../../scripts/experiment/browser.js';
import type { ChildLike } from '../../scripts/experiment/daemon-runner.js';
import type { Run } from '../../scripts/experiment/exec.js';
import type { Seed, SeedTask, StagesSeed } from '../../scripts/experiment/seed.js';
import type { Snapshot } from '../../scripts/experiment/watcher.js';
import type { Activity, Task, Worker } from '../../src/types.js';

export const BRANCH = 'feat/monitor-view-abc123';
export const WORKSPACE = '/repo/top';
export const TOKEN = 'abc123';
export const PREFIX = 'MABC123';
export const PATHS = { state: '/state', home: '/state/homes/abc123' };

export const STAGES: StagesSeed = {
  claudeArgs: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(git:*) Read Edit Write mcp__hive__*'],
  stages: [
    { name: 'Spec', role: 'spec', from: {}, maxWorkers: 3, prompt: '/{command} {title}\n\n{body}\n\nThe base branch is `{runBranch}`. Commit the spec.' },
    { name: 'Plan', role: 'plan', session: 'continue', from: {}, maxWorkers: 3, prompt: '/{command} for the spec. The base branch is `{runBranch}`.' },
    { name: 'Build', role: 'build', session: 'continue', from: {}, maxWorkers: 2, prompt: '/{command} for the plan. Diff against `origin/{runBranch}`.' },
    { name: 'Merge', session: 'continue', from: {}, maxWorkers: 1, prompt: 'Merge into `{runBranch}` with --no-ff, then hive_done {"merged": true, "testsGreen": true}.' },
    { name: 'Done', from: {} },
  ],
};

export const TASKS: SeedTask[] = [
  { key: 'grid', title: 'Monitor View 1', delivery: 1, blockedBy: [], body: 'Preamble.\n\nPrimeira (4a). Faz a.' },
  { key: 'pins', title: 'Monitor View 2', delivery: 2, blockedBy: ['grid'], body: 'Preamble.\n\nSegunda. Faz b.' },
  { key: 'health', title: 'Monitor View 8', delivery: 8, blockedBy: [], body: 'Preamble.\n\nOitava. Faz h.' },
];

export const SEED: Seed = {
  handoff: '# Handoff: monitor\n', tasks: TASKS, stages: STAGES,
  scenarios: [
    { id: 'S1', title: 'Open the monitor', text: 'Delivery: 1\nSteps:\n1. Open.\nExpected: shown.' },
    { id: 'S2', title: 'Filter', text: 'Delivery: 2\nSteps:\n1. Pick.\nExpected: fewer.' },
  ],
  artboards: [{ id: '4a', file: '4a-padrao.png', title: 'grid padrão', delivery: 1, live: false }, { id: '4c', file: '4c-comandos.png', title: 'comandos do agente', delivery: 6, live: true }],
  screens: [],
  sampleState: {
    signal: 'green', maxConcurrent: 0, workers: [], terminals: [], stages: [], workspaces: [], sourceWorkspaces: {}, commands: {}, syncs: {},
    sourceOrder: [], localCount: 1, localSessions: {}, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
    deleteActivity: { session: false, transcripts: false, nonAutoTasks: false }, shutdownIdleMinutes: 30, approvalMinutes: 10,
    tasks: [{ item: { itemId: 'local:1', id: 'MON-1', title: 'Sample', body: '', url: '' }, stage: 'Build', boardColumn: '', auto: false, created: true, workspace: 'agent-hive' }],
    activities: [{ id: 'act-1', kind: 'task', workspace: 'agent-hive', worktree: '{worktree}' }],
    activityRecords: [{ id: 'act-1', taskIds: ['local:1'], sessions: [] }],
  },
};

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

export function fakeBrowser(ok = true): { launch: Launch; seen: { gotos: string[]; shots: string[]; cookies: Cookie[]; closed: number } } {
  const seen = { gotos: [] as string[], shots: [] as string[], cookies: [] as Cookie[], closed: 0 };
  const launch: Launch = async () => ({
    newContext: async () => ({
      addCookies: async (cookies: Cookie[]) => { seen.cookies.push(...cookies); },
      newPage: async () => ({
        goto: async (url: string) => { seen.gotos.push(url); return { ok: () => ok }; },
        waitForTimeout: async () => undefined,
        screenshot: async ({ path }: { path: string }) => { seen.shots.push(path); await writeFile(path, 'png'); },
      }),
    }),
    close: async () => { seen.closed += 1; },
  });
  return { launch, seen };
}
