import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TaskList } from '@/components/tasks/TaskList';
import { useDisplayOptions } from '@/hooks/use-flow-view';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import { flatten } from '../../src/flows';
import type { BaseOptions, Flow, Item, Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';

// The list row's task menu (#577 decision 10). Its own file: Radix's ContextMenu opens once per file under jsdom, and a userEvent click in an
// earlier test of the same file keeps it from opening.
const stage = (name: string): Stage => ({ name, from: {}, prompt: '/hive-build {url}' });
const FLOWS: Flow[] = [{ name: 'feature', stages: [stage('spec'), stage('build')], transitions: [] }];
const task = (id: string, at?: string, item: Partial<Item> = {}, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...item }, ...(at === undefined ? {} : { stage: at }), boardColumn: 'Ready', auto: true, ...extra,
});
const state = (tasks: WithWork[], workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], flows: FLOWS, ...flatten(FLOWS), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
function Harness({ state: s, onOpen }: { state: State; onOpen?(taskId: string): void }) {
  const display = useDisplayOptions();
  return <TaskList state={s} display={display} onOpen={onOpen} />;
}
const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`tr[data-task-id="${id}"]`)!;
const bases: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: [], remote: [] }; // what the Start dialog reads
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).endsWith('/bases') ? bases : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); resetViewState(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => { resetViewState(); vi.unstubAllGlobals(); });

test('right-click opens the task menu around the row, the flow\'s variant for a task in a flow (#577 decision 10)', async () => {
  render(<Harness state={state([task('1', 'spec')])} />);
  fireEvent.contextMenu(row('I1'));
  expect(await screen.findByRole('menuitem', { name: 'executar etapas…' })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^tirar do fluxo/ })).toBeInTheDocument();
});
