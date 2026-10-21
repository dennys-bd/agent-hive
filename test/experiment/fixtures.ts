import { writeFile } from 'node:fs/promises';
import type { Cookie, Launch } from '../../scripts/experiment/browser.js';
import type { Seed, SeedTask, StagesSeed } from '../../scripts/experiment/seed.js';

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
    signal: 'green', maxConcurrent: 0, workers: [], terminals: [], stages: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
    sourceOrder: [], localCount: 1, localSessions: {}, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
    deleteActivity: { session: false, transcripts: false, nonAutoTasks: false }, shutdownIdleMinutes: 30, approvalMinutes: 10,
    tasks: [{ item: { itemId: 'local:1', id: 'MON-1', title: 'Sample', body: '', url: '' }, stage: 'Build', boardColumn: '', auto: false, created: true, workspace: 'agent-hive' }],
    activities: [{ id: 'act-1', kind: 'task', workspace: 'agent-hive', worktree: '{worktree}' }],
    activityRecords: [{ id: 'act-1', taskIds: ['local:1'], sessions: [] }],
  },
};

export { type Call, fakeChild, fakeRun, line } from '../benchmark/fixtures.js';

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
