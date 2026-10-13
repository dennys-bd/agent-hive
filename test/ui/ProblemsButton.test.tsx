import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProblemsButton } from '@/components/footer/ProblemsButton';
import type { ConsoleChannels } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import type { CheckDiagnostic } from '../../src/types';

const A = 'a-I1';
const d = (path: string, line: number, severity: CheckDiagnostic['severity']): CheckDiagnostic => ({ path, line, column: 1, severity, message: `${severity} ${line}` });
const channels = (over: Partial<ConsoleChannels> = {}): ConsoleChannels => ({
  channels: [], stamp: '', isOpen: false, tab: 'console', select: vi.fn(), refresh: vi.fn(), show: vi.fn(), open: vi.fn(), close: vi.fn(), ...over,
});

beforeEach(() => setLanguage('pt'));
afterEach(() => store.resetDiagnostics());

test('one icon and number per non-zero severity, errors then warnings then infos, each in its colour (#225)', () => {
  act(() => store.setCheck(A, 'tsc', { state: 'done', scope: 'project', diagnostics: [d('a.ts', 1, 'error'), d('b.ts', 2, 'info'), d('b.ts', 3, 'info')] }, ''));
  render(<ProblemsButton activityId={A} console={channels()} />);
  const button = screen.getByRole('button', { name: 'problemas' });
  expect(button).toHaveTextContent(/^12$/);
  expect(within(button).getByText('1')).toHaveClass('text-destructive');
  expect(within(button).getByText('2')).toHaveClass('text-review');
  expect(button.querySelector('.text-waiting')).toBeNull();
  expect(button).toHaveAttribute('title', 'problemas · Ctrl+Shift+M'); // jsdom runs as off macOS
});

test('with none, a muted check alone, titled nenhum problema with its key (#225)', () => {
  render(<ProblemsButton activityId={A} console={channels()} />);
  const button = screen.getByRole('button', { name: 'problemas' });
  expect(button).toHaveTextContent(/^$/);
  expect(button.querySelector('svg')).toHaveClass('text-muted-foreground');
  expect(button).toHaveAttribute('title', 'nenhum problema · Ctrl+Shift+M');
});

test('without an activity it counts every activity (#225)', () => {
  act(() => {
    store.setCheck(A, 'tsc', { state: 'done', scope: 'project', diagnostics: [d('a.ts', 1, 'warning')] }, '');
    store.setCheck('a-I2', 'tsc', { state: 'done', scope: 'project', diagnostics: [d('b.ts', 1, 'warning')] }, '');
  });
  render(<ProblemsButton console={channels()} />);
  expect(within(screen.getByRole('button', { name: 'problemas' })).getByText('2')).toHaveClass('text-waiting');
});

test('pressed and accent while the drawer shows problems; a click asks for the problems tab (#225)', async () => {
  const user = userEvent.setup();
  const show = vi.fn();
  const { rerender } = render(<ProblemsButton activityId={A} console={channels({ isOpen: true, tab: 'console', show })} />);
  const button = screen.getByRole('button', { name: 'problemas' });
  expect(button).toHaveAttribute('aria-pressed', 'false');
  rerender(<ProblemsButton activityId={A} console={channels({ isOpen: true, tab: 'problems', show })} />);
  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(button).toHaveClass('bg-accent');
  await user.click(button);
  expect(show).toHaveBeenCalledWith('problems');
});
