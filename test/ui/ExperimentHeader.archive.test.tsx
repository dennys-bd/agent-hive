import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { ExperimentHeader } from '@/components/benchmark/ExperimentHeader';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { ARCHIVED, DRAFT, EXPERIMENTS, stubBenchmarkFetch } from './benchmark-fixtures';

function Head({ experiment, list = EXPERIMENTS, slots, primary }: { experiment: Experiment; list?: Experiment[]; slots?: BenchmarkSlots; primary?: string }) {
  const benchmark = useBenchmark(list, slots);
  return <ExperimentHeader benchmark={benchmark} experiment={experiment} primary={primary && <button type="button">{primary}</button>} />;
}
const more = (user: ReturnType<typeof userEvent.setup>): Promise<void> => user.click(screen.getByRole('button', { name: 'mais ações' }));

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('arquivar patches archived true and keeps the selection; an archived one offers desarquivar; the export slot shows only when filled (#461)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const { rerender } = render(<Head experiment={DRAFT} />);
  await more(user);
  expect(screen.queryByRole('menuitem', { name: 'exportar report.md' })).not.toBeInTheDocument();
  await user.click(await screen.findByRole('menuitem', { name: 'arquivar' }));
  rerender(<Head experiment={ARCHIVED} slots={{ exportReport: vi.fn() }} />);
  await more(user);
  expect(await screen.findByRole('menuitem', { name: 'exportar report.md' })).toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: 'desarquivar' }));
  await waitFor(() => expect(calls.map((c) => c.body)).toEqual([{ archived: true }, { archived: false }]));
});
