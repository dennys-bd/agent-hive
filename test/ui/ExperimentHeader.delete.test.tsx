import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { ExperimentHeader } from '@/components/benchmark/ExperimentHeader';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { DONE, EXPERIMENTS, stubBenchmarkFetch } from './benchmark-fixtures';

function Head({ experiment, list = EXPERIMENTS, slots, primary }: { experiment: Experiment; list?: Experiment[]; slots?: BenchmarkSlots; primary?: string }) {
  const benchmark = useBenchmark(list, slots);
  return <ExperimentHeader benchmark={benchmark} experiment={experiment} primary={primary && <button type="button">{primary}</button>} />;
}
const more = (user: ReturnType<typeof userEvent.setup>): Promise<void> => user.click(screen.getByRole('button', { name: 'mais ações' }));

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('excluir experimento opens the red confirmation with the context and the text, and confirming sends DELETE (#461)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Head experiment={DONE} />);
  await more(user);
  await user.click(await screen.findByRole('menuitem', { name: 'excluir experimento' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Excluir experimento' });
  expect(dialog).toHaveTextContent('superpowers vs nada · 3 rodadas');
  expect(dialog).toHaveTextContent('os runs em execução param, e os braços, as rodadas, os resultados e o relatório são apagados. para guardar o relatório, arquive em vez de excluir.');
  expect(within(dialog).getByRole('button', { name: 'excluir' })).toHaveClass('bg-destructive');
  await user.click(within(dialog).getByRole('button', { name: 'excluir' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'DELETE', path: `/benchmark/experiments/${DONE.id}` }]));
});
