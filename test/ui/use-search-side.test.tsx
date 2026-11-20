import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SEARCH_MIN_PX, useSearchSide, widenedSize } from '@/hooks/use-search-side';
import { editorSelection, selectionSeed, setSearchPane, useSearchPane } from '@/lib/search-query';

const loadMonaco = vi.hoisted(() => vi.fn());
vi.mock('@/lib/editor-models', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/editor-models')>()), loadMonaco }));

test('widenedSize widens a side under 320px to it, clamped, and leaves a wide enough or unmeasurable one', () => {
  expect(SEARCH_MIN_PX).toBe(320);
  expect(widenedSize(30, 1000)).toBe(32);
  expect(widenedSize(40, 1000)).toBeUndefined();
  expect(widenedSize(15, 1000)).toBe(32);
  expect(widenedSize(15, 400)).toBe(70);
  expect(widenedSize(20, 0)).toBeUndefined();
});

test('selectionSeed takes a non-empty single line only', () => {
  expect(selectionSeed('daemonPort')).toBe('daemonPort');
  expect(selectionSeed('a\nb')).toBeUndefined();
  expect(selectionSeed('')).toBeUndefined();
  expect(selectionSeed(undefined)).toBeUndefined();
});

test('editorSelection answers undefined without loading Monaco when no editor holds the focus', async () => {
  await expect(editorSelection()).resolves.toBeUndefined();
  expect(loadMonaco).not.toHaveBeenCalled();
});

const activate = vi.fn();
const setSideTab = vi.fn();
const resize = vi.fn();
type Args = Parameters<typeof useSearchSide>[0];
const args = (extra: Partial<Args> = {}): Args => ({ isOn: true, sideTab: 'files', setSideTab, activate, size: 20, isShown: true, resize, ...extra });
const press = (key: string): void => { window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); };
const flush = (): Promise<void> => new Promise((done) => setTimeout(done));

let frame: HTMLDivElement;
beforeEach(() => {
  activate.mockReset(); setSideTab.mockReset(); resize.mockReset();
  setSearchPane({ isReplaceOpen: false, focusAt: 0 });
  frame = document.createElement('div');
  frame.setAttribute('data-dock-frame', '');
  Object.defineProperty(frame, 'clientWidth', { value: 1000 });
  document.body.append(frame);
});
afterEach(() => { frame.remove(); });

test('Ctrl+Shift+F opens busca with the field focused, Ctrl+Shift+H with the replace field too', async () => {
  const { result } = renderHook(() => ({ side: useSearchSide(args()), pane: useSearchPane() }));
  press('F');
  await flush();
  expect(activate).toHaveBeenCalledWith('detail');
  expect(setSideTab).toHaveBeenCalledWith('search');
  expect(result.current.pane).toMatchObject({ isReplaceOpen: false, focusAt: 1 });
  press('H');
  await flush();
  expect(result.current.pane).toMatchObject({ isReplaceOpen: true, focusAt: 2 });
});

test('with no activity open neither key does anything', async () => {
  renderHook(() => useSearchSide(args({ isOn: false })));
  press('F');
  press('H');
  await flush();
  expect(activate).not.toHaveBeenCalled();
  expect(setSideTab).not.toHaveBeenCalled();
});

test('a side under 320px widens once when busca shows; a later drag and a return to busca keep the user\'s size', () => {
  const { rerender } = renderHook((props: Args) => useSearchSide(props), { initialProps: args() });
  expect(resize).not.toHaveBeenCalled();
  rerender(args({ sideTab: 'search' }));
  expect(resize).toHaveBeenCalledExactlyOnceWith('right', 32);
  rerender(args({ sideTab: 'search', size: 25 }));
  expect(resize).toHaveBeenCalledOnce();
  rerender(args({ sideTab: 'files', size: 40 }));
  rerender(args({ sideTab: 'search', size: 40 }));
  expect(resize).toHaveBeenCalledOnce();
});
