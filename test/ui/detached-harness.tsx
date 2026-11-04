import { act, render } from '@testing-library/react';
import { type Mock, vi } from 'vitest';
import { DetachedWindow } from '@/DetachedWindow';
import { setLanguage } from '@/i18n';
import { resetViewState, setViewWrites } from '@/lib/view-state';
import type { MovedTab } from '../../src/tab-carry';
import type { State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { jsonResponse } from '../fakes';
import { flowed } from '../fixtures/main-flow.js';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';
import { box } from './detached-state';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

// The detached window's harness (#553), shared by the DetachedWindow.*.test.tsx files: each declares its own vi.mock of xterm, monaco,
// sonner and the two hooks, since vitest hoists a mock per file. Task I1 runs its stage, W1, in worker s1.
export const TASK: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const WORKER: Worker = { id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' };
export const ID = activityIdOf('I1'); // the models' key
export const stateOf = (tasks: WithWork[]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: tasks.length > 0 ? [WORKER] : [], ...flowed([{ name: 'dev', from: { board: ['Ready'] } }], []), tasks, sourceOrder: [], localCount: 0,
  benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {},
  workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT,
  rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
export const CHANNEL = { id: 'command:hive:test', kind: 'command', label: 'hive · test', status: 'done' };

// The daemon as the window's panes read it: the console's channels and one channel's view, a design's frame, a task reference, ok otherwise
export const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url === '/console') return jsonResponse([CHANNEL]);
  if (url.startsWith('/console/')) return jsonResponse({ status: 'done', history: 'ok\r\n', live: [] });
  if (url.includes('/design-frame')) return jsonResponse({ url: '/design-frame/tok/Landing.hv.html' });
  if (url.endsWith('/open-ref')) return jsonResponse({ taskId: 'board:I7' });
  return jsonResponse({ ok: true, files: [], version: 'v1' });
});

export interface Bridge {
  dock: Mock<(tab: MovedTab) => Promise<void>>; closeWindow: Mock<() => Promise<void>>; tabsChanged: Mock; openTask: Mock<(taskId: string) => Promise<void>>;
  open(tab: unknown): void; closing(): void; closeKey(): void;
}

// window.hive as the preload exposes it to a detached window (#552): the test delivers window:open, window:closing and ⌘W
export function stubBridge(): Bridge {
  const on = { open: (_tab: unknown): void => undefined, closing: (): void => undefined, closeKey: (): void => undefined };
  const fake = {
    dock: vi.fn(async (_tab: MovedTab) => undefined), closeWindow: vi.fn(async () => undefined), tabsChanged: vi.fn(), openTask: vi.fn(async (_taskId: string) => undefined),
    onOpen: (callback: (tab: unknown) => void) => { on.open = callback; },
    onClosing: (callback: () => void) => { on.closing = callback; },
    onCloseKey: (callback: () => void) => { on.closeKey = callback; return () => undefined; },
    onOpenFile: () => () => undefined, onFullScreen: () => () => undefined, isFullScreen: async () => false, saveDialog: vi.fn(async () => undefined),
  };
  vi.stubGlobal('hive', fake);
  return { ...fake, open: (tab) => on.open(tab), closing: () => on.closing(), closeKey: () => on.closeKey() };
}

/** Every file's beforeEach: Portuguese, main.tsx's write gate, fresh fakes, the task's State; pair it with resetDetachedTest after each. */
export function setUpDetachedTest(): Bridge {
  setLanguage('pt');
  resetViewState();
  setViewWrites(false);
  resetFakes();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  box.state = stateOf([TASK]);
  return stubBridge();
}

export function resetDetachedTest(): void {
  resetViewState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

export const mount = () => render(<DetachedWindow activity="I1" />);
export const arrive = async (bridge: Bridge, tab: MovedTab): Promise<void> => { await act(async () => { bridge.open(tab); }); };
