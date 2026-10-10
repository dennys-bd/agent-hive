import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CloseTabContext, type CloseTabSettings, showCloseTabNotice } from '@/components/close-tab-notice';
import { resetViewState } from '@/lib/view-state';
import { Center, resetCenterTest, seed, SESSION, SHELL, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/components/close-tab-notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/close-tab-notice')>()), showCloseTabNotice: vi.fn(),
}));

const KEEP: CloseTabSettings = { closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true };
let closeKey: (() => void) | undefined;
const unsubscribe = vi.fn();
// What ⌘W does through the preload (#585, #612): the page's callback, or nothing when none is registered
const pressClose = (): void => {
  act(() => {
    closeKey?.();
  });
};

beforeEach(() => {
  resetCenterTest();
  resetViewState();
  closeKey = undefined;
  unsubscribe.mockClear();
  vi.mocked(showCloseTabNotice).mockClear();
  vi.stubGlobal('hive', { onCloseKey: (callback: () => void) => { closeKey = callback; return unsubscribe; } });
});
afterEach(() => vi.unstubAllGlobals());

const TWO_GROUPS = {
  root: {
    kind: 'split' as const, axis: 'row' as const, sizes: [50, 50], children: [
      { kind: 'group' as const, id: 'g1', tabs: [{ kind: 'run' as const, ptyId: 'W1' }, { kind: 'run' as const, ptyId: 'W3' }], active: 0 },
      { kind: 'group' as const, id: 'g2', tabs: [{ kind: 'run' as const, ptyId: 'W2' }], active: 0 },
    ],
  },
  focused: 'g2',
};

test('⌘W closes the shown tab of the group holding the keyboard focus (#585)', () => {
  seed(TWO_GROUPS);
  render(<CloseTabContext.Provider value={KEEP}><Center runs={[STAGE, SESSION, SHELL]} /></CloseTabContext.Provider>);
  act(() => screen.getByRole('tab', { name: /^Terminal/ }).focus());
  pressClose();
  expect(strips()).toEqual([['Terminal'], ['Claude · abcdef12']]);
});

test('with the focus outside the center, ⌘W closes the focused group\'s shown tab (#585)', () => {
  seed(TWO_GROUPS);
  render(<CloseTabContext.Provider value={KEEP}><Center runs={[STAGE, SESSION, SHELL]} /></CloseTabContext.Provider>);
  pressClose();
  expect(strips()).toEqual([['Claude', 'Terminal']]);
});

test('an agent session\'s tab closed by ⌘W asks for the close-tab notice as its X does (#585, #614)', () => {
  seed(TWO_GROUPS);
  render(<CloseTabContext.Provider value={KEEP}><Center runs={[STAGE, SESSION, SHELL]} /></CloseTabContext.Provider>);
  pressClose();
  expect(vi.mocked(showCloseTabNotice).mock.calls.at(-1)?.[0]).toMatchObject({ run: SESSION });
});

test('with no tab to close ⌘W does nothing, and unmounting unregisters (#585, #612)', () => {
  const { unmount } = render(<Center runs={[]} />);
  expect(closeKey).toBeDefined();
  pressClose();
  expect(strips()).toEqual([]);
  expect(showCloseTabNotice).not.toHaveBeenCalled();
  unmount();
  expect(unsubscribe).toHaveBeenCalled();
});
