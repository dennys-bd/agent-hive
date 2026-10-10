import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProblemsList, type ProblemsListProps } from '@/components/ProblemsList';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import type { CheckDiagnostic } from '../../src/types';

const A = 'a-I1';
const d = (path: string, line: number, severity: CheckDiagnostic['severity'], extra: Partial<CheckDiagnostic> = {}): CheckDiagnostic =>
  ({ path, line, column: 1, severity, message: `${severity} ${line}`, ...extra });
const tsc = (...diagnostics: CheckDiagnostic[]): void => store.setCheck(A, 'tsc', { state: 'done', scope: 'project', diagnostics }, '');
const list = (props: Partial<ProblemsListProps> = {}) => <ProblemsList activityId={A} onOpen={vi.fn()} onClose={vi.fn()} {...props} />;

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.useRealTimers());

test('the list groups the activity\'s problems by file, errors first, its header the totals; a group collapses, recolher todos collapses them all (#782)', async () => {
  const user = userEvent.setup();
  act(() => tsc(d('src/rules.test.ts', 4, 'warning'), d('src/Column.tsx', 9, 'error', { code: '2304' }), d('src/Column.tsx', 2, 'warning')));
  render(list());
  const region = screen.getByRole('region', { name: 'problemas' });
  expect(within(region).getByText('1 erro')).toHaveClass('text-destructive');
  expect(within(region).getByText('2 avisos')).toHaveClass('text-waiting');
  const groups = within(region).getAllByRole('button', { expanded: true });
  expect(groups.map((g) => g.title)).toEqual(['src/Column.tsx', 'src/rules.test.ts']);
  expect(within(groups[0]).getByText('Column.tsx')).toHaveClass('text-destructive');
  expect(within(groups[0]).getByText('src')).toHaveClass('font-mono');
  expect(within(groups[0]).getByText('2')).toBeInTheDocument();
  expect(screen.getAllByText(/^(error|warning) \d$/).map((e) => e.textContent)).toEqual(['warning 2', 'error 9', 'warning 4']);
  await user.click(groups[1]);
  expect(screen.queryByText('warning 4')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'recolher todos' }));
  expect(screen.queryByText('error 9')).not.toBeInTheDocument();
});

test('a click on a line opens its file at its line and column; the line shows its source, code and place; the × closes the list (#782)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  act(() => tsc(d('src/Column.tsx', 9, 'error', { column: 14, code: '2304' })));
  render(list({ onOpen, onClose }));
  expect(screen.getByText('tsc 2304')).toBeInTheDocument();
  expect(screen.getByText('9:14')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /error 9/ }));
  expect(onOpen).toHaveBeenCalledWith('src/Column.tsx', { line: 9, col: 14 });
  await user.click(screen.getByRole('button', { name: 'fechar problemas' }));
  expect(onClose).toHaveBeenCalled();
});

test('with no problem the list says so and names the sources that found nothing (#782)', () => {
  act(() => { store.setClient('k', A, 'typescript-language-server', { phase: 'ready' }); tsc(); });
  render(list());
  expect(screen.getByText('Nenhum problema na atividade')).toBeInTheDocument();
  expect(screen.getByText('typescript-language-server e tsc não acusaram nada')).toBeInTheDocument();
});

test('while a checker runs again or after it failed, its previous results stay at half opacity and the header says so (#782)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 6, 14, 2));
  const user = userEvent.setup();
  const onViewLog = vi.fn();
  act(() => tsc(d('src/Column.tsx', 9, 'error')));
  render(list({ onViewLog }));
  expect(screen.getByRole('button', { name: /error 9/ })).not.toHaveClass('opacity-50');
  act(() => store.checkStarted(A, 'tsc', ''));
  expect(screen.getByText('tsc executando · resultados de 14:02')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /error 9/ })).toHaveClass('opacity-50');
  act(() => store.setCheck(A, 'tsc', { state: 'failed', reason: 'exit code 2', log: { channel: 'check:hive:tsc', run: 'r2' } }, ''));
  expect(screen.getByText('tsc falhou')).toHaveAttribute('title', 'exit code 2');
  await user.click(screen.getByRole('button', { name: 'ver log' }));
  expect(onViewLog).toHaveBeenCalledWith({ channel: 'check:hive:tsc', run: 'r2' });
});

test('a checker running before any result says so alone; the top edge resizes the list from its 180px (#782)', async () => {
  const user = userEvent.setup();
  act(() => store.checkStarted(A, 'mypy', 'a.py'));
  render(list());
  expect(screen.getByText('mypy executando')).toBeInTheDocument();
  const edge = screen.getByRole('separator', { name: 'redimensionar problemas' });
  expect(edge).toHaveAttribute('aria-valuenow', '180');
  edge.focus();
  await user.keyboard('{ArrowUp}');
  expect(edge).toHaveAttribute('aria-valuenow', '196');
  expect(screen.getByRole('region', { name: 'problemas' })).toHaveStyle({ height: '196px' });
});
