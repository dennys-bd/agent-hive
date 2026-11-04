vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);
vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/use-hive-state', async () => ({ useHiveState: (await import('./detached-state')).hiveState }));
vi.mock('@/hooks/use-settings-info', async () => ({ useSettingsInfo: (await import('./detached-state')).settingsInfo }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

import { act, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as models from '@/lib/editor-models';
import type { CenterTabRef } from '../../src/tab-carry';
import { DetachedWindow } from '@/DetachedWindow';
import { strips } from './center-harness';
import { box } from './detached-state';
import { arrive, type Bridge, mount, resetDetachedTest, setUpDetachedTest, stateOf } from './detached-harness';
import { resetMonacoFakes } from './monaco-fake';

const FILE: CenterTabRef = { kind: 'file', path: 'src/a.ts' };
const DIFF: CenterTabRef = { kind: 'diff', scope: 'worktree' };
const CARRY = { text: 'mine\n', base: 'v1' };
let bridge: Bridge;

beforeEach(() => { bridge = setUpDetachedTest(); vi.mocked(toast.error).mockClear(); });
afterEach(() => { models.closeExcept(new Set()); resetMonacoFakes(); resetDetachedTest(); });

test('window:closing with two tabs, one dirty, docks each in the layout\'s order, the dirty one with its carry, then closes the window (#553)', async () => {
  mount();
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  await arrive(bridge, { activity: 'I1', ref: FILE, carry: CARRY });
  await act(async () => { bridge.closing(); });
  await waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledTimes(1));
  expect(bridge.dock.mock.calls).toEqual([[{ activity: 'I1', ref: DIFF }], [{ activity: 'I1', ref: FILE, carry: expect.objectContaining(CARRY) }]]);
});

test('a refused dock during window:closing stops it: both tabs stay, the toast shows, and the window does not close (#553)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  bridge.dock.mockRejectedValueOnce(new Error('aba inválida'));
  mount();
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  await arrive(bridge, { activity: 'I1', ref: FILE, carry: CARRY });
  await act(async () => { bridge.closing(); });
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect([bridge.dock.mock.calls.length, strips(), bridge.closeWindow.mock.calls.length]).toEqual([1, [['diff da worktree', 'a.ts']], 0]);
});

test('⌘W on the last tab closes it, and the emptied window closes; nothing closes before the first tab arrived (#553, #585)', async () => {
  mount();
  await act(async () => undefined);
  expect(bridge.closeWindow).not.toHaveBeenCalled();
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  act(() => bridge.closeKey());
  await waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledTimes(1));
  expect(bridge.dock).not.toHaveBeenCalled();
});

test('a State that no longer lists the activity closes the window without docking (#553)', async () => {
  const { rerender } = mount();
  await arrive(bridge, { activity: 'I1', ref: DIFF });
  box.state = stateOf([]);
  rerender(<DetachedWindow activity="I1" />);
  await waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledTimes(1));
  expect(bridge.dock).not.toHaveBeenCalled();
});
