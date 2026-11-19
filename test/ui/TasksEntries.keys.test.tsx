import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { FlowShownContext } from '@/components/MainDock';
import { TasksEntries } from '@/components/tasks/TasksEntries';
import { FIRST_CENTER } from '@/hooks/use-tasks-center';
import { setLanguage } from '@/i18n';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { Flow } from '../../src/types';
import { SIDEBAR_STATE } from './sidebar-fixtures.js';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.restoreAllMocks());

// flowEntry off macOS (#921): jsdom is not macOS
const alt = (digit: number, target: Window | Element = window): boolean => fireEvent.keyDown(target, { key: String(digit), code: `Digit${digit}`, altKey: true });
const chips = (): string[] => screen.getAllByRole('button').map((b) => b.querySelector('kbd')?.textContent ?? '');
const entries = (show = vi.fn()) => <TasksEntries state={SIDEBAR_STATE} center={FIRST_CENTER} show={show} />;

test('each entry shows its position\'s key as a keycap after the counts, in its tooltip and aria-keyshortcuts; none past the ninth (#921)', () => {
  const flows: Flow[] = Array.from({ length: 9 }, (_, i) => ({ name: `f${i + 1}`, stages: [], transitions: [] }));
  render(<TasksEntries state={{ ...SIDEBAR_STATE, flows }} center={FIRST_CENTER} show={vi.fn()} />);
  expect(chips()).toEqual(['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9', '', '']); // f9 and sem fluxo
  const list = screen.getByRole('button', { name: /^todas em lista/ });
  expect(list).toHaveAttribute('title', 'todas em lista · Alt+1');
  expect(list).toHaveAttribute('aria-keyshortcuts', 'Alt+1');
  expect(list).toHaveClass('gap-1');
  const chip = list.querySelector('kbd');
  expect(chip).toHaveAttribute('aria-hidden', 'true');
  expect(chip).toHaveClass('h-4', 'min-w-[22px]', 'rounded-[4px]', 'border', 'font-sans', 'text-[11px]', 'tracking-widest', 'text-muted-foreground', 'tabular-nums');
  expect(chip?.previousElementSibling).toHaveClass('w-[18px]'); // the total's fixed column
  const outside = screen.getByRole('button', { name: /^sem fluxo/ });
  expect(outside).not.toHaveAttribute('title');
  expect(outside).not.toHaveAttribute('aria-keyshortcuts');
});

test('Alt+n shows the nth entry while the flow shows: todas em lista, the flows in order, sem fluxo; a key with no entry goes on (#921)', () => {
  const show = vi.fn();
  render(entries(show));
  expect([alt(1), alt(3), alt(4)]).toEqual([false, false, false]);
  expect(alt(5)).toBe(true);
  expect(show.mock.calls).toEqual([[{ kind: 'tasks', view: 'list' }], [{ kind: 'tasks', view: 'flow', flow: 'ship' }], [{ kind: 'tasks', view: 'outside' }]]);
});

test('no key while the flow is hidden, with the focus in a text field, inside a dialog or with Settings open (#921)', () => {
  const show = vi.fn();
  const { unmount } = render(<><input aria-label="campo" /><div role="dialog"><button type="button">ok</button></div>{entries(show)}</>);
  expect(alt(1, screen.getByRole('textbox', { name: 'campo' }))).toBe(true);
  expect(alt(2, screen.getByRole('button', { name: 'ok' }))).toBe(true);
  unmount();
  const hidden = render(<FlowShownContext.Provider value={false}>{entries(show)}</FlowShownContext.Provider>);
  expect(alt(1)).toBe(true);
  hidden.unmount();
  render(<>{entries(show)}<div data-settings-page="" /></>);
  expect(alt(1)).toBe(true);
  expect(show).not.toHaveBeenCalled();
});

test('a rebound key shows in its chip and acts; a key turned off shows no chip and does nothing (#921)', () => {
  setShortcuts({ flowEntry2: 'Alt+Shift+B', flowEntry3: null });
  onTestFinished(() => setShortcuts({}));
  const show = vi.fn();
  render(entries(show));
  expect(chips()).toEqual(['Alt+1', 'Alt+Shift+B', '', 'Alt+4']);
  expect(fireEvent.keyDown(window, { key: 'B', code: 'KeyB', altKey: true, shiftKey: true })).toBe(false);
  expect([alt(2), alt(3)]).toEqual([true, true]);
  expect(show.mock.calls).toEqual([[{ kind: 'tasks', view: 'flow', flow: 'build' }]]);
});

test('on macOS the chips read ⌃n and ⌃n picks the entry (#921)', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const show = vi.fn();
  render(entries(show));
  expect(chips()).toEqual(['⌃1', '⌃2', '⌃3', '⌃4']);
  expect(screen.getByRole('button', { name: /^build/ })).toHaveAttribute('aria-keyshortcuts', 'Control+2');
  expect(fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true })).toBe(false);
  expect(show).toHaveBeenCalledWith({ kind: 'tasks', view: 'flow', flow: 'build' });
});
