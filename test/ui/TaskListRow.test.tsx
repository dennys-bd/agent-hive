import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TaskList } from '@/components/tasks/TaskList';
import { useDisplayOptions } from '@/hooks/use-flow-view';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import { flatten } from '../../src/flows';
import type { BaseOptions, Flow, Item, Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// The list row's action, click and menu (#577 decisions 9, 10). Its own file: Radix's ContextMenu opens once per file under jsdom, and only
// the last test opens it.
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

test('the action is filled while the task waits for you or for an approval, outline otherwise (#577 decision 9)', () => {
  const waiting: Worker = { id: 's1', status: 'waiting', activityId: activityIdOf('I1'), runId: 'W1' };
  render(<Harness state={state([task('1', 'spec'), task('2', 'spec', {}, { approval: { since: '2026-11-05T10:00:00.000Z' } }), task('3', 'spec')], [waiting])} />);
  const action = (id: string): HTMLElement => within(row(id)).getByRole('button');
  expect(['I1', 'I2', 'I3'].map((id) => [action(id).textContent, action(id).getAttribute('data-variant')])).toEqual([['abrir', 'default'], ['aprovar', 'default'], ['iniciar', 'outline']]);
});

test('iniciar on a task outside the flow opens the Start dialog with its destination block, and the press never opens the task (#577 decision 9, #580)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<Harness state={state([task('1')])} onOpen={onOpen} />);
  await user.click(within(row('I1')).getByRole('button', { name: 'iniciar' }));
  expect(await screen.findByRole('radiogroup', { name: 'destino' })).toBeInTheDocument();
  expect(onOpen).not.toHaveBeenCalled();
});

test('a click on the row\'s free area opens the task in the details panel; the row is not draggable (#577 decision 10)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<Harness state={state([task('1', 'spec')])} onOpen={onOpen} />);
  await user.click(within(row('I1')).getByText('spec'));
  expect(onOpen).toHaveBeenCalledWith('I1');
  expect(row('I1')).not.toHaveAttribute('draggable');
});
