import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { ExperimentHeader } from '@/components/benchmark/ExperimentHeader';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { DONE, DRAFT, EXPERIMENTS, MCP_DRAFT, RUNNING, stubBenchmarkFetch } from './benchmark-fixtures';

function Head({ experiment, list = EXPERIMENTS, slots, primary }: { experiment: Experiment; list?: Experiment[]; slots?: BenchmarkSlots; primary?: string }) {
  const benchmark = useBenchmark(list, slots);
  return <ExperimentHeader benchmark={benchmark} experiment={experiment} primary={primary && <button type="button">{primary}</button>} />;
}

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('the chip and the mono line per status and creator (#461)', () => {
  const { rerender } = render(<Head experiment={RUNNING} />);
  expect(screen.getByText('executando · rodada 2/3')).toHaveClass('text-working');
  expect(screen.getByText(`${RUNNING.id} · baseline a42b2fc · criado por claude · opus via mcp`)).toHaveClass('font-mono');
  rerender(<Head experiment={{ ...RUNNING, status: 'sleeping' }} />);
  expect(screen.getByText('dormindo · rodada 2/3')).toBeInTheDocument();
  rerender(<Head experiment={DRAFT} />);
  expect(screen.getByText('rascunho')).toBeInTheDocument();
  expect(screen.getByText(/· criado por você$/)).toBeInTheDocument();
  rerender(<Head experiment={MCP_DRAFT} />);
  expect(screen.getByText(/· criado por claude via mcp$/)).toBeInTheDocument();
  rerender(<Head experiment={DONE} />);
  expect(screen.getByText('concluído')).toBeInTheDocument();
});

test('dormir: disabled at .35 while running with no handler, live with one, absent in every other status; the primary slot renders only when given (#461)', async () => {
  const user = userEvent.setup();
  const sleep = vi.fn();
  const { rerender } = render(<Head experiment={RUNNING} />);
  expect(screen.getByRole('button', { name: 'dormir' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'dormir' })).toHaveClass('disabled:opacity-35');
  rerender(<Head experiment={RUNNING} slots={{ sleep }} primary="executar" />);
  await user.click(screen.getByRole('button', { name: 'dormir' }));
  expect(sleep).toHaveBeenCalledWith(RUNNING);
  expect(screen.getByRole('button', { name: 'executar' })).toBeInTheDocument();
  rerender(<Head experiment={DRAFT} />);
  expect(screen.queryByRole('button', { name: 'dormir' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'executar' })).not.toBeInTheDocument();
});

test("the header's duplicar opens Duplicar experimento for this experiment (#461)", async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Head experiment={RUNNING} />);
  await user.click(screen.getByRole('button', { name: 'duplicar' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Duplicar experimento' });
  await user.click(within(dialog).getByRole('button', { name: 'duplicar' }));
  await waitFor(() => expect(calls[0]?.body).toEqual({ kind: 'duplicate', of: RUNNING.id }));
});

test('the running chip reads rodada 1/N once the first round started, and says it stops after this round once asked; sleeping keeps its own (#465)', () => {
  const started: Experiment = { ...DRAFT, status: 'running', rounds: [{ n: 1, startedAt: '2026-10-22T10:30:00', runs: [] }] };
  const { rerender } = render(<Head experiment={started} />);
  expect(screen.getByText('executando · rodada 1/3')).toHaveClass('text-working');
  rerender(<Head experiment={{ ...RUNNING, stopAfterRound: true }} />);
  expect(screen.getByText('executando · rodada 2/3 · para após esta rodada')).toHaveClass('text-working');
  rerender(<Head experiment={{ ...RUNNING, status: 'sleeping', stopAfterRound: true }} />);
  expect(screen.getByText('dormindo · rodada 2/3')).toBeInTheDocument();
});
