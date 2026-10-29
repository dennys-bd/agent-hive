import { vi } from 'vitest';
import type { AgentId, ArmSetup, BenchFlow, BenchMetrics, BenchRound, BenchRun, BenchStagePick, BenchTask, Experiment } from '../../src/types';
import { arm, experiment, run, SETUP } from '../benchmark/fixtures';
import { json } from './plugins-fixtures';

// Local times (no Z): the sub lines' HH:MM and d mmm read the same on any machine
const round = (n: number, startedAt: string, endedAt?: string): BenchRound => ({ n, startedAt, ...(endedAt === undefined ? {} : { endedAt }), runs: [] });
const arms = (count: number) => ['A', 'B', 'C'].slice(0, count).map((letter, i) => arm(`a${i + 1}`, letter));
const SEED = experiment().seed;

/** benchmark.hv.html's sidebar: one running by mcp, two drafts (yours, mcp's), two done, two archived. */
export const RUNNING = experiment({
  id: 'skills-20261001-2130', name: 'skills: comandos × plugin', status: 'running', createdAt: '2026-10-01T21:30:00', arms: arms(3),
  createdBy: { kind: 'mcp', agent: 'claude', model: 'opus' }, seed: { ...SEED, commit: `a42b2fc${'0'.repeat(33)}` },
  rounds: [round(1, '2026-10-01T22:00:00', '2026-10-02T01:00:00'), round(2, '2026-10-02T01:05:00')],
});
export const DRAFT = experiment({ id: 'opus-plan', name: 'opus no plan', createdAt: '2026-10-22T10:12:00' });
export const MCP_DRAFT = experiment({ id: 'rules', name: 'regras sem dontAsk', createdAt: '2026-10-22T09:40:00', createdBy: { kind: 'mcp', agent: 'claude' } });
export const DONE = experiment({
  id: 'superpowers', name: 'superpowers vs nada', status: 'done', createdAt: '2026-09-28T09:00:00',
  rounds: [round(1, '2026-09-28T10:00:00', '2026-09-28T12:00:00'), round(2, '2026-09-29T10:00:00', '2026-09-29T12:00:00'), round(3, '2026-09-30T10:00:00', '2026-09-30T18:00:00')],
});
export const DONE_OLD = experiment({
  id: 'workers', name: 'workers 3 × 5', status: 'done', createdAt: '2026-09-26T09:00:00',
  rounds: [round(1, '2026-09-26T10:00:00', '2026-09-26T12:00:00'), round(2, '2026-09-27T10:00:00', '2026-09-27T12:00:00')],
});
export const ARCHIVED = experiment({ id: 'old-1', name: 'velho opus', status: 'done', archived: true, createdAt: '2026-08-01T09:00:00' });
export const ARCHIVED_DRAFT = experiment({ id: 'old-2', name: 'rascunho velho', archived: true, createdAt: '2026-08-02T09:00:00' });
export const EXPERIMENTS: Experiment[] = [DONE_OLD, ARCHIVED, DRAFT, RUNNING, MCP_DRAFT, ARCHIVED_DRAFT, DONE];
export const WORKSPACES = ['agent-hive', 'hive-site'];

export interface Call { method: string; path: string; body?: unknown }
/** fetch for the experiments' routes: POST answers a new draft `new-1` (201), PATCH `{ id }`, DELETE 204, GET …/items answers `items`; with `status` every call is refused. */
export function stubBenchmarkFetch(status?: number, items: unknown[] = []): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    if (status !== undefined) return json({ error: 'refused', message: 'the raw words' }, status);
    if (method === 'GET' && path.endsWith('/items')) return json({ items });
    if (method === 'POST') return json(experiment({ id: 'new-1', name: 'novo' }), 201);
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return json({ id: path.split('/').at(-1) });
  }));
  return calls;
}

const stagePick = (skill: string, model = 'sonnet'): BenchStagePick => ({ agent: 'claude', model, skill, prompt: `${skill} {id}` });
const benchTask = (n: number, blockedBy: string[] = []): BenchTask => ({ key: `T${n}`, title: `Task ${n}`, body: '', blockedBy });
/** benchmark.hv.html's #dlg-settings flow (#536): Spec → Plan → Build → Checks (failed back to Build 3x) → Avaliação (rejected back to Build 2x) → PR → end. */
export const ARMS_FLOW: BenchFlow = {
  copiedAt: '2026-10-01T21:30:00',
  stages: [
    { name: 'Spec', prompt: '/hive:new-spec escreva a spec da tarefa a partir da referência do seed', agent: 'claude', model: 'sonnet' },
    { name: 'Plan', prompt: '/hive:new-plan transforme a spec num plano fatiado', agent: 'claude', model: 'sonnet' },
    { name: 'Build', prompt: '/hive:new-build implemente o plano, teste primeiro', agent: 'claude', model: 'sonnet' },
    { name: 'Checks', action: 'commands', commands: ['test', 'lint', 'tsc'], stopOnFailure: true, onMissing: 'fail' },
    {
      name: 'Avaliação', action: 'evaluate', reviewers: [{ agent: 'claude', specializedAgent: 'hive:code-reviewer' }, { agent: 'claude', specializedAgent: 'hive:tdd' }],
      judge: { agent: 'claude', model: 'fable' }, threshold: 7, rubric: 'correção',
    },
    { name: 'PR', prompt: 'abra o PR com o resumo da entrega', agent: 'claude', model: 'haiku' },
  ],
  transitions: [
    { from: 'Spec', to: 'Plan', when: 'done' }, { from: 'Plan', to: 'Build', when: 'done' }, { from: 'Build', to: 'Checks', when: 'done' },
    { from: 'Checks', to: 'Avaliação', when: 'verdict', verdict: 'passed' }, { from: 'Checks', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 3 },
    { from: 'Avaliação', to: 'PR', when: 'verdict', verdict: 'passed' }, { from: 'Avaliação', to: 'Build', when: 'verdict', verdict: 'failed', maxTries: 2 },
    { from: 'PR', to: 'end', when: 'done' },
  ],
  commands: [{ name: 'test', line: 'pnpm test' }, { name: 'lint', line: 'pnpm lint' }, { name: 'tsc', line: 'tsc --noEmit' }],
  dropped: [],
};

/** benchmark.hv.html's #s-visao: the base and arms A (skills and plugins), B (none), C (build), D (own tasks). */
export const ARMS_BASE: ArmSetup = {
  stages: { spec: stagePick('/hive:new-spec'), plan: stagePick('/hive:new-plan'), build: stagePick('/hive:new-build'), pr: stagePick('/hive:new-pr', 'haiku') },
  plugins: [], rules: { allow: Array.from({ length: 14 }, (_, i) => `Tool${i}`), deny: ['gh', 'push *'] },
  tasks: [benchTask(1), benchTask(2, ['T1']), benchTask(3, ['T1']), benchTask(4, ['T2']), benchTask(5), benchTask(6), benchTask(7), benchTask(8)],
  items: {}, worktree: { setup: '', teardown: '' },
};
export const ARMS = experiment({
  id: 'exp-arms', name: 'skills: comandos × plugin', base: ARMS_BASE, tasksHash: '91d4'.padEnd(64, '0'),
  arms: [
    { id: 'a1', letter: 'A', name: 'comandos do repo', overrides: { stages: { spec: { skill: '/hive-spec' }, plan: { skill: '/hive-plan' }, build: { skill: '/hive-build' } }, plugins: ['/plugins/superpowers', '/plugins/ecc'] } },
    { id: 'a2', letter: 'B', name: 'skills do plugin', overrides: {} },
    { id: 'a3', letter: 'C', name: 'plugin + codex', overrides: { stages: { build: { agent: 'codex', model: 'gpt-5' } } } },
    { id: 'a4', letter: 'D', name: 'tarefas juntas', overrides: { tasks: [benchTask(1), benchTask(2), benchTask(3)] } },
  ],
});
export const ARMS_PATH = '/benchmark/experiments/exp-arms';

const pickOf = (skill: string, agent: AgentId = 'claude', model?: string): BenchStagePick =>
  ({ agent, ...(model === undefined ? {} : { model }), skill, prompt: `${skill} {title}\n\n{body}` });
const compareTask = (n: number, blockedBy: string[] = []): BenchTask => ({ key: `T${n}`, title: `task ${n}`, body: '', blockedBy });
const BASE_STAGES = { spec: pickOf('/hive:new-spec'), plan: pickOf('/hive:new-plan'), build: pickOf('/hive:new-build', 'claude', 'sonnet'), pr: pickOf('/hive:new-pr') };

/** benchmark.hv.html's #s-comparar: A overrides three prompts and the plugins, B nothing, C build's agent and model, D its own tasks. An arm
 *  sets only the stage fields it changes, as the arms tab writes them (#462). */
export const COMPARE = experiment({
  id: 'compare', name: 'skills: comandos × plugin', tasksHash: `91d4${'0'.repeat(60)}`,
  base: { ...SETUP, stages: BASE_STAGES, tasks: [compareTask(1), compareTask(2, ['T1']), compareTask(3, ['T1', 'T2']), ...[4, 5, 6, 7, 8].map((n) => compareTask(n))] },
  arms: [
    { id: 'a1', letter: 'A', name: 'comandos do repo', overrides: {
      stages: { spec: { skill: '/hive-spec' }, plan: { skill: '/hive-plan' }, build: { skill: '/hive-build' } }, plugins: ['superpowers', 'ecc'],
    } },
    { id: 'a2', letter: 'B', name: 'skills do plugin', overrides: {} },
    { id: 'a3', letter: 'C', name: 'plugin + codex', overrides: { stages: { build: { agent: 'codex', model: 'gpt-5' } } } },
    { id: 'a4', letter: 'D', name: 'tarefas juntas', overrides: { tasks: [compareTask(1), compareTask(2), compareTask(3)] } },
  ],
});

export interface Download { href: string; download: string }
/** jsdom has no blob URL and does not download (#467): createObjectURL answers blob:report, and an anchor's click is recorded, not followed.
 *  Pair with vi.restoreAllMocks() in afterEach. */
export function stubDownload(): Download[] {
  const clicks: Download[] = [];
  URL.createObjectURL = vi.fn(() => 'blob:report');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
  return clicks;
}

// One task per entry, with that many stages: a task with none has not started
export const metricsOf = (...stages: number[]): BenchMetrics => ({
  tokens: 0, costUsd: 0, ms: 0, waitingMs: 0, restarts: { count: 0, where: [] }, diff: { files: 0, insertions: 0, deletions: 0 }, tests: { green: 0, total: 0 },
  tasks: stages.map((count, i) => ({ key: `T${i + 1}`, title: `task ${i + 1}`, tokens: 0, ms: 0, waitingMs: 0, restarts: 0, stages: Array.from({ length: count }, (_, s) => ({ stage: `s${s}`, ms: 1 })) })),
});

/** benchmark.hv.html's dlg-sleep: RUNNING in round 2 with A and B running and C waiting (7 tasks in progress: 2 + 3 + 2), round 1's run done. */
export const SLEEPY: Experiment = {
  ...RUNNING,
  rounds: [
    { n: 1, startedAt: '2026-10-01T22:00:00', endedAt: '2026-10-02T01:00:00', runs: [run('d0e1f2a3', { armId: 'a1', status: 'done', delivered: 8, total: 8, metrics: metricsOf(1, 1, 1, 1, 1, 1, 1, 1) })] },
    { n: 2, startedAt: '2026-10-02T01:05:00', runs: [
      run('c81e04aa', { armId: 'a1', round: 2, status: 'running', delivered: 5, total: 8, metrics: metricsOf(1, 2, 1, 1, 3, 1, 1, 0) }),
      run('9f2a6dbb', { armId: 'a2', round: 2, status: 'running', delivered: 4, total: 8, metrics: metricsOf(1, 1, 1, 1, 1, 1, 1, 0) }),
      run('e30b71cc', { armId: 'a3', round: 2, status: 'waiting', delivered: 3, total: 8, metrics: metricsOf(1, 1, 1, 1, 1, 0, 0, 0) }),
    ] },
  ],
};

const asleep = (r: BenchRun): BenchRun => (r.status === 'running' || r.status === 'waiting' ? { ...r, status: 'sleeping' } : r);
/** dlg-wake: SLEEPY asleep since 04:40 (local) with the screen's reason; pace.until is the fixture's 07:00. */
export const ASLEEP: Experiment = {
  ...SLEEPY, status: 'sleeping',
  rounds: SLEEPY.rounds.map((r): BenchRound => ({ ...r, runs: r.runs.map(asleep) })),
  sleeps: [{ round: 2, at: '2026-10-02T04:40:00', reason: 'preciso da máquina para outra coisa' }],
};
