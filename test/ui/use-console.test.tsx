import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useConsoleChannels } from '@/hooks/use-console';
import { emitConsoleChange } from '@/lib/console-events';
import type { ChannelEntry } from '../../src/console';

const FORMAT: ChannelEntry = { id: 'format:hive:prettier', kind: 'format', label: 'hive · prettier', status: 'running' };
afterEach(() => vi.unstubAllGlobals());

test('the channel list is read again when the daemon says a channel or a run changed, with no pty involved (#780)', async () => {
  let listed: ChannelEntry[] = [];
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(listed), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useConsoleChannels(''));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(result.current.channels).toEqual([]);
  listed = [FORMAT];
  act(() => emitConsoleChange());
  await waitFor(() => expect(result.current.channels).toEqual([FORMAT]));
});
