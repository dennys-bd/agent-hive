import type { BenchPrPreview } from '../../src/benchmark/pr-pick';
import type { BenchMetrics, BenchRun, BenchRunEvaluation, BenchTaskMetrics, Experiment, ScenarioResult } from '../../src/types';
import { arm, experiment, run } from '../benchmark/fixtures';

const MINUTE = 60_000;
// Local times (no Z): HH:MM reads the same on any machine
export const NOW = Date.parse('2026-10-22T08:00:00');
const TASKS: [string, string, number][] = [
  ['HIV-411', 'busca no fluxo', 31], ['HIV-412', 'filtro por source', 44], ['HIV-413', 'cor do workspace no card', 22],
  ['HIV-414', 'menu da source', 38], ['HIV-415', 'paginação na coluna de concluídas', 72], ['HIV-416', 'atalho para buscar tarefas', 19],
  ['HIV-417', 'agrupar por status', 41], ['HIV-418', 'exportar relatório em markdown', 28],
];
const taskMetrics = ([key, title, minutes]: [string, string, number]): BenchTaskMetrics => ({
  key, title, tokens: 0, ms: minutes * MINUTE, waitingMs: key === 'HIV-415' ? 18 * MINUTE : 0, stages: [], restarts: key === 'HIV-415' ? 1 : 0,
});
export const SCENARIOS = [
  ['S1', 'filtrar por source'], ['S2', 'buscar tarefa'], ['S3', 'agrupar por status'],
  ['S4', 'paginar concluídas'], ['S5', 'menu da source'], ['S6', 'cor do workspace'],
].map(([id, title]) => ({ id, title, text: '' }));
const shots = (id: string): string[] => [1, 2, 3].map((n) => `${id}-${n}.png`);
const scenario = (id: string, passed: number, screenshots = shots(id)): ScenarioResult => ({ id, passed, total: 3, screenshots });

export const METRICS: BenchMetrics = {
  tokens: 2_600_000, costUsd: 31, ms: 295 * MINUTE, waitingMs: 18 * MINUTE, restarts: { count: 1, where: ['build · HIV-415'] },
  diff: { files: 33, insertions: 3480, deletions: 540 }, tests: { green: 3, total: 3 }, tasks: TASKS.map(taskMetrics),
};
const finding = (text: string) => ({ file: 'src/tasks.ts', finding: text });
export const EVALUATION: BenchRunEvaluation = {
  at: '2026-10-21T03:30:00',
  scenarios: [scenario('S1', 3), scenario('S2', 3), scenario('S3', 3), scenario('S4', 2), scenario('S5', 3), scenario('S6', 3, [])],
  collectors: [
    { name: 'code-reviewer', status: 'warn', summary: '1 alto: query sem índice em listTasks. 2 baixos: nomes.', findings: [finding('a'), finding('b'), finding('c')] },
    { name: 'tdd', status: 'ok', summary: 'todas as tarefas com teste antes do código.', findings: [] },
    { name: 'lint + tipos', status: 'ok', summary: '', findings: [] },
  ],
  judge: {
    agent: 'claude', model: 'fable', rubricHash: `f00baa${'0'.repeat(58)}`,
    scores: [
      { dimension: 'fidelidade', score: 4, evidence: 'segue o handoff no layout e na copy.' },
      { dimension: 'comportamento', score: 5, evidence: 'os 6 fluxos funcionam.' },
      { dimension: 'código', score: 4, evidence: 'duplicou o formatador de datas em 2 lugares.' },
    ],
  },
};
export const RUN_B1: BenchRun = run('7d03b2a1', {
  armId: 'a2', round: 1, status: 'done', startedAt: '2026-10-20T22:01:00', endedAt: '2026-10-21T02:56:00', delivered: 8, total: 8,
  metrics: METRICS, evaluation: EVALUATION,
  interventions: [{ at: '2026-10-21T00:42:00', action: 'aprovou em HIV-415', detail: 'git push --force na branch da tarefa · negado pela regra do braço', by: 'user' }],
});
// B's second pair: no intervention (no toggle), and the other half of the arm's medians
export const RUN_B2: BenchRun = run('9c1e44f0', { armId: 'a2', round: 2, status: 'done', delivered: 8, total: 8, metrics: { ...METRICS, tokens: 2_400_000, costUsd: 35 } });
export const RESULT_EXP: Experiment = experiment({
  status: 'done', arms: [arm('a1', 'A'), { ...arm('a2', 'B'), name: 'skills do plugin' }],
  seed: { ...experiment().seed, scenarios: SCENARIOS },
  rounds: [{ n: 1, startedAt: '2026-10-20T22:00:00', runs: [RUN_B1] }, { n: 2, startedAt: '2026-10-21T22:00:00', runs: [RUN_B2] }],
});
export const PREVIEW: BenchPrPreview = {
  token: RUN_B1.token, armId: 'a2', status: 'done', commits: 14, tasks: 8, base: 'origin/main', baseSha: 'a42b2fc', branch: 'feat/skills', title: 'feat: Skills', via: 'worktree',
};
