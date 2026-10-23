import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useBenchmark } from '@/components/benchmark/benchmark-dock';
import { ExecutionTab } from '@/components/benchmark/execution/ExecutionTab';
import { TABS } from '@/components/benchmark/tabs';
import { setLanguage } from '@/i18n';
import { goToRunHive, runHiveUrl } from '@/lib/benchmark-run-api';
import type { BenchRun, Experiment } from '../../src/types';
import { NOW, SCREEN } from './benchmark-execution-fixtures';
import { json } from './plugins-fixtures';

// jsdom's location cannot be spied on: the navigation is mocked, its URL tested through runHiveUrl
vi.mock('@/lib/benchmark-run-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/benchmark-run-api')>()), goToRunHive: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// Through TABS, so the execution entry's wiring is what renders
function Tab({ experiment = SCREEN }: { experiment?: Experiment }) {
  const benchmark = useBenchmark([experiment]);
  return <>{TABS.find((tab) => tab.id === 'execution')?.render?.(experiment, benchmark, { select: benchmark.select })}</>;
}
function WithResult({ result }: { result(experiment: Experiment, token: string): ReactNode }) {
  const benchmark = useBenchmark([SCREEN]);
  return <ExecutionTab experiment={SCREEN} benchmark={benchmark} result={result} />;
}
const band = (n: number): HTMLElement => screen.getByRole('region', { name: `rodada ${n}` });
const card = (n: number, letter: string): HTMLElement => within(band(n)).getByRole('article', { name: `braço ${letter}` });
const segments = (el: HTMLElement): (string | null)[] => [...el.querySelectorAll('[data-segment]')].map((s) => s.getAttribute('data-segment'));

beforeEach(() => {
  setLanguage('pt');
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(goToRunHive).mockClear();
  vi.mocked(toast.error).mockClear();
});

test("the screen's three rounds: the top line, the bands newest first, each card's chip, bar, counts and action (#465)", () => {
  render(<Tab />);
  const top = screen.getByText('os workers veem só o token; o braço aparece aqui e no relatório').parentElement as HTMLElement;
  expect(top).toHaveTextContent('rodada 2 de 3');
  expect(top).toHaveTextContent('próxima rodada até 07:00');
  expect(top).toHaveTextContent('em execução há 3h12');
  expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['rodada 2', 'rodada 1', 'rodada 3']);
  expect(within(band(2)).getByText('começou 03:58')).toBeInTheDocument();
  expect(card(2, 'A')).toHaveTextContent('c81e04executando5/8 entregues1,9M tokens3h12abrir');
  expect(within(card(2, 'A')).getByText('executando')).toHaveClass('text-working');
  expect(within(card(2, 'B')).getByText('aguardando aprovação')).toHaveClass('text-waiting');
  expect(segments(card(2, 'A'))).toEqual(['done', 'done', 'done', 'done', 'done', 'waiting', 'waiting', 'open']);
  expect(within(band(1)).getByText('22:01 → 03:57 · avaliada')).toBeInTheDocument();
  expect(card(1, 'C')).toHaveTextContent('e5c911timeout6/8 entregues2,9M tokens6h00resultado');
  expect(within(card(1, 'C')).getByText('timeout')).toHaveClass('text-destructive');
  expect(within(band(3)).getByText('na fila · começa quando a 2 termina, se antes de 07:00')).toBeInTheDocument();
  expect(card(3, 'D')).toHaveTextContent('—na fila0/3 entregues');
  expect(within(card(3, 'D')).queryByRole('button')).toBeNull();
});

test('while the experiment sleeps, the runs it slept read dormindo with the sleeping chip\'s look (#468)', () => {
  const sleep = (r: BenchRun): BenchRun => (r.status === 'running' || r.status === 'waiting' ? { ...r, status: 'sleeping' } : r);
  const asleep: Experiment = { ...SCREEN, status: 'sleeping', rounds: SCREEN.rounds.map((r) => ({ ...r, runs: r.runs.map(sleep) })) };
  render(<Tab experiment={asleep} />);
  for (const letter of ['A', 'B']) expect(within(card(2, letter)).getByText('dormindo')).toHaveClass('text-muted-foreground');
  expect(within(card(1, 'C')).getByText('timeout')).toBeInTheDocument();
});

test("abrir posts /open and sends the window to the answered port; a refusal is a toast and the window stays (#465)", async () => {
  const user = userEvent.setup();
  const calls: string[] = [];
  let status = 200;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { calls.push(path); return status === 200 ? json({ port: 47123 }) : json({ error: 'unreachable' }, status); }));
  render(<Tab />);
  await user.click(within(card(2, 'B')).getByRole('button', { name: 'abrir' }));
  await waitFor(() => expect(goToRunHive).toHaveBeenCalledWith(47123));
  expect(calls).toEqual([`/benchmark/experiments/${SCREEN.id}/runs/9f2a6daa/open`]);
  expect(runHiveUrl(47123, { protocol: 'http:', hostname: '127.0.0.1' })).toBe('http://127.0.0.1:47123/');
  status = 409;
  await user.click(within(card(2, 'A')).getByRole('button', { name: 'abrir' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('não foi possível abrir o Hive do run'));
  expect(goToRunHive).toHaveBeenCalledTimes(1);
});

test("resultado opens the run's result (#466) under the back line; back returns to the rounds; a filled slot gets the token (#465)", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Tab />);
  await user.click(within(card(1, 'A')).getByRole('button', { name: 'resultado' }));
  expect(screen.getByRole('region', { name: 'resultado do run' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'execução' }));
  expect(screen.getAllByRole('region')).toHaveLength(3);
  unmount();
  render(<WithResult result={(_experiment, token) => <p>{`resultado de ${token}`}</p>} />);
  await user.click(within(card(1, 'B')).getByRole('button', { name: 'resultado' }));
  expect(screen.getByText('resultado de 7d03b201')).toBeInTheDocument();
});
