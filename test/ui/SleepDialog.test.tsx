import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SleepDialog } from '@/components/benchmark/sleep/SleepDialog';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { SLEEPY, stubBenchmarkFetch } from './benchmark-fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(toast.error).mockClear(); });

const PATH = `/benchmark/experiments/${SLEEPY.id}/sleep`;
const show = async (experiment: Experiment = SLEEPY, onClose = vi.fn()) => {
  render(<SleepDialog experiment={experiment} onClose={onClose} />);
  return within(await screen.findByRole('alertdialog', { name: 'Dormir experimento' }));
};

test("the screen's grid from the running runs: a pill per run, the tasks line, a blank reason, quando eu mandar picked, the time note (#468)", async () => {
  const dialog = await show();
  expect(dialog.getAllByText(/^run [ABC] · /).map((pill) => pill.textContent)).toEqual(['run A · c81e04 · 5/8', 'run B · 9f2a6d · 4/8', 'run C · e30b71 · 3/8']);
  expect(dialog.getByText('7 em andamento ficam registradas como dormidas, com o ponto da etapa')).toBeInTheDocument();
  expect(dialog.getByRole('textbox', { name: 'motivo' })).toHaveValue('');
  expect(dialog.getByRole('radio', { name: 'quando eu mandar' })).toBeChecked();
  expect(dialog.queryByLabelText('horário de acordar')).not.toBeInTheDocument();
  expect(dialog.getByText(/^o tempo dormindo não conta no tempo dos runs/)).toBeInTheDocument();
});

test('with no task in progress the tasks line is left out (#468)', async () => {
  const bare: Experiment = { ...SLEEPY, rounds: SLEEPY.rounds.map((r) => ({ ...r, runs: r.runs.map(({ metrics: _metrics, ...rest }) => rest) })) };
  const dialog = await show(bare);
  expect(dialog.queryByText('tarefas')).not.toBeInTheDocument();
});

test('dormir is disabled while the reason is blank after trim, and while às… holds no time (#468)', async () => {
  const user = userEvent.setup();
  const dialog = await show();
  const sleep = dialog.getByRole('button', { name: 'dormir' });
  expect(sleep).toBeDisabled();
  await user.type(dialog.getByRole('textbox', { name: 'motivo' }), '   ');
  expect(sleep).toBeDisabled();
  await user.type(dialog.getByRole('textbox', { name: 'motivo' }), 'preciso da máquina');
  expect(sleep).toBeEnabled();
  await user.click(dialog.getByRole('radio', { name: 'às…' }));
  expect(sleep).toBeDisabled();
  fireEvent.change(dialog.getByLabelText('horário de acordar'), { target: { value: '13:00' } });
  expect(sleep).toBeEnabled();
});

test('dormir posts { reason } and closes (#468)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = vi.fn();
  const dialog = await show(SLEEPY, onClose);
  await user.type(dialog.getByRole('textbox', { name: 'motivo' }), ' preciso da máquina ');
  await user.click(dialog.getByRole('button', { name: 'dormir' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(calls).toEqual([{ method: 'POST', path: PATH, body: { reason: 'preciso da máquina' } }]);
});

test('with às… and Enter (the primary key) it posts { reason, wakeAt } (#468)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const dialog = await show();
  await user.type(dialog.getByRole('textbox', { name: 'motivo' }), 'preciso');
  await user.click(dialog.getByRole('radio', { name: 'às…' }));
  fireEvent.change(dialog.getByLabelText('horário de acordar'), { target: { value: '13:00' } });
  await user.keyboard('{Enter}');
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: PATH, body: { reason: 'preciso', wakeAt: '13:00' } }]));
});

test("a refused sleep keeps the dialog open with the shell's copy inline, no toast (#468)", async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch(409);
  const onClose = vi.fn();
  const dialog = await show(SLEEPY, onClose);
  await user.type(dialog.getByRole('textbox', { name: 'motivo' }), 'preciso');
  await user.click(dialog.getByRole('button', { name: 'dormir' }));
  expect(await dialog.findByRole('alert')).toHaveTextContent('o experimento está executando ou dormindo');
  expect(onClose).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});
