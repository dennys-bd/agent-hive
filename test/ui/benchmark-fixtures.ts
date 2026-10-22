import { vi } from 'vitest';
import type { ArmSetup, BenchRound, BenchStagePick, BenchTask, Experiment } from '../../src/types';
import { arm, experiment } from '../benchmark/fixtures';
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
