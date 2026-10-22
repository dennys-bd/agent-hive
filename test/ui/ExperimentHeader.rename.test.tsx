import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { ExperimentHeader } from '@/components/benchmark/ExperimentHeader';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { DRAFT, EXPERIMENTS, stubBenchmarkFetch } from './benchmark-fixtures';

function Head({ experiment, list = EXPERIMENTS, slots, primary }: { experiment: Experiment; list?: Experiment[]; slots?: BenchmarkSlots; primary?: string }) {
  const benchmark = useBenchmark(list, slots);
  return <ExperimentHeader benchmark={benchmark} experiment={experiment} primary={primary && <button type="button">{primary}</button>} />;
}
const more = (user: ReturnType<typeof userEvent.setup>): Promise<void> => user.click(screen.getByRole('button', { name: 'mais ações' }));

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('renomear turns the name into a field: Enter posts the trimmed new name, Esc cancels, an unchanged or blank one posts nothing; the header shows the state’s name (#461)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const { rerender } = render(<Head experiment={DRAFT} />);
  await more(user);
  await user.click(await screen.findByRole('menuitem', { name: 'renomear' }));
  const field = await screen.findByRole('textbox', { name: 'nome do experimento' });
  await user.clear(field);
  await user.type(field, '  opus no plan 2 {Enter}');
  await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: `/benchmark/experiments/${DRAFT.id}`, body: { name: 'opus no plan 2' } }]));
  rerender(<Head experiment={{ ...DRAFT, name: 'opus no plan 2' }} />);
  expect(screen.getByText('opus no plan 2')).toBeInTheDocument();
  await more(user);
  await user.click(await screen.findByRole('menuitem', { name: 'renomear' }));
  await user.type(await screen.findByRole('textbox', { name: 'nome do experimento' }), ' x{Escape}');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(calls).toHaveLength(1);
});
