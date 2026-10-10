import { fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useWindowKeys } from '@/hooks/use-window-keys';
import type { EffectiveLimits } from '../../src/types';

afterEach(() => vi.unstubAllGlobals());

// jsdom runs as off macOS: closeWindow is Ctrl+Alt+Shift+W there (#585)
const closeKey = (): boolean => fireEvent.keyDown(window, { key: 'W', code: 'KeyW', ctrlKey: true, altKey: true, shiftKey: true });

test('the closeWindow key closes the window through the bridge, only while the window\'s keys are on (#585)', () => {
  const closeWindow = vi.fn(async () => undefined);
  vi.stubGlobal('hive', { closeWindow });
  const { rerender, unmount } = renderHook(({ isOn }) => useWindowKeys(isOn), { initialProps: { isOn: false } });
  expect(closeKey()).toBe(true);
  expect(closeWindow).not.toHaveBeenCalled();
  rerender({ isOn: true });
  expect(closeKey()).toBe(false);
  expect(closeWindow).toHaveBeenCalledOnce();
  unmount();
});

test('Ctrl+Shift+1–3 set the signal green, yellow and red off macOS; one looser than a fired rule\'s floor is not set, as the toggle disables it (#585)', async () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const floor: EffectiveLimits = { signal: 'yellow', floor: { signal: 'yellow' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} };
  renderHook(() => useWindowKeys(true, floor));
  const digit = (n: number): boolean => fireEvent.keyDown(window, { key: '!', code: `Digit${n}`, ctrlKey: true, shiftKey: true });
  digit(1);
  digit(3);
  expect(digit(4)).toBe(true); // no fourth signal
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith('/signal', expect.objectContaining({ method: 'POST', body: JSON.stringify({ signal: 'red' }) }));
});
