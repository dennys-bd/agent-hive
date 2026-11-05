import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { FlowShownContext } from '@/components/MainDock';
import { FlowSources, type FlowSourcesProps, type SourcesNav } from '@/components/FlowSources';
import { setLanguage } from '@/i18n';

const nav: SourcesNav = {
  auth: 'cli',
  sources: [
    { name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flow: 'main' } }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' },
    { name: 'core', qualifyId: false, type: 'github', owner: 'acme', number: 2, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flow: 'main' } }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' },
  ],
};
// Alt types a symbol on macOS, so the digit is read from code (#585)
const alt = (digit: number, target: Window | Element = window): boolean => fireEvent.keyDown(target, { key: '™', code: `Digit${digit}`, altKey: true });

beforeEach(() => setLanguage('pt'));

// the handlers stay mocks (a spread of Partial<FlowSourcesProps> would widen them to their plain type)
const renderSources = (over: Partial<Pick<FlowSourcesProps, 'nav'>> = {}) => {
  const props = { onPick: vi.fn(), onList: vi.fn(), onOnly: vi.fn() };
  render(<FlowSources nav={nav} tasks={[]} {...props} {...over} />);
  return props;
};
const tipOf = (name: string): string | null => screen.getByText(name).closest('[title]')?.getAttribute('title') ?? null;

test('Alt+1 opens hive, Alt+2–9 the configured sources in order and Alt+0 the list; a digit with no row does nothing (#585, #665, #572)', () => {
  const { onPick, onList } = renderSources();
  expect([alt(1), alt(3), alt(0)]).toEqual([false, false, false]);
  expect(alt(4)).toBe(true); // two sources: Alt+2 and Alt+3
  expect(onPick.mock.calls).toEqual([['hive'], ['core']]);
  expect(onList).toHaveBeenCalledOnce();
});

test('with no source configured, Alt+1 still opens hive and Alt+2 does nothing (#665)', () => {
  const { onPick } = renderSources({ nav: { auth: 'cli', sources: [] } });
  expect(alt(1)).toBe(false);
  expect(alt(2)).toBe(true);
  expect(onPick.mock.calls).toEqual([['hive']]);
});

test('no key with a text field focused, nor while the tasks view is hidden (#585)', () => {
  const onPick = vi.fn();
  const onList = vi.fn();
  const { unmount } = render(<><input aria-label="campo" /><FlowSources nav={nav} tasks={[]} onPick={onPick} onList={onList} onOnly={vi.fn()} /></>);
  alt(1, screen.getByRole('textbox', { name: 'campo' }));
  alt(0, screen.getByRole('textbox', { name: 'campo' }));
  unmount();
  render(<FlowShownContext.Provider value={false}><FlowSources nav={nav} tasks={[]} onPick={onPick} onList={onList} onOnly={vi.fn()} /></FlowShownContext.Provider>);
  alt(1);
  alt(0);
  expect([onPick.mock.calls, onList.mock.calls]).toEqual([[], []]);
});

test('no key from inside an open dialog, even on one of its buttons (#585)', () => {
  const onPick = vi.fn();
  render(<><FlowSources nav={nav} tasks={[]} onPick={onPick} onList={vi.fn()} onOnly={vi.fn()} /><div role="dialog"><button type="button">ok</button></div></>);
  alt(1, screen.getByRole('button', { name: 'ok' }));
  expect(onPick).not.toHaveBeenCalled();
});

test('each row names its key in its tooltip and shows no key cap: hive Alt+1, then the sources by config order from Alt+2 (#500, #665, #572)', () => {
  renderSources();
  expect([tipOf('hive'), tipOf('board'), tipOf('core')]).toEqual(['hive · Alt+1', 'board · acme · Alt+2', 'core · acme · Alt+3']);
  expect(document.querySelector('[data-key-hint]')).toBeNull();
});

test('a source past the eighth names no key: hive holds Alt+1 (#500, #665)', () => {
  renderSources({ nav: { auth: 'cli', sources: Array.from({ length: 10 }, (_, i) => ({ ...nav.sources[0], name: `s${i + 1}` })) } });
  expect(tipOf('s8')).toBe('s8 · acme · Alt+9');
  expect(tipOf('s9')).toBe('s9 · acme');
});

test('with hive off there is no hive row and the configured sources start at Alt+1 (#846)', () => {
  const { onPick } = renderSources({ nav: { ...nav, hiveSource: false } });
  expect(screen.queryByText('hive')).toBeNull();
  expect(tipOf('board')).toBe('board · acme · Alt+1');
  alt(1);
  alt(2);
  expect(alt(3)).toBe(true);
  expect(onPick.mock.calls).toEqual([['board'], ['core']]);
});
