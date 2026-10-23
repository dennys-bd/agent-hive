import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useBenchmark } from '@/components/benchmark/benchmark-dock';
import { BenchmarkView } from '@/components/benchmark/BenchmarkView';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { COMPARE, stubBenchmarkFetch } from './benchmark-fixtures';

// The view as the dock mounts it, plus the entry point 2.2's ver em comparar will call
function View({ experiment = COMPARE, show = 'a3' }: { experiment?: Experiment; show?: string }) {
  const benchmark = useBenchmark([experiment]);
  return (
    <>
      <button type="button" onClick={() => benchmark.showInCompare(show)}>ver em comparar</button>
      <BenchmarkView benchmark={benchmark} workspaces={['agent-hive']} />
    </>
  );
}
type User = ReturnType<typeof userEvent.setup>;
const openCompare = (user: User): Promise<void> => user.click(screen.getByRole('button', { name: 'comparar' }));
const table = (): HTMLElement => screen.getByRole('table');
const rowLabels = (): string[] => within(table()).getAllByRole('rowheader').map((cell) => cell.textContent ?? '');
const cellsOf = (label: string): string[] => {
  const row = within(table()).getAllByRole('row').find((r) => within(r).queryByRole('rowheader')?.textContent === label);
  return row === undefined ? [] : within(row).getAllByRole('cell').map((cell) => cell.textContent ?? '');
};

beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("comparar draws the screen: config, base and one column per arm; só diferenças on shows the six differing rows and counts the nine hidden (#464)", async () => {
  const user = userEvent.setup();
  render(<View />);
  await openCompare(user);
  expect(screen.getByText('cada braço comparado com a base')).toBeInTheDocument();
  expect(within(table()).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
    'config', 'base', 'A · comandos do repo', 'B · skills do plugin', 'C · plugin + codex', 'D · tarefas juntas',
  ]);
  expect(rowLabels()).toEqual(['spec · prompt', 'plan · prompt', 'build · prompt', 'build · agente', 'plugins extras', 'tarefas']);
  expect(cellsOf('tarefas')).toEqual(['8 · 3 bloqueios · t·91d4', '·', '·', '·', '3 · 0 bloqueios']);
  expect(screen.getByRole('switch', { name: 'só diferenças' })).toBeChecked();
  expect(screen.getByText(
    '9 iguais escondidas · · = igual à base · fundo mais claro = o braço sobrepõe · clique numa célula para copiar o valor para outro braço',
  )).toBeInTheDocument();
});

test('só diferenças off shows every setup row and leaves the count out; the switch survives a change of tab (#464)', async () => {
  const user = userEvent.setup();
  render(<View />);
  await openCompare(user);
  await user.click(screen.getByRole('switch', { name: 'só diferenças' }));
  expect(rowLabels()).toHaveLength(15);
  expect(cellsOf('worktree · teardown')).toEqual(['—', '·', '·', '·', '·']);
  expect(screen.getByText(/^· = igual à base/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'braços' }));
  await openCompare(user);
  expect(screen.getByRole('switch', { name: 'só diferenças' })).not.toBeChecked();
});

const [, , C] = COMPARE.arms;

test("clicking an overridden cell opens copiar para with every other arm; a pick patches that arm's whole overrides, its own kept (#464)", async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  render(<View />);
  await openCompare(user);
  expect(within(table()).getAllByRole('button').map((b) => b.textContent)).toEqual(['/hive-spec', '/hive-plan', '/hive-build', 'codex · gpt-5', 'superpowers, ecc', '3 · 0 bloqueios']);
  await user.click(screen.getByRole('button', { name: 'codex · gpt-5' }));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByText('copiar para')).toBeInTheDocument();
  expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['A · comandos do repo', 'B · skills do plugin', 'D · tarefas juntas']);
  await user.click(within(menu).getByRole('menuitem', { name: 'A · comandos do repo' }));
  await waitFor(() => expect(calls).toEqual([{
    method: 'PATCH', path: '/benchmark/experiments/compare/arms/a1',
    body: { overrides: {
      stages: { spec: { skill: '/hive-spec' }, plan: { skill: '/hive-plan' }, build: { skill: '/hive-build', agent: 'codex', model: 'gpt-5' } },
      plugins: ['superpowers', 'ecc'],
    } },
  }]));
});

test('an arm already holding the value is listed disabled (#464)', async () => {
  const user = userEvent.setup();
  render(<View experiment={{ ...COMPARE, arms: [...COMPARE.arms, { id: 'a5', letter: 'E', name: 'codex também', overrides: C.overrides }] }} />);
  await openCompare(user);
  await user.click(screen.getAllByRole('button', { name: 'codex · gpt-5' })[0]);
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'E · codex também' })).toHaveAttribute('aria-disabled', 'true');
  expect(within(menu).getByRole('menuitem', { name: 'B · skills do plugin' })).not.toHaveAttribute('aria-disabled');
});

test('while the experiment runs or sleeps, an overridden cell is plain text on --accent: no button, no menu (#464)', async () => {
  const user = userEvent.setup();
  render(<View experiment={{ ...COMPARE, status: 'running' }} />);
  await openCompare(user);
  expect(within(table()).queryAllByRole('button')).toEqual([]);
  expect(within(table()).getByText('codex · gpt-5')).toHaveClass('bg-accent');
});

test("showInCompare lands on comparar with that arm's column underlined and scrolled into view; a change of tab clears it (#464)", async () => {
  const user = userEvent.setup();
  const scrolled: string[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this.textContent ?? ''); });
  render(<View />);
  await user.click(screen.getByRole('button', { name: 'ver em comparar' }));
  expect(screen.getByRole('button', { name: 'comparar' })).toHaveAttribute('aria-current', 'page');
  const head = within(table()).getByRole('columnheader', { name: 'C · plugin + codex' });
  expect(head).toHaveAttribute('aria-current', 'true');
  expect(head).toHaveClass('shadow-[inset_0_-2px_0_var(--foreground)]');
  expect(within(table()).getByRole('columnheader', { name: 'A · comandos do repo' })).not.toHaveAttribute('aria-current');
  expect(scrolled).toEqual(['C · plugin + codex']);
  await user.click(screen.getByRole('button', { name: 'braços' }));
  await openCompare(user);
  expect(within(table()).getByRole('columnheader', { name: 'C · plugin + codex' })).not.toHaveAttribute('aria-current');
});
