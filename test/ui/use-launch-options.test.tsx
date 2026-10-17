import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useLaunchOptions } from '@/hooks/use-launch-options';

const fetchMock = vi.fn(async (_path: string) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('with no workspace yet the hook asks for no list: /launch-options answers 400 without one, and the fields keep their defaults (#317)', () => {
  const { result } = renderHook(() => useLaunchOptions(undefined));
  expect(result.current).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
