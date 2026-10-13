import { screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import type { LiveRun } from '../../src/task-runs';
import { ActivityCenter } from '@/components/ActivityCenter';
import type { PaneContext } from '@/components/PaneHeader';
import type { TabRequest } from '@/hooks/use-activity';
import { useCenterLayouts } from '@/hooks/use-center-layouts';
import { setLanguage } from '@/i18n';
import type { Activity, ActivitySession, SleepingRun, TaskActivitySession } from '@/lib/activities';
import type { CenterLayout } from '@/lib/center-layout';
import { readView, resetViewState } from '@/lib/view-state';
import type { Session, Task } from '../../src/types';
import { localPairOf, taskPairOf } from '../fixtures/work';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

// The center's test harness (#458), shared by ActivityCenter.test.tsx and the ActivityCenter.menu-*.test.tsx files: Radix's ContextMenu opens
// once per file under jsdom (see Flow.contextmenu.test.tsx), so each menu pick needs a file of its own. Every file that imports this one
// declares its own vi.mock of @xterm/xterm and @xterm/addon-fit: vitest hoists a mock per test file.
export const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
// Labels as task-runs.ts names them (#489): what runs in the run, not its kind.
export const STAGE: LiveRun = { ptyId: 'W1', label: 'Claude', kind: 'stage' };
export const SESSION: LiveRun = { ptyId: 'W2', label: 'Claude · abcdef12', kind: 'session' };
export const SHELL: LiveRun = { ptyId: 'W3', label: 'Terminal', kind: 'terminal' };
export const openShell: TabRequest = { tab: { kind: 'run', ptyId: 'W3' } };
/** g1 [W1] beside g2 [W2], half and half, g1 focused. */
export const SIDE_BY_SIDE: CenterLayout = {
  root: {
    kind: 'split', axis: 'row', sizes: [50, 50], children: [
      { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }], active: 0 },
      { kind: 'group', id: 'g2', tabs: [{ kind: 'run', ptyId: 'W2' }], active: 0 },
    ],
  },
  focused: 'g1',
};

/** The center as MainDock drives it: the task's activity, or with `local` that workspace's local activity (#590), with these runs, sessions
 * and sleeping runs (#672), its layout from useCenterLayouts, a request to apply, and the pane context the Dashboard would hand it. */
export function Center({ runs, request, sessions = [], slept = [], keptSessions = [], pane, local, onOpenRun = () => undefined }: { runs: LiveRun[]; request?: TabRequest; sessions?: ActivitySession[]; slept?: SleepingRun[]; keptSessions?: Session[]; pane?: PaneContext; local?: string; onOpenRun?: (ptyId: string) => void }) {
  const asleep = keptSessions.map((session): TaskActivitySession => ({ session, status: 'empty' })); // #696: kept sessions no run holds
  const activity: Activity = local === undefined
    ? { kind: 'task', ...taskPairOf('I1'), task, runs, sessions: [...sessions, ...asleep], slept, status: 'working', worker: true }
    : { kind: 'local', ...localPairOf(local), workspace: local, runs, sessions, kept: keptSessions.map((session) => ({ session, status: 'empty' as const })), slept };
  const layouts = useCenterLayouts([activity], activity, request);
  return <ActivityCenter activity={activity} layout={layouts.layout} ops={layouts} fileLinks={false} fontFamily="ui-monospace, monospace" pane={pane} onOpenRun={onOpenRun} />;
}

/** Every group's tab strip in reading order, as the texts of its tabs. */
export const strips = (): string[][] =>
  screen.queryAllByRole('tablist', { name: 'abas' }).map((strip) => within(strip).getAllByRole('tab').map((tab) => tab.textContent ?? ''));
export const saved = (): Record<string, CenterLayout> => (readView('centerLayouts') ?? {}) as Record<string, CenterLayout>;
export const seed = (layout: CenterLayout): void => resetViewState({ centerLayouts: { I1: layout } });

/** Every test file's beforeEach: Portuguese copy, nothing stored, fresh xterm fakes, a fetch that answers ok. Pair it with
 * `afterEach(() => vi.unstubAllGlobals())`. */
export function resetCenterTest(): void {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
}
