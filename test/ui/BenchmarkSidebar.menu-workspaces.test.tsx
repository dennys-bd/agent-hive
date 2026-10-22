import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BenchmarkSidebar } from '@/components/benchmark/BenchmarkSidebar';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { setLanguage } from '@/i18n';
import type { PanelId } from '@/lib/dock-layout';
import { WorkspaceColorsContext } from '@/lib/workspace-color';
import { EXPERIMENTS, stubBenchmarkFetch, WORKSPACES } from './benchmark-fixtures';

function Sidebar({ workspaces = WORKSPACES, activate = vi.fn(), slots }: { workspaces?: string[]; activate?: (id: PanelId) => void; slots?: BenchmarkSlots }) {
  const benchmark = useBenchmark(EXPERIMENTS, slots);
  return <BenchmarkSidebar benchmark={benchmark} workspaces={workspaces} isShown activate={activate} />;
}
const Colors = ({ children }: { children: ReactNode }) => <WorkspaceColorsContext.Provider value={{ 'agent-hive': '#112233', 'hive-site': '#445566' }}>{children}</WorkspaceColorsContext.Provider>;
const side = (): HTMLElement => screen.getByRole('navigation', { name: 'experimentos' });
const openPlus = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => user.click(within(side()).getByRole('button', { name: 'novo experimento' }));

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('with two workspaces, experimento vazio opens their submenu with each colour; a pick posts in it (#461)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Colors><Sidebar /></Colors>);
  await openPlus(user);
  (await screen.findByRole('menuitem', { name: /^experimento vazio/ })).focus();
  await user.keyboard('{ArrowRight}');
  const site = await screen.findByRole('menuitem', { name: 'hive-site' });
  expect(site.querySelector('span[style]')).toHaveStyle({ backgroundColor: '#445566' });
  fireEvent.click(site);
  await waitFor(() => expect(calls[0]?.body).toEqual({ kind: 'empty', workspace: 'hive-site' }));
});
