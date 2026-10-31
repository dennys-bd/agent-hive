import { render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import type { BenchMetrics, BenchScenario, Experiment, PlanReadings } from '../../src/types';
import { arm, experiment, ISOLATION, run } from '../benchmark/fixtures';
import type { Call } from './benchmark-fixtures';
import { ConfigTab } from '@/components/benchmark/config/ConfigTab';
import type { TabContext } from '@/components/benchmark/tabs';
import { WorkspaceColorsContext } from '@/lib/workspace-color';
import { json } from './plugins-fixtures';

const metrics = (tokens: number): BenchMetrics => ({
  tokens, costUsd: 0, ms: 0, waitingMs: 0, restarts: { count: 0, where: [] }, diff: { files: 0, insertions: 0, deletions: 0 }, tests: { green: 0, total: 0 }, tasks: [],
});
const SCENARIOS: BenchScenario[] = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `S${n}`, title: `cenário ${n}`, text: `passo ${n}` }));

/** benchmark.hv.html's #s-config: four arms, one ended round (a done run and a running one, 1.5M tokens), the screen's sample values;
 *  C runs bypassPermissions with no deny rule. */
export const CONFIG: Experiment = experiment({
  id: 'skills', name: 'skills: comandos × plugin', status: 'done', workspace: 'agent-hive', seedHash: `7e21b0${'0'.repeat(58)}`,
  arms: ['A', 'B', 'C', 'D'].map((letter, i) => arm(`a${i + 1}`, letter)),
  seed: {
    workspace: 'agent-hive', commit: `4c1e9a2${'0'.repeat(33)}`, reference: ['handoff_plugins', 'spec.md', 'upload:print-1.png'],
    sample: { command: 'pnpm dev', url: 'localhost:5173', files: ['fixtures/bench-seed.sql'] }, scenarios: SCENARIOS,
  },
  pace: { pairs: 3, until: '07:00', runTimeoutMs: 72_000_000, workersPerArm: 3, cap: { tokens: 4_000_000, planPercent: 40 } },
  isolation: {
    ...ISOLATION, network: { all: ['registry.npmjs.org', 'github.com'] },
    permissionMode: { all: 'dontAsk', perArm: { a1: 'dontAsk', a2: 'dontAsk', a3: 'bypassPermissions', a4: 'dontAsk' } },
    allowedTools: { all: ['Read', 'Edit', 'Bash(npm test:*)'] }, deniedTools: { all: [] },
    limits: { all: { turns: 200, ms: 7_200_000 } }, env: { all: { CI: '1', HIVE_BENCH: '1' } },
  },
  blindness: { on: true, forbiddenWords: ['benchmark', 'braço', 'experimento'] },
  evaluation: {
    collectors: [{ agent: 'claude', specializedAgent: 'code-reviewer' }, { agent: 'claude', model: 'sonnet', focus: 'tdd' }],
    dynamic: true, tester: { agent: 'claude', model: 'sonnet' }, scenarioWalks: 2, judge: { agent: 'claude', model: 'opus' }, rubric: 'fidelidade\ncomportamento\n\ncódigo',
  },
  rounds: [{
    n: 1, startedAt: '2026-10-21T10:00:00', endedAt: '2026-10-21T12:00:00',
    runs: [run('tok1', { armId: 'a1', status: 'done', metrics: metrics(1_200_000) }), run('tok2', { armId: 'a2', metrics: metrics(300_000) })],
  }],
});
/** The same config as a draft: no round, so a seed save rehashes instead of forking. */
export const DRAFT_CONFIG: Experiment = { ...CONFIG, id: 'draft-1', status: 'draft', rounds: [] };
/** The Hive's latest rate-limit reading: its highest window is 39.6%, read as 40%. */
export const READINGS: PlanReadings = {
  claude: { at: '2026-10-22T10:00:00Z', windows: { five_hour: { usedPercent: 12.4, resetsAt: '2099-10-22T15:00:00Z' }, seven_day: { usedPercent: 39.6, resetsAt: '2099-10-27T10:00:00Z' } } },
};

export interface Answer { status?: number; body?: unknown }
/** fetch for the config tab: every call but a GET is recorded. An answer keyed `METHOD path` wins; else PATCH answers `{ id }` of its path,
 *  PUT 204, POST 202 `{ tokens: [] }`, GET `{}` (the launch options). */
export function stubConfigFetch(answers: Record<string, Answer> = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ method, path, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    const answer = answers[`${method} ${path}`];
    if (answer !== undefined) return answer.body === undefined ? new Response(null, { status: answer.status ?? 204 }) : json(answer.body, answer.status);
    if (method === 'PATCH') return json({ id: decodeURIComponent(path.split('/').at(-1) ?? '') });
    if (method === 'PUT') return new Response(null, { status: 204 });
    return method === 'POST' ? json({ tokens: [] }, 202) : json({});
  }));
  return calls;
}

const COLORS = { 'agent-hive': '#7c8cff' };
const tab = (e: Experiment, context: TabContext) => <WorkspaceColorsContext.Provider value={COLORS}><ConfigTab experiment={e} context={context} /></WorkspaceColorsContext.Provider>;

/** The config tab of `e` with the dock's select spied on; rerender keeps the tab mounted (same experiment, a new status). */
export function renderConfig(e: Experiment, rateLimits?: PlanReadings) {
  const select = vi.fn<(id: string) => void>();
  const context: TabContext = { select, ...(rateLimits === undefined ? {} : { rateLimits }) };
  const view = render(tab(e, context));
  return { select, rerender: (next: Experiment) => view.rerender(tab(next, context)) };
}
export const region = (name: string): HTMLElement => screen.getByRole('region', { name });
export const rowIn = (section: string, label: string): HTMLElement => within(region(section)).getByRole('group', { name: label });
export const editIn = (section: string): HTMLElement => within(region(section)).getByRole('button', { name: `editar ${section}` });
/** The pills' texts under `el`, in order (an arm's pill reads its letter then its value: `CbypassPermissions`). */
export const pills = (el: HTMLElement): (string | null)[] => [...el.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent);
