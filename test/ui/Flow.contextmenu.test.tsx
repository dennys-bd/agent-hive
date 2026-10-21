import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Stage, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Kept apart from Flow.test.tsx (#164): Radix's ContextMenu never shows content again once closed, under jsdom — reproduced with
// a bare `radix-ui` ContextMenu, no app code involved, closed by selecting an item or by Escape either one. It is not specific to a
// second contextmenu open either: any earlier Dialog / DropdownMenu / Popover interaction in the same file (all share Radix's
// `DismissableLayer` module state) already exhausts it, which is what Flow.test.tsx's own many dialog and dropdown tests do. So
// this file holds nothing else and opens the menu exactly once; every further state below is reached through `rerender`, which a
// still-open menu picks up like any other prop change (proven: rerendering with different props never closes it on its own).

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const task = (id: string, stage: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}` }, stage, boardColumn: 'Ready', auto: true, ...extra,
});
const worker = (id: string, taskId?: string): Worker => ({ id, status: taskId ? 'working' : 'empty', ...(taskId ? { activityId: activityIdOf(taskId) } : {}) });
const manualWorker = (id: string, runId: string): Worker => ({ id, status: 'working', activityId: activityIdOf('I1'), runId: runId, freeSession: true });
const state = (tasks: WithWork[], workers: Worker[], cols: Stage[] = stages, sourceOrder: string[] = []): State =>
  withPointedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: workers.length, workers, stages: cols, tasks, sourceOrder, localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] });

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

// Radix opens a ContextMenu on the contextmenu event, which fireEvent delivers in jsdom.
const openTaskMenu = (text: string): void => { fireEvent.contextMenu(screen.getByText(text).closest('li')!); };

// fireEvent.click reaches a menu item nested in a submenu under jsdom, where userEvent.click does not; the mover para etapa → review click below closes the one usable menu, so it comes last.
test('right-click on a task offers começar sozinho, checked unless manual; mover para etapa on any task lists the other stages, is disabled while a stage run holds the task but not while a session is open on it, and posts move-to; a missing task has no menu (#164, #366, #542, #708)', async () => {
  const user = userEvent.setup();
  const stageRun: Worker = { id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'bbbbbbbb-0000-4000-8000-000000000002' };
  const autoStart = (): HTMLElement => screen.getByRole('menuitemcheckbox', { name: 'começar sozinho' });
  const { rerender } = render(<Flow state={state([task('1', 'dev')], [worker('s1')])} />);
  openTaskMenu('#1 Task 1');
  expect(screen.getByRole('menuitem', { name: 'mover para etapa' })).not.toHaveAttribute('data-disabled'); // a source task with auto on moves too (#708)
  expect(autoStart()).toHaveAttribute('aria-checked', 'true');

  rerender(<Flow state={state([task('1', 'dev', { workerId: 's1' })], [stageRun])} />);
  expect(screen.getByRole('menuitem', { name: 'mover para etapa' })).toHaveAttribute('data-disabled'); // auto on: its stage run holds it (#708)

  rerender(<Flow state={state([task('1', 'dev', { created: true })], [worker('s1')])} />);
  expect(screen.getByRole('menuitem', { name: 'mover para etapa' })).not.toHaveAttribute('data-disabled'); // created in the Hive, not manual (#366)

  rerender(<Flow state={state([task('1', 'dev', { created: true, workerId: 's1' })], [stageRun])} />);
  expect(screen.getByRole('menuitem', { name: 'mover para etapa' })).toHaveAttribute('data-disabled'); // its stage run holds it

  rerender(<Flow state={state([task('1', 'dev', { auto: false })], [worker('s1')])} />);
  expect(autoStart()).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('menuitem', { name: 'mover para etapa' })).not.toHaveAttribute('data-disabled');

  rerender(<Flow state={state([task('1', 'dev', { auto: false })], [manualWorker('m1', 'aaaaaaaa-0000-4000-8000-000000000001')])} />);
  expect(screen.getByRole('menuitem', { name: 'mover para etapa' })).not.toHaveAttribute('data-disabled'); // a session is the user's own (#366)

  rerender(<Flow state={state([task('1', 'dev', { auto: false })], [worker('s1')])} />);
  await user.click(screen.getByRole('menuitem', { name: 'mover para etapa' })); // if jsdom does not open it on click: focus it and press {ArrowRight}
  const review = await screen.findByRole('menuitem', { name: 'review' });
  expect(screen.queryByRole('menuitem', { name: 'dev' })).not.toBeInTheDocument(); // its own stage is not a target
  fireEvent.click(review);
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'review' }) })));

  rerender(<Flow state={state([task('1', 'dev', { missing: true })], [worker('s1')])} />);
  expect(screen.getByText('#1 Task 1').closest('li')).not.toHaveAttribute('data-slot', 'context-menu-trigger'); // a missing task gets no menu wrapper
});
