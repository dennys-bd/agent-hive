import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApprovalActions } from '@/components/ApprovalActions';
import { bootRunHive, readRunHive, resetRunHive } from '@/components/benchmark/run-mode/run-hive';
import { RunModeHost } from '@/components/benchmark/run-mode/RunModeHost';
import { setLanguage, t } from '@/i18n';
import { readView, resetViewState } from '@/lib/view-state';
import type { RunHive } from '@/components/benchmark/run-mode/run-hive';
import type { Task } from '../../src/types';
import { frozen, RUN, stubRunFetch, writes } from './run-hive-fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const TASK: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const AWAITING = { id: 'a-I1', approval: { since: '2026-10-22T10:00:00.000Z' } };
const APPROVED = 'POST /activities/a-I1/approve';

beforeEach(() => { setLanguage('pt'); resetViewState(); });
afterEach(() => { resetRunHive(); vi.unstubAllGlobals(); vi.mocked(toast.error).mockClear(); });

async function boot(run: RunHive = RUN) {
  const calls = stubRunFetch(run);
  await bootRunHive();
  render(<><ApprovalActions task={TASK} activity={AWAITING} /><RunModeHost /></>);
  return calls;
}
const approve = (): HTMLElement => screen.getByRole('button', { name: 'aprovar' });
const popover = (name = 'primeira intervenção neste run'): Promise<HTMLElement> => screen.findByRole('dialog', { name });

test('an approve in run mode asks first and sends nothing; aprovar e registrar sends it, the re-read counts 1, and the next ask is a new one (#469)', async () => {
  const user = userEvent.setup();
  const calls = await boot();
  await user.click(approve());
  const ask = await popover();
  expect(within(ask).getByText(/run k9f2a6d1/)).toBeInTheDocument();
  expect(writes(calls)).toEqual([]);
  await user.click(within(ask).getByRole('button', { name: 'aprovar e registrar' }));
  await waitFor(() => expect(readRunHive()?.interventions).toHaveLength(1));
  expect([writes(calls), screen.queryByRole('dialog')]).toEqual([[APPROVED], null]);
  await user.click(approve());
  expect(await popover('nova intervenção neste run')).toBeInTheDocument();
});

test('cancelar, Escape and a click outside send nothing and show no toast (#469)', async () => {
  const user = userEvent.setup();
  const calls = await boot();
  for (const dismiss of [() => user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'cancelar' })), () => user.keyboard('{Escape}'), () => user.click(document.body)]) {
    await user.click(approve());
    await popover();
    await dismiss();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }
  expect(writes(calls)).toEqual([]);
  expect(toast.error).not.toHaveBeenCalled();
});

test('não perguntar de novo, checked on an approve: the next approve sends without asking, and the choice is in the view state (#469)', async () => {
  const user = userEvent.setup();
  const calls = await boot();
  await user.click(approve());
  const ask = await popover();
  await user.click(within(ask).getByRole('checkbox', { name: 'não perguntar de novo neste run' }));
  await user.click(within(ask).getByRole('button', { name: 'aprovar e registrar' }));
  await user.click(approve());
  await waitFor(() => expect(writes(calls)).toEqual([APPROVED, APPROVED]));
  expect([screen.queryByRole('dialog'), readView('runNoAsk')]).toEqual([null, true]);
});

test('frozen: no popover, no request, the frozen toast (#469)', async () => {
  const user = userEvent.setup();
  const calls = await boot(frozen(RUN));
  await user.click(approve());
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('benchmark.run.frozen')));
  expect([screen.queryByRole('dialog'), writes(calls)]).toEqual([null, []]);
});

test('a normal Hive renders no host and asks nothing (#469)', async () => {
  const user = userEvent.setup();
  const calls = stubRunFetch(undefined);
  await bootRunHive();
  render(<><ApprovalActions task={TASK} activity={AWAITING} /><RunModeHost /></>);
  await user.click(approve());
  await waitFor(() => expect(writes(calls)).toEqual([APPROVED]));
  expect(screen.queryByRole('dialog')).toBeNull();
});
