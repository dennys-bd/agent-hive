import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { type WithWork, movedWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom, and the confirm's pick closes it for good.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt' };
const state: State = movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ removed: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('excluir atividade… reads destructive, confirms with what the deleteActivity scope removes and posts delete-activity: the task stays (#182, #542)', async () => {
  render(<Flow state={state} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  const item = await screen.findByRole('menuitem', { name: 'excluir atividade…' });
  expect(item).toHaveClass('text-destructive');
  fireEvent.click(item);
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'excluir atividade' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/delete', expect.objectContaining({ method: 'POST' })));
});
