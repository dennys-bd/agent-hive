import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BenchmarkSidebar } from '@/components/benchmark/BenchmarkSidebar';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { setLanguage } from '@/i18n';
import type { PanelId } from '@/lib/dock-layout';
import { EXPERIMENTS, stubBenchmarkFetch, WORKSPACES } from './benchmark-fixtures';

function Sidebar({ workspaces = WORKSPACES, activate = vi.fn(), slots }: { workspaces?: string[]; activate?: (id: PanelId) => void; slots?: BenchmarkSlots }) {
  const benchmark = useBenchmark(EXPERIMENTS, slots);
  return <BenchmarkSidebar benchmark={benchmark} workspaces={workspaces} isShown activate={activate} />;
}
const side = (): HTMLElement => screen.getByRole('navigation', { name: 'experimentos' });
const openPlus = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => user.click(within(side()).getByRole('button', { name: 'novo experimento' }));

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('with one workspace, experimento vazio posts kind empty there at once (#461)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Sidebar workspaces={['agent-hive']} />);
  await openPlus(user);
  await user.click(await screen.findByRole('menuitem', { name: /^experimento vazio/ }));
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/benchmark/experiments', body: { kind: 'empty', workspace: 'agent-hive' } }]));
  expect(screen.queryByRole('menuitem', { name: /pedir ao agente/ })).not.toBeInTheDocument(); // no slot filled: no item
});
