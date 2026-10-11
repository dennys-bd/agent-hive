import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { counterText, TerminalFind } from '@/components/TerminalFind';
import { setLanguage } from '@/i18n';
import { FakeSearchAddon, FakeTerminal, resetFakes } from './xterm-fakes';

beforeEach(() => { setLanguage('en'); resetFakes(); });
afterEach(() => { vi.restoreAllMocks(); document.documentElement.removeAttribute('data-theme'); });

// A bar over a fake xterm with `selection` selected ('' for none); view() renders it open or closed at a request
function harness(selection = '') {
  const term = new FakeTerminal();
  term.selection = selection;
  const focus = vi.spyOn(term, 'focus');
  const search = new FakeSearchAddon();
  const onClose = vi.fn();
  const view = (isOpen: boolean, request: number) => (
    <TerminalFind term={term as unknown as Terminal} search={search as unknown as SearchAddon} isOpen={isOpen} request={request} onClose={onClose} />
  );
  return { term, focus, search, onClose, view };
}
const field = (): HTMLInputElement => screen.getByRole('textbox', { name: 'find' });
const selected = (input: HTMLInputElement): string => input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);

test('closed it renders nothing; opened it fills the field from the terminal\'s selection, searches it and selects it (#12)', () => {
  const { search, view } = harness('npm ERR!');
  const { rerender } = render(view(false, 0));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  rerender(view(true, 1));
  expect(field()).toHaveValue('npm ERR!');
  expect(field()).toHaveFocus();
  expect(selected(field())).toBe('npm ERR!');
  expect(search.calls).toEqual([['next', 'npm ERR!', true]]);
});

test('with no selection, or a multi-line one, the field keeps the tab\'s last query across a close, selected (#12)', async () => {
  const user = userEvent.setup();
  const { term, view } = harness();
  const { rerender } = render(view(true, 1));
  expect(field()).toHaveValue('');
  await user.type(field(), 'error');
  rerender(view(false, 1));
  term.selection = 'line 1\nline 2';
  rerender(view(true, 2));
  expect(field()).toHaveValue('error');
  expect(selected(field())).toBe('error');
});

test('typing searches incrementally at each change; an empty field clears the highlights and the counter (#12)', async () => {
  const user = userEvent.setup();
  const { search, view } = harness();
  render(view(true, 1));
  await user.type(field(), 'ab');
  expect(search.calls).toEqual([['next', 'a', true], ['next', 'ab', true]]);
  act(() => search.results(0, 2));
  expect(screen.getByText('1 of 2')).toBeInTheDocument();
  await user.clear(field());
  expect(search.cleared).toBe(1);
  expect(screen.queryByText('1 of 2')).not.toBeInTheDocument();
});

test('Enter and the next button go to the next match, Shift+Enter and the previous button to the previous one; a click leaves the focus in the field (#12)', async () => {
  const user = userEvent.setup();
  const { search, view } = harness('fail');
  render(view(true, 1));
  await user.keyboard('{Enter}{Shift>}{Enter}{/Shift}');
  await user.click(screen.getByRole('button', { name: 'next match' }));
  await user.click(screen.getByRole('button', { name: 'previous match' }));
  expect(search.calls).toEqual([['next', 'fail', true], ['next', 'fail', false], ['previous', 'fail', false], ['next', 'fail', false], ['previous', 'fail', false]]);
  expect(field()).toHaveFocus();
});

test('Escape clears the highlights, closes the bar and gives the focus back to the terminal; the key goes no further; × does the same (#12)', async () => {
  const user = userEvent.setup();
  const { search, focus, onClose, view } = harness('fail');
  render(view(true, 1));
  const bubbled = vi.fn();
  document.addEventListener('keydown', bubbled);
  await user.keyboard('{Escape}');
  document.removeEventListener('keydown', bubbled);
  expect([search.cleared, onClose.mock.calls.length, focus.mock.calls.length]).toEqual([1, 1, 1]);
  expect(bubbled).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'close' }));
  expect([search.cleared, onClose.mock.calls.length, focus.mock.calls.length]).toEqual([2, 2, 2]);
});

test('the counter reads "{n} of {total}", "no results", 1000+ past the highlight limit, and nothing for an empty field (#12)', () => {
  expect(counterText('fail', { resultIndex: 2, resultCount: 5 })).toBe('3 of 5');
  expect(counterText('fail', { resultIndex: -1, resultCount: 0 })).toBe('no results');
  expect(counterText('fail', { resultIndex: -1, resultCount: 1000 })).toBe('1000+');
  expect(counterText('', { resultIndex: 2, resultCount: 5 })).toBe('');
  expect(counterText('fail', undefined)).toBe('');
  setLanguage('pt');
  expect(counterText('fail', { resultIndex: 2, resultCount: 5 })).toBe('3 de 5');
  expect(counterText('fail', { resultIndex: -1, resultCount: 0 })).toBe('sem resultados');
});

test('a new press of the binding with the bar open focuses the field again and selects its text; so does the binding in the field (#12)', async () => {
  const user = userEvent.setup();
  const { view } = harness();
  const { rerender } = render(view(true, 1));
  await user.type(field(), 'warn');
  act(() => field().blur());
  rerender(view(true, 2));
  expect(field()).toHaveFocus();
  expect(selected(field())).toBe('warn');
  await user.keyboard('{ArrowRight}');
  expect(selected(field())).toBe('');
  await user.keyboard('{Control>}{Shift>}F{/Shift}{/Control}'); // jsdom runs as off macOS: the binding is Ctrl+Shift+F
  expect(selected(field())).toBe('warn');
  expect(field()).toHaveValue('warn');
});

test('a theme switch with matches shown searches again, in the new colours (#12)', async () => {
  const { search, view } = harness('fail');
  render(view(true, 1));
  document.documentElement.setAttribute('data-theme', 'light');
  await vi.waitFor(() => expect(search.cleared).toBe(1));
  expect(search.calls.at(-1)).toEqual(['next', 'fail', true]);
});
