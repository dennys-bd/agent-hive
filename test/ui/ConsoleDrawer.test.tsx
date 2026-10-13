import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConsoleChip, ConsoleDrawer } from '@/components/ConsoleDrawer';
import { ProblemsButton } from '@/components/footer/ProblemsButton';
import { useConsoleChannels } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import type { FileAt } from '@/lib/editor-models';
import type { CheckDiagnostic } from '../../src/types';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const A = 'a-I1';
const d = (path: string, line: number, severity: CheckDiagnostic['severity'], extra: Partial<CheckDiagnostic> = {}): CheckDiagnostic =>
  ({ path, line, column: 1, severity, message: `${severity} ${line}`, ...extra });
const tsc = (activityId: string, ...diagnostics: CheckDiagnostic[]): void => store.setCheck(activityId, 'tsc', { state: 'done', scope: 'project', diagnostics }, '');
type OnOpenProblem = (activityId: string, path: string, at: FileAt) => void;

function Harness({ activityId, onOpenProblem }: { activityId?: string; onOpenProblem?: OnOpenProblem }) {
  const channels = useConsoleChannels('');
  return (
    <>
      <ProblemsButton activityId={activityId} console={channels} />
      <ConsoleChip console={channels} />
      <ConsoleDrawer console={channels} fontFamily="monospace" activityId={activityId} onOpenProblem={onOpenProblem} />
      <div role="dialog"><input aria-label="campo" /></div>
    </>
  );
}
const drawers = (): HTMLElement[] => screen.queryAllByRole('region', { name: 'console' });
const key = (letter: 'J' | 'M', target: Element = document.body): boolean => fireEvent.keyDown(target, { key: letter, ctrlKey: true, shiftKey: true }); // jsdom: off macOS
const tabChecked = (name: string): boolean => within(drawers()[0]).getByRole('radio', { name }).getAttribute('aria-checked') === 'true';

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { store.resetDiagnostics(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('⌘⇧M and the problems button open the drawer on problemas, ⌘J and the chip on console; one replaces the other in the one drawer, the same key closes it (#225)', async () => {
  const user = userEvent.setup();
  render(<Harness activityId={A} />);
  key('M');
  expect(drawers()).toHaveLength(1);
  expect(tabChecked('problemas')).toBe(true);
  key('J');
  expect(drawers()).toHaveLength(1);
  expect(tabChecked('console')).toBe(true);
  key('J');
  expect(drawers()).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'problemas' }));
  expect(tabChecked('problemas')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'console' }));
  expect(tabChecked('console')).toBe(true);
  key('M');
  key('M');
  expect(drawers()).toHaveLength(0);
});

test('inside a dialog ⌘⇧M is left to the dialog: the drawer stays closed and the key is not taken (#225)', () => {
  render(<Harness activityId={A} />);
  expect(key('M', screen.getByRole('textbox', { name: 'campo' }))).toBe(true);
  expect(drawers()).toHaveLength(0);
});

test('the segmented control switches the tab; Escape and esc close the drawer on problems (#225)', async () => {
  const user = userEvent.setup();
  render(<Harness activityId={A} />);
  key('M');
  await user.click(within(drawers()[0]).getByRole('radio', { name: 'console' }));
  expect(within(drawers()[0]).getByText('Nenhum comando executado ainda.')).toBeInTheDocument();
  await user.click(within(drawers()[0]).getByRole('radio', { name: 'problemas' }));
  expect(within(drawers()[0]).getByText('Nenhum problema na atividade')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(drawers()).toHaveLength(0);
  key('M');
  await user.click(within(drawers()[0]).getByRole('button', { name: 'fechar o console' }));
  expect(drawers()).toHaveLength(0);
});

test('the problems header shows the totals, the running or failed checkers and recolher todos, which collapses every group (#225)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 6, 14, 2));
  const user = userEvent.setup();
  act(() => tsc(A, d('src/a.ts', 1, 'error'), d('src/b.ts', 2, 'warning'), d('src/b.ts', 3, 'warning')));
  render(<Harness activityId={A} />);
  key('M');
  const drawer = drawers()[0];
  expect(within(drawer).getByText('1 erro')).toHaveClass('text-destructive');
  expect(within(drawer).getByText('2 avisos')).toHaveClass('text-waiting');
  act(() => store.checkStarted(A, 'tsc', ''));
  expect(within(drawer).getByText('tsc executando · resultados de 14:02')).toBeInTheDocument();
  act(() => store.setCheck(A, 'tsc', { state: 'failed', reason: 'exit code 2' }, ''));
  expect(within(drawer).getByText('tsc falhou')).toHaveAttribute('title', 'exit code 2');
  expect(within(drawer).getAllByRole('button', { expanded: true })).toHaveLength(2);
  await user.click(within(drawer).getByRole('button', { name: 'recolher todos' }));
  expect(within(drawer).queryAllByRole('button', { expanded: true })).toHaveLength(0);
  expect(within(drawer).getAllByRole('button', { expanded: false })).toHaveLength(2);
});

test('a problem\'s click opens its file in the shown activity, or without one in the first activity holding it (#225)', async () => {
  const user = userEvent.setup();
  const onOpenProblem = vi.fn<OnOpenProblem>();
  act(() => tsc('a-I2', d('src/Column.tsx', 9, 'error', { column: 14 })));
  const shown = render(<Harness activityId="a-I2" onOpenProblem={onOpenProblem} />);
  key('M');
  await user.click(within(drawers()[0]).getByRole('button', { name: /error 9/ }));
  expect(onOpenProblem).toHaveBeenLastCalledWith('a-I2', 'src/Column.tsx', { line: 9, col: 14 });
  shown.unmount();
  render(<Harness onOpenProblem={onOpenProblem} />);
  key('M');
  await user.click(within(drawers()[0]).getByRole('button', { name: /error 9/ }));
  expect(onOpenProblem).toHaveBeenLastCalledWith('a-I2', 'src/Column.tsx', { line: 9, col: 14 });
});

test('without an activity the empty tab says so for every activity (#225)', () => {
  render(<Harness />);
  key('M');
  expect(within(drawers()[0]).getByText('Nenhum problema nas atividades')).toBeInTheDocument();
});
