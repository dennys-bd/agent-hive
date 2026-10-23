import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WakeDialog } from '@/components/benchmark/sleep/WakeDialog';
import { setLanguage } from '@/i18n';
import { ASLEEP, stubBenchmarkFetch } from './benchmark-fixtures';

const NOT_YET = new Date('2026-10-02T06:45:00'); // local: before ASLEEP's 07:00
const PASSED = new Date('2026-10-02T07:05:00');
const PATH = `/benchmark/experiments/${ASLEEP.id}/wake`;

beforeEach(() => {
  setLanguage('pt');
  vi.useFakeTimers({ toFake: ['Date'] }); // the dialog reads the clock; the timers user-event waits on stay real
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function show(now: Date, experiment = ASLEEP) {
  vi.setSystemTime(now);
  const onClose = vi.fn();
  render(<WakeDialog experiment={experiment} onClose={onClose} />);
  return { dialog: within(await screen.findByRole('alertdialog', { name: 'Acordar experimento' })), onClose };
}

test('before the deadline: the header text and the footer, no notice and no option; acordar posts {} and closes (#468)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const { dialog, onClose } = await show(NOT_YET);
  expect(dialog.getByText('dormiu às 04:40 · "preciso da máquina para outra coisa" · 3 runs e 7 tarefas continuam do ponto em que pararam')).toBeInTheDocument();
  expect(dialog.getByText('dormiu 1 vez · 2h05 fora do tempo dos runs')).toBeInTheDocument();
  expect(dialog.queryByRole('radio')).not.toBeInTheDocument();
  await user.click(dialog.getByRole('button', { name: 'acordar' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: PATH, body: {} }]));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('past the deadline: the yellow notice and the three options, terminar a rodada 2 preselected (#468)', async () => {
  const { dialog } = await show(PASSED);
  expect(dialog.getByText('o horário limite de 07:00 passou enquanto dormia. a rodada 3 não começou.')).toHaveClass('text-waiting');
  expect(dialog.getAllByRole('radio').map((r) => r.closest('label')?.querySelector('.font-medium')?.textContent)).toEqual(['terminar a rodada 2', 'novo horário limite', 'sem limite']);
  expect(dialog.getByRole('radio', { name: /^terminar a rodada 2/ })).toBeChecked();
  expect(dialog.getByText('dormiu 1 vez · 2h25 fora do tempo dos runs')).toBeInTheDocument();
});

test('past the deadline on the last round: the notice names no next round (#468)', async () => {
  const { dialog } = await show(PASSED, { ...ASLEEP, pace: { ...ASLEEP.pace, pairs: 2 } });
  expect(dialog.getByText('o horário limite de 07:00 passou enquanto dormia.')).toHaveClass('text-waiting');
});

test("each option posts its deadline: finish-round, { until }, none (#468)", async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const wakeWith = async (u: UserEvent, pick: RegExp, until?: string): Promise<void> => {
    const { dialog } = await show(PASSED);
    await u.click(dialog.getByRole('radio', { name: pick }));
    if (until !== undefined) fireEvent.change(dialog.getByLabelText('novo horário'), { target: { value: until } });
    await u.click(dialog.getByRole('button', { name: 'acordar' }));
    cleanup();
  };
  await wakeWith(user, /^terminar a rodada 2/);
  await wakeWith(user, /^novo horário limite/, '13:00');
  await wakeWith(user, /^sem limite/);
  expect(calls.map((c) => c.body)).toEqual([{ deadline: 'finish-round' }, { deadline: { until: '13:00' } }, { deadline: 'none' }]);
});

test('acordar is disabled on novo horário limite while its time is empty; picking the option focuses the field (#468)', async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch();
  const { dialog } = await show(PASSED);
  await user.click(dialog.getByRole('radio', { name: /^novo horário limite/ }));
  expect(dialog.getByLabelText('novo horário')).toHaveFocus();
  expect(dialog.getByRole('button', { name: 'acordar' })).toBeDisabled();
  fireEvent.change(dialog.getByLabelText('novo horário'), { target: { value: '13:00' } });
  expect(dialog.getByRole('button', { name: 'acordar' })).toBeEnabled();
});

test('continuar dormindo closes with no post (#468)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const { dialog, onClose } = await show(PASSED);
  await user.click(dialog.getAllByRole('button', { name: 'continuar dormindo' }).at(-1) as HTMLElement); // the footer's; the × shares its name
  expect(onClose).toHaveBeenCalled();
  expect(calls).toEqual([]);
});
