import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RunResult } from '@/components/benchmark/result/RunResult';
import { setLanguage } from '@/i18n';
import { EVALUATION, PREVIEW, RESULT_EXP, RUN_B1, RUN_B2 } from './benchmark-result-fixtures';
import { json } from './plugins-fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const RUN_PATH = '/benchmark/experiments/exp-1/runs/7d03b2a1';
let evaluateAnswer: () => Response | Promise<Response> = () => json({ tokens: [RUN_B1.token] }, 202);
const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  if (url.endsWith('/open')) return json({ port: 47999 });
  if (url.endsWith('/evaluate')) return evaluateAnswer();
  if (init?.method === 'PATCH') return new Response(null, { status: 204 });
  if (url.endsWith('/pr')) return json(PREVIEW);
  return json({ error: 'unknown' }, 404);
});
// The writes the screen sent: method, path and body
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== undefined)
  .map(([url, init]) => ({ method: init?.method, url, ...(init?.body === undefined || init.body === null ? {} : { body: JSON.parse(String(init.body)) as unknown }) }));
const show = (run = RUN_B1) => render(<RunResult experiment={RESULT_EXP} run={run} onBack={vi.fn()} />);

beforeEach(() => {
  setLanguage('pt');
  evaluateAnswer = () => json({ tokens: [RUN_B1.token] }, 202);
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(toast.error).mockClear(); });

test('every block of #s-resultado renders the run B · par 1 with the screen\'s values, each print from the screenshot route (#466)', () => {
  show();
  const page = within(screen.getByRole('region', { name: 'resultado do run' }));
  for (const text of ['skills do plugin · par 1', '7d03b2', 'concluída · 22:01 → 02:56', 'com intervenção · 1']) expect(page.getByText(text)).toBeInTheDocument();
  const strip = within(screen.getByLabelText('métricas'));
  expect(strip.getAllByRole('definition').map((d) => d.textContent)).toEqual(['2.6M', '$31', '4h55', '18m', '1', '+3.480 −540', '3/3', '17/18']);
  for (const text of ['mediana B 2.5M', 'mediana B $33', 'sem tempo dormindo', 'em 1 tarefa', 'build · HIV-415', '33 arquivos', 'verdes', 'S4 falhou 1×']) expect(strip.getByText(text)).toBeInTheDocument();
  const judge = within(screen.getByRole('region', { name: 'juiz' }));
  expect(judge.getByText('claude · fable · rubrica f00baa')).toBeInTheDocument();
  expect([judge.getAllByText('4/5').length, judge.getAllByText('5/5').length]).toEqual([2, 1]);
  expect(judge.getByText('duplicou o formatador de datas em 2 lugares.')).toBeInTheDocument();
  const scenarios = within(screen.getByRole('region', { name: 'cenários' }));
  expect(scenarios.getByText('6 cenários × 3 execuções · 17/18')).toBeInTheDocument();
  expect(scenarios.getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual(['S1', 'S2', 'S3', 'S4', 'S5'].map((id) => `${RUN_PATH}/screens/${id}-3.png`));
  expect(scenarios.getByRole('img', { name: 'print · S4' })).toBeInTheDocument();
  expect(scenarios.getByText('sem print')).toBeInTheDocument();
  expect(scenarios.getByText('paginar concluídas')).toBeInTheDocument();
  expect(scenarios.getByText('2/3')).toBeInTheDocument();
  const collectors = within(screen.getByRole('region', { name: 'coletores estáticos' }));
  for (const text of ['3 coletores', 'code-reviewer', '3 achados', 'lint + tipos', '—']) expect(collectors.getByText(text)).toBeInTheDocument();
  expect(collectors.getAllByText('ok')).toHaveLength(2);
  const registry = within(screen.getByRole('region', { name: 'registro' }));
  for (const text of ['1 intervenção · 0 vezes dormindo', '00:42', 'aprovou em HIV-415', 'git push --force na branch da tarefa · negado pela regra do braço · por você']) {
    expect(registry.getByText(text)).toBeInTheDocument();
  }
  expect(registry.getByRole('switch', { name: 'entra na mediana do relatório' })).toBeChecked();
  const tasks = within(screen.getByRole('region', { name: 'tarefas' }));
  expect(tasks.getByText('8/8 entregues')).toBeInTheDocument();
  expect(tasks.getAllByText(/^HIV-41\d$/)).toHaveLength(8);
  expect(tasks.getByText('1h12')).toBeInTheDocument();
});

test('a run with no evaluation and no metrics shows one muted line per card and renders the rest (#466)', () => {
  show({ ...RUN_B1, evaluation: undefined, metrics: undefined });
  expect(screen.getAllByText('ainda não avaliado')).toHaveLength(3); // juiz, cenários, coletores
  expect(screen.getAllByText('sem métricas')).toHaveLength(2); // the strip, tarefas
  expect(screen.getByRole('region', { name: 'registro' })).toBeInTheDocument();
});

test('julgar de novo posts the run\'s evaluate route and is disabled while it flies; a rerender with new scores shows them (#466)', async () => {
  const user = userEvent.setup();
  let release = (): void => undefined;
  evaluateAnswer = () => new Promise((resolve) => { release = () => resolve(json({ tokens: [RUN_B1.token] }, 202)); });
  const { rerender } = show();
  await user.click(screen.getByRole('button', { name: 'julgar de novo' }));
  expect(screen.getByRole('button', { name: 'julgar de novo' })).toBeDisabled();
  expect(writes()).toEqual([{ method: 'POST', url: `${RUN_PATH}/evaluate` }]);
  release();
  await waitFor(() => expect(screen.getByRole('button', { name: 'julgar de novo' })).toBeEnabled());
  const judge = { ...EVALUATION.judge, scores: [{ dimension: 'fidelidade', score: 2, evidence: 'o layout mudou.' }] };
  rerender(<RunResult experiment={RESULT_EXP} run={{ ...RUN_B1, evaluation: { ...EVALUATION, judge } }} onBack={vi.fn()} />);
  expect(screen.getByText('o layout mudou.')).toBeInTheDocument();
  expect(screen.getByText('2/5')).toBeInTheDocument();
});

test('a refused judge is the shell\'s toast, never the server\'s words (#466)', async () => {
  evaluateAnswer = () => json({ error: 'the run is being evaluated' }, 409);
  show();
  await userEvent.setup().click(screen.getByRole('button', { name: 'julgar de novo' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('o experimento está executando ou dormindo'));
});

test('abrir hive do run posts /open and moves the window to the answered port on the same host (#466)', async () => {
  const user = userEvent.setup();
  show();
  const assign = vi.fn();
  vi.stubGlobal('location', { protocol: 'http:', hostname: '127.0.0.1', assign });
  await user.click(screen.getByRole('button', { name: 'abrir hive do run' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:47999/'));
  expect(writes()).toEqual([{ method: 'POST', url: `${RUN_PATH}/open` }]);
});

test('abrir PR com este run opens the PR dialog with this run picked (#466)', async () => {
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole('button', { name: 'abrir PR com este run' }));
  expect(await screen.findByRole('alertdialog', { name: 'Abrir PR com o braço B' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(`${RUN_PATH}/pr`);
});

test('the median toggle patches the run with { inMedian: false }; a run with no interventions has no toggle (#466)', async () => {
  const user = userEvent.setup();
  const { unmount } = show();
  await user.click(screen.getByRole('switch', { name: 'entra na mediana do relatório' }));
  await waitFor(() => expect(writes()).toEqual([{ method: 'PATCH', url: RUN_PATH, body: { inMedian: false } }]));
  unmount();
  show(RUN_B2);
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(screen.getByText('0 intervenções · 0 vezes dormindo')).toBeInTheDocument();
});
