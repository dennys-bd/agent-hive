import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BenchmarkSidebar } from '@/components/benchmark/BenchmarkSidebar';
import { type BenchmarkSlots, useBenchmark } from '@/components/benchmark/benchmark-dock';
import { setLanguage } from '@/i18n';
import type { PanelId } from '@/lib/dock-layout';
import { EXPERIMENTS, WORKSPACES } from './benchmark-fixtures';

function Sidebar({ workspaces = WORKSPACES, activate = vi.fn(), slots }: { workspaces?: string[]; activate?: (id: PanelId) => void; slots?: BenchmarkSlots }) {
  const benchmark = useBenchmark(EXPERIMENTS, slots);
  return <BenchmarkSidebar benchmark={benchmark} workspaces={workspaces} isShown activate={activate} />;
}
const side = (): HTMLElement => screen.getByRole('navigation', { name: 'experimentos' });
const groups = (): (string | null)[] => within(side()).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
const row = (name: string): HTMLElement => within(side()).getByRole('button', { name: new RegExp(`^${name}`) });

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test("the screen's sample: three groups, each row with its state dot, the arm count and the sub line; the selected row current; arquivados · 2 at the foot (#461)", () => {
  render(<Sidebar />);
  expect(groups()).toEqual(['executando', 'rascunhos', 'concluídos']);
  expect(row('skills: comandos × plugin')).toHaveTextContent('skills: comandos × plugin3rodada 2/3 · via mcp');
  expect(row('skills: comandos × plugin')).toHaveAttribute('aria-current', 'true');
  expect(row('opus no plan')).toHaveTextContent('opus no plan2criado 10:12');
  expect(row('superpowers vs nada')).toHaveTextContent('30 set · 3 rodadas');
  expect(row('opus no plan').querySelector('[data-dot]')).toHaveClass('text-empty');
  expect(within(side()).getByRole('button', { name: 'arquivados · 2' })).toHaveAttribute('aria-expanded', 'false');
});

test('arquivados · N expands the archived group at the end of the list, and collapses it again (#461)', async () => {
  const user = userEvent.setup();
  render(<Sidebar />);
  await user.click(within(side()).getByRole('button', { name: 'arquivados · 2' }));
  expect(groups()).toEqual(['executando', 'rascunhos', 'concluídos', 'arquivados']);
  expect(row('rascunho velho')).toBeInTheDocument();
  await user.click(within(side()).getByRole('button', { name: 'arquivados · 2' }));
  expect(groups()).not.toContain('arquivados');
});

test('Ctrl+F focuses the search, opening the side first; the search filters every group by name, a group left empty hiding (#461)', async () => {
  const user = userEvent.setup();
  const activate = vi.fn();
  render(<Sidebar activate={activate} />);
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
  expect(activate).toHaveBeenCalledWith('benchmark');
  expect(screen.getByRole('searchbox', { name: 'buscar experimentos' })).toHaveFocus();
  await user.type(screen.getByRole('searchbox', { name: 'buscar experimentos' }), 'OPUS');
  expect(groups()).toEqual(['rascunhos']);
});
