import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { primaryFor } from '@/components/benchmark/execution/RunControls';
import { TABS, type TabId } from '@/components/benchmark/tabs';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { experiment, run } from '../benchmark/fixtures';
import { SCREEN } from './benchmark-execution-fixtures';
import { json } from './plugins-fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const DRAFT = experiment({ id: 'draft-1', name: 'skills: comandos × plugin', arms: SCREEN.arms, pace: { ...SCREEN.pace, workersPerArm: 3, cap: { tokens: 4_000_000, planPercent: 40 } } });
const COMPLETE = experiment({ id: 'done-1', status: 'done', pace: { ...experiment().pace, pairs: 1 }, rounds: [{ n: 1, runs: [run('aaaa1', { armId: 'a1', status: 'done' }), run('bbbb1', { armId: 'a2', status: 'done' })] }] });
const OWING: Experiment = { ...COMPLETE, id: 'done-2', pace: { ...COMPLETE.pace, pairs: 2 } };
const SLEEPING: Experiment = { ...SCREEN, status: 'sleeping' };

interface Call { path: string; body?: unknown }
let answer: () => Response;
function stubControls(): Call[] {
  const calls: Call[] = [];
  answer = () => json({ ok: true }, 202);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    return answer();
  }));
  return calls;
}
const Controls = ({ tab, of }: { tab: TabId; of: Experiment }) => <>{TABS.find((entry) => entry.id === tab)?.primary?.(of)}</>;
// Every tab's primary, through TABS, so the entries' wiring is what is checked
function labels(of: Experiment): string[][] {
  return TABS.map((tab) => {
    const { unmount } = render(<Controls tab={tab.id} of={of} />);
    const names = screen.queryAllByRole('button').map((b) => b.textContent ?? '');
    unmount();
    return names;
  });
}
const path = (id: string, rest: string): string => `/benchmark/experiments/${id}/${rest}`;

beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(toast.error).mockClear(); });

test('the primary per tab and status, braços · config · comparar · execução · relatório: no dead button, none while sleeping (#465)', () => {
  expect(labels(DRAFT)).toEqual([['executar'], [], ['executar'], [], []]);
  expect(labels(SCREEN)).toEqual([[], [], [], ['parar após a rodada'], ['executar mais rodadas']]);
  expect(labels(COMPLETE)).toEqual([[], [], [], [], ['executar mais rodadas']]);
  expect(labels(OWING)).toEqual([['executar'], [], ['executar'], [], ['executar mais rodadas']]);
  expect(labels(SLEEPING)).toEqual([[], [], [], [], []]);
  expect(primaryFor('config', DRAFT)).toBeNull();
});

test('executar opens Executar experimento with the wording from the experiment; confirming posts /run and closes (#465)', async () => {
  const user = userEvent.setup();
  const calls = stubControls();
  render(<Controls tab="arms" of={DRAFT} />);
  await user.click(screen.getByRole('button', { name: 'executar' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Executar experimento' });
  expect(dialog).toHaveTextContent('skills: comandos × plugin · 4 braços · 3 pares');
  expect(dialog).toHaveTextContent('executa 3 pares, um run de cada braço por par, até 3 workers por braço. nenhum par novo começa depois de 07:00 nem acima de 4M tokens ou 40% do plano.');
  expect(calls).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'executar' }));
  await waitFor(() => expect(calls).toEqual([{ path: path('draft-1', 'run') }]));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
});

test('a refused /run keeps the dialog with its line: a 422 blindness names where, a 409 live its own, anything else Erro inesperado (#465)', async () => {
  const user = userEvent.setup();
  stubControls();
  answer = () => json({ error: 'blindness', message: 'blindness: "benchmark" in plugins/superpowers/skills/plan.md' }, 422);
  render(<Controls tab="compare" of={DRAFT} />);
  await user.click(screen.getByRole('button', { name: 'executar' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Executar experimento' });
  const confirm = (): Promise<void> => user.click(within(dialog).getByRole('button', { name: 'executar' }));
  await confirm();
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('uma palavra proibida chega aos workers em plugins/superpowers/skills/plan.md');
  answer = () => json({ error: 'live', message: 'the experiment is running in this Hive' }, 409);
  await confirm();
  await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('o experimento já está executando neste Hive'));
  answer = () => json({ error: 'constructor' }, 500);
  await confirm();
  await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Erro inesperado'));
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
});

test('parar após a rodada posts /stop-after-round and, once set, stays disabled as para após esta rodada; a refusal is a toast (#465)', async () => {
  const user = userEvent.setup();
  const calls = stubControls();
  answer = () => json({ ok: true });
  const { rerender } = render(<Controls tab="execution" of={SCREEN} />);
  await user.click(screen.getByRole('button', { name: 'parar após a rodada' }));
  await waitFor(() => expect(calls).toEqual([{ path: path(SCREEN.id, 'stop-after-round') }]));
  rerender(<Controls tab="execution" of={{ ...SCREEN, stopAfterRound: true }} />);
  expect(screen.getByRole('button', { name: 'para após esta rodada' })).toBeDisabled();
  answer = () => json({ error: 'status', message: 'stop-after-round is refused while the experiment is done' }, 409);
  rerender(<Controls tab="execution" of={SCREEN} />);
  await user.click(screen.getByRole('button', { name: 'parar após a rodada' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('o estado do experimento não permite mais isso'));
});

test('executar mais rodadas asks pares (default 1, the primary off below 1) and posts /more-rounds with the number asked (#465)', async () => {
  const user = userEvent.setup();
  const calls = stubControls();
  answer = () => json({ ok: true });
  render(<Controls tab="report" of={SCREEN} />);
  await user.click(screen.getByRole('button', { name: 'executar mais rodadas' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Executar mais rodadas' });
  expect(dialog).toHaveTextContent(SCREEN.name);
  expect(dialog).toHaveTextContent('executa 1 par a mais, um run de cada braço por par.');
  const field = within(dialog).getByLabelText('pares');
  await user.clear(field);
  await user.type(field, '0');
  expect(within(dialog).getByRole('button', { name: 'executar' })).toBeDisabled();
  await user.clear(field);
  await user.type(field, '2');
  expect(dialog).toHaveTextContent('executa 2 pares a mais, um run de cada braço por par.');
  await user.click(within(dialog).getByRole('button', { name: 'executar' }));
  await waitFor(() => expect(calls).toEqual([{ path: path(SCREEN.id, 'more-rounds'), body: { pairs: 2 } }]));
});
