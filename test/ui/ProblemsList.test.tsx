import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProblemsList, type ProblemsListProps } from '@/components/ProblemsList';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import type { CheckDiagnostic } from '../../src/types';

const A = 'a-I1';
const d = (path: string, line: number, severity: CheckDiagnostic['severity'], extra: Partial<CheckDiagnostic> = {}): CheckDiagnostic =>
  ({ path, line, column: 1, severity, message: `${severity} ${line}`, ...extra });
const tsc = (activityId: string, ...diagnostics: CheckDiagnostic[]): void => store.setCheck(activityId, 'tsc', { state: 'done', scope: 'project', diagnostics }, '');
const list = (props: Partial<ProblemsListProps> = {}) => <ProblemsList activityId={A} collapsed={new Set()} onToggle={vi.fn()} onOpen={vi.fn()} {...props} />;
const groupTitles = (): string[] => screen.getAllByRole('button').filter((b) => b.title !== '').map((b) => b.title);

beforeEach(() => setLanguage('pt'));
afterEach(() => { store.resetDiagnostics(); vi.useRealTimers(); });

test('the list groups the problems by file, errors first; a group is collapsed as the drawer says, and its click asks to toggle it (#782, #225)', async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  act(() => tsc(A, d('src/rules.test.ts', 4, 'warning'), d('src/Column.tsx', 9, 'error', { code: '2304' }), d('src/Column.tsx', 2, 'warning')));
  render(list({ collapsed: new Set(['src/rules.test.ts']), onToggle }));
  expect(groupTitles()).toEqual(['src/Column.tsx', 'src/rules.test.ts']);
  expect(screen.getByTitle('src/Column.tsx')).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByTitle('src/rules.test.ts')).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText('Column.tsx')).toHaveClass('text-destructive');
  expect(screen.getAllByText(/^(error|warning) \d$/).map((e) => e.textContent)).toEqual(['warning 2', 'error 9']);
  await user.click(screen.getByTitle('src/rules.test.ts'));
  expect(onToggle).toHaveBeenCalledWith('src/rules.test.ts');
});

test('a click on a line opens its file at its line and column; the line shows its source, code and place; no header, resizer or close of its own (#782, #225)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  act(() => tsc(A, d('src/Column.tsx', 9, 'error', { column: 14, code: '2304' })));
  render(list({ onOpen }));
  expect(screen.getByText('tsc 2304')).toBeInTheDocument();
  expect(screen.getByText('9:14')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /error 9/ }));
  expect(onOpen).toHaveBeenCalledWith('src/Column.tsx', { line: 9, col: 14 });
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'recolher todos' })).not.toBeInTheDocument();
});

test('with no problem the list says so and names the sources that found nothing, for the activity or for every activity (#782, #225)', () => {
  act(() => { store.setClient('k', A, 'typescript-language-server', { phase: 'ready' }); tsc(A); tsc('a-I2'); });
  const one = render(list());
  expect(screen.getByText('Nenhum problema na atividade')).toBeInTheDocument();
  expect(screen.getByText('typescript-language-server e tsc não acusaram nada')).toBeInTheDocument();
  one.unmount();
  render(list({ activityId: undefined }));
  expect(screen.getByText('Nenhum problema nas atividades')).toBeInTheDocument();
});

test('while a checker runs again or after it failed, its previous results stay at half opacity (#782)', () => {
  act(() => tsc(A, d('src/Column.tsx', 9, 'error')));
  render(list());
  expect(screen.getByRole('button', { name: /error 9/ })).not.toHaveClass('opacity-50');
  act(() => store.checkStarted(A, 'tsc', ''));
  expect(screen.getByRole('button', { name: /error 9/ })).toHaveClass('opacity-50');
});
