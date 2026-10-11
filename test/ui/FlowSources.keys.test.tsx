import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { FlowShownContext } from '@/components/MainDock';
import { FlowSources, type SourcesNav } from '@/components/FlowSources';
import { setLanguage, t } from '@/i18n';

const nav: SourcesNav = {
  auth: 'cli',
  sources: [
    { name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' },
    { name: 'core', qualifyId: false, type: 'github', owner: 'acme', number: 2, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' },
  ],
};
// Alt types a symbol on macOS, so the digit is read from code (#585)
const alt = (digit: number, target: Window | Element = window): boolean => fireEvent.keyDown(target, { key: '™', code: `Digit${digit}`, altKey: true });

beforeEach(() => setLanguage('pt'));

test('Alt+1 picks hive, Alt+2–9 the configured sources in order and Alt+0 all of them; a digit with no row does nothing (#585, #665)', () => {
  const onPick = vi.fn();
  render(<FlowSources nav={nav} tasks={[]} onPick={onPick} />);
  expect(alt(1)).toBe(false);
  expect(alt(3)).toBe(false);
  alt(0);
  expect(alt(4)).toBe(true); // two sources: Alt+2 and Alt+3
  expect(onPick.mock.calls).toEqual([['hive'], ['core'], [undefined]]);
});

test('with no source configured, Alt+1 still picks hive and Alt+2 does nothing (#665)', () => {
  const onPick = vi.fn();
  render(<FlowSources nav={{ auth: 'cli', sources: [] }} tasks={[]} onPick={onPick} />);
  expect(alt(1)).toBe(false);
  expect(alt(2)).toBe(true);
  expect(onPick.mock.calls).toEqual([['hive']]);
});

test('no pick with a text field focused, nor while the flow is hidden (#585)', async () => {
  const onPick = vi.fn();
  const { unmount } = render(<FlowSources nav={nav} tasks={[]} onPick={onPick} />);
  await userEvent.setup().click(screen.getByRole('button', { name: t('flow.sources.filter') }));
  alt(1, screen.getByRole('textbox', { name: t('flow.sources.search') }));
  unmount();
  render(<FlowShownContext.Provider value={false}><FlowSources nav={nav} tasks={[]} onPick={onPick} /></FlowShownContext.Provider>);
  alt(1);
  expect(onPick).not.toHaveBeenCalled();
});

test('no pick from inside an open dialog, even on one of its buttons (#585)', () => {
  const onPick = vi.fn();
  render(<><FlowSources nav={nav} tasks={[]} onPick={onPick} /><div role="dialog"><button type="button">ok</button></div></>);
  alt(1, screen.getByRole('button', { name: 'ok' }));
  expect(onPick).not.toHaveBeenCalled();
});

// jsdom's platform is not macOS: the hint reads Alt+n there, ⌥n on a Mac (#500)
const hintOf = (row: HTMLElement): string | null => row.querySelector('[data-key-hint]')?.textContent ?? null;
const sourceRow = (name: string): HTMLElement => screen.getByText(name).closest('[role="button"]') as HTMLElement;
const hiveRow = (): HTMLElement | null => screen.queryByRole('button', { name: /^hive/ });

test('each row shows its pick key before its count: todas Alt+0, hive Alt+1, then the sources by config order from Alt+2 (#500, #665)', () => {
  render(<FlowSources nav={nav} tasks={[]} onPick={vi.fn()} />);
  expect(hintOf(screen.getByRole('button', { name: /todas/ }))).toBe('Alt+0');
  expect(hintOf(hiveRow()!)).toBe('Alt+1');
  expect(hintOf(sourceRow('board'))).toBe('Alt+2');
  expect(hintOf(sourceRow('core'))).toBe('Alt+3');
});

test('a source past the eighth shows no key: hive holds Alt+1 (#500, #665)', () => {
  const many: SourcesNav = { auth: 'cli', sources: Array.from({ length: 10 }, (_, i) => ({ ...nav.sources[0], name: `s${i + 1}` })) };
  render(<FlowSources nav={many} tasks={[]} onPick={vi.fn()} />);
  expect(hintOf(sourceRow('s8'))).toBe('Alt+9');
  expect(hintOf(sourceRow('s9'))).toBeNull();
});

test('filtering keeps each row on its key, and matches hive by its name like any source (#500, #665)', async () => {
  const user = userEvent.setup();
  render(<FlowSources nav={nav} tasks={[]} onPick={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: t('flow.sources.filter') }));
  const field = screen.getByRole('textbox', { name: t('flow.sources.search') });
  await user.type(field, 'core');
  expect(screen.queryByText('board')).toBeNull();
  expect(hiveRow()).toBeNull();
  expect(hintOf(sourceRow('core'))).toBe('Alt+3');
  await user.clear(field);
  await user.type(field, 'hi');
  expect(hintOf(hiveRow()!)).toBe('Alt+1');
  expect(screen.queryByText('core')).toBeNull();
});

test('+ beside filtrar adds a source through onAdd, and is absent without it (#500)', async () => {
  const onAdd = vi.fn();
  const { unmount } = render(<FlowSources nav={{ ...nav, onAdd }} tasks={[]} onPick={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole('button', { name: t('flow.sources.add') }));
  expect(onAdd).toHaveBeenCalledOnce();
  unmount();
  render(<FlowSources nav={nav} tasks={[]} onPick={vi.fn()} />);
  expect(screen.queryByRole('button', { name: t('flow.sources.add') })).toBeNull();
});

// The hints line up in one column (#671): a bordered key cap, a fixed-width count, and the ⋯ slot kept on a row with no menu
test('the pick key is a key cap and todas keeps the menu slot, so every row lines up (#671)', () => {
  render(<FlowSources nav={nav} tasks={[]} onPick={vi.fn()} />);
  const all = screen.getByRole('button', { name: /todas/ });
  expect(all.querySelector('[data-key-hint]')?.tagName).toBe('KBD');
  expect(all.querySelector('[data-menu-slot]')).not.toBeNull();
  expect(sourceRow('board').querySelector('[data-key-hint]')?.tagName).toBe('KBD');
});

test('with hive off there is no hive row and the configured sources start at Alt+1 (#846)', () => {
  const onPick = vi.fn();
  render(<FlowSources nav={{ ...nav, hiveSource: false }} tasks={[]} onPick={onPick} />);
  expect(hiveRow()).toBeNull();
  expect(hintOf(sourceRow('board'))).toBe('Alt+1');
  expect(hintOf(sourceRow('core'))).toBe('Alt+2');
  alt(1);
  alt(2);
  expect(alt(3)).toBe(true);
  expect(onPick.mock.calls).toEqual([['board'], ['core']]);
});
