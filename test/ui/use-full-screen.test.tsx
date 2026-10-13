import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useFullScreen } from '@/hooks/use-full-screen';

const asMac = (): void => { vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'); };
const root = (): HTMLElement => document.documentElement;

// window.hive as the preload exposes it: the state at load, and the one listener window:fullScreen calls
function fakeBridge(atLoad: boolean | Promise<boolean>) {
  let listener: ((on: boolean) => void) | undefined;
  const off = vi.fn();
  const isFullScreen = vi.fn(() => Promise.resolve(atLoad));
  vi.stubGlobal('hive', { isFullScreen, onFullScreen: vi.fn((callback: (on: boolean) => void) => { listener = callback; return off; }) });
  return { isFullScreen, off, send: (on: boolean): void => { act(() => listener?.(on)); } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  root().removeAttribute('data-fullscreen');
});

test('on macOS it reads the window\'s state at load, a window restored in full screen included, then follows each enter and leave, mirrored on the root; unmounted it unsubscribes (#295, #398)', async () => {
  asMac();
  const bridge = fakeBridge(true);
  const { result, unmount } = renderHook(() => useFullScreen());
  await waitFor(() => expect(result.current).toBe(true));
  expect(root()).toHaveAttribute('data-fullscreen');
  bridge.send(false);
  expect(result.current).toBe(false);
  expect(root()).not.toHaveAttribute('data-fullscreen');
  bridge.send(true);
  expect(result.current).toBe(true);
  unmount();
  expect(bridge.off).toHaveBeenCalledTimes(1);
});

test('an enter or leave that comes before the answer at load wins over it (#295)', async () => {
  asMac();
  let answer: (on: boolean) => void = () => {};
  const bridge = fakeBridge(new Promise<boolean>((resolve) => { answer = resolve; }));
  const { result } = renderHook(() => useFullScreen());
  bridge.send(true);
  await act(async () => answer(false));
  expect(result.current).toBe(true);
});

test('off macOS it is always full screen, the bridge never asked: the window has no buttons at the header\'s left (#295)', () => {
  const bridge = fakeBridge(false);
  const { result } = renderHook(() => useFullScreen());
  expect(result.current).toBe(true);
  expect(root()).toHaveAttribute('data-fullscreen');
  expect(bridge.isFullScreen).not.toHaveBeenCalled();
});

test('on macOS with no bridge (a plain browser) it is a window (#295)', () => {
  asMac();
  vi.stubGlobal('hive', undefined);
  const { result } = renderHook(() => useFullScreen());
  expect(result.current).toBe(false);
  expect(root()).not.toHaveAttribute('data-fullscreen');
});
