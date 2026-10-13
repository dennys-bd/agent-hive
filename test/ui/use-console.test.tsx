import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useConsoleChannels, useConsoleOpener } from '@/hooks/use-console';
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

const emptyList = (): void => { vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))); };

test('show opens the drawer on a tab, switches to it from the other one and closes it when it is already shown; open never closes, close keeps the tab (#225)', async () => {
  emptyList();
  const { result } = renderHook(() => useConsoleChannels(''));
  const drawer = () => [result.current.isOpen, result.current.tab];
  expect(drawer()).toEqual([false, 'console']);
  act(() => result.current.show('problems'));
  expect(drawer()).toEqual([true, 'problems']);
  act(() => result.current.show('console'));
  expect(drawer()).toEqual([true, 'console']);
  act(() => result.current.show('console'));
  expect(drawer()).toEqual([false, 'console']);
  act(() => { result.current.open('problems'); result.current.open('problems'); });
  expect(drawer()).toEqual([true, 'problems']);
  act(() => result.current.close());
  expect(drawer()).toEqual([false, 'problems']);
  await waitFor(() => expect(result.current.channels).toEqual([]));
});

test('a channel opened with show selects it and lands on the console tab, even from problems (#225)', async () => {
  emptyList();
  const { result } = renderHook(() => { const channels = useConsoleChannels(''); return { channels, openConsole: useConsoleOpener(channels) }; });
  act(() => result.current.channels.open('problems'));
  act(() => result.current.openConsole('lsp:hive:ts', 'r1', true));
  expect(result.current.channels.selection).toEqual({ channel: 'lsp:hive:ts', ptyId: 'r1' });
  expect([result.current.channels.isOpen, result.current.channels.tab]).toEqual([true, 'console']);
  await waitFor(() => expect(result.current.channels.channels).toEqual([]));
});
