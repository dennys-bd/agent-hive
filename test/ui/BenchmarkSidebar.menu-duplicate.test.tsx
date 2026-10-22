import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BenchmarkSidebar } from '@/components/benchmark/BenchmarkSidebar';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { setLanguage } from '@/i18n';
import type { PanelId } from '@/lib/dock-layout';
import { DONE, EXPERIMENTS, stubBenchmarkFetch, WORKSPACES } from './benchmark-fixtures';

function Sidebar({ workspaces = WORKSPACES, activate = vi.fn(), slots }: { workspaces?: string[]; activate?: (id: PanelId) => void; slots?: BenchmarkSlots }) {
  const benchmark = useBenchmark(EXPERIMENTS, slots);
  return <BenchmarkSidebar benchmark={benchmark} workspaces={workspaces} isShown activate={activate} />;
}
const side = (): HTMLElement => screen.getByRole('navigation', { name: 'experimentos' });
const openPlus = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => user.click(within(side()).getByRole('button', { name: 'novo experimento' }));

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('duplicar existente… lists the live experiments; a pick opens Duplicar experimento with its name, and confirming posts kind duplicate (#461)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<Sidebar slots={{ askAgent: vi.fn() }} />);
  await openPlus(user);
  expect(await screen.findByRole('menuitem', { name: /^pedir ao agente/ })).toBeInTheDocument();
  screen.getByRole('menuitem', { name: /^duplicar existente…/ }).focus();
  await user.keyboard('{ArrowRight}');
  const sub = await screen.findByRole('menu', { name: /duplicar existente…/ });
  expect(within(sub).getAllByRole('menuitem').map((i) => i.textContent)).not.toContain('velho opus'); // archived ones are not offered
  fireEvent.click(within(sub).getByRole('menuitem', { name: DONE.name }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Duplicar experimento' });
  expect(dialog).toHaveTextContent(DONE.name);
  expect(dialog).toHaveTextContent('cria um rascunho com os mesmos braços, tarefas e config, sem as rodadas.');
  await user.click(within(dialog).getByRole('button', { name: 'duplicar' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/benchmark/experiments', body: { kind: 'duplicate', of: DONE.id } }]));
});
