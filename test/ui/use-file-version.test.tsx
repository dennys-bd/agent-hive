import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useFileVersion, VERSION_POLL_MS } from '@/hooks/use-file-version';
import { jsonResponse } from '../fakes';

let answer: () => Response = () => jsonResponse({ version: 'v2' });
const fetchMock = vi.fn(async (_url: string) => answer());

beforeEach(() => {
  vi.useFakeTimers();
  answer = () => jsonResponse({ version: 'v2' });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('while shown it asks the file\'s version every 2 s and hands each one on; hidden, it stops (#717)', async () => {
  const onVersion = vi.fn();
  const { rerender } = renderHook(({ shown }) => useFileVersion('a-I1', 'src/a.ts', shown, onVersion), { initialProps: { shown: true } });
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS); });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/activities/a-I1/file-version?path=src%2Fa.ts']);
  expect(onVersion).toHaveBeenLastCalledWith('v2');
  rerender({ shown: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 3); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a window focus asks at once; a file gone answers null, and a failed read is dropped (#717)', async () => {
  const onVersion = vi.fn();
  renderHook(() => useFileVersion('a-I1', 'src/a.ts', true, onVersion));
  answer = () => jsonResponse({ error: 'file not found' }, 404);
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
  expect(onVersion).toHaveBeenLastCalledWith(null);
  answer = () => jsonResponse({ error: 'arquivo grande demais para o editor' }, 413);
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
  expect(onVersion).toHaveBeenCalledTimes(1);
});

test('a slow daemon never stacks requests: no new ask while one is in flight, the next once it answers (#717)', async () => {
  let release = (): void => undefined;
  fetchMock.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return jsonResponse({ version: 'v2' });
  });
  const onVersion = vi.fn();
  renderHook(() => useFileVersion('a-I1', 'src/a.ts', true, onVersion));
  await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 3); window.dispatchEvent(new Event('focus')); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { release(); await vi.advanceTimersByTimeAsync(VERSION_POLL_MS); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(onVersion).toHaveBeenCalledWith('v2');
});
