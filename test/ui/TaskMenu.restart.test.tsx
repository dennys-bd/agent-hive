import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { StartedTaskContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { movedWork, type WithWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom. reiniciar etapa… left the task face for the menu (#542).
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const sessions = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-25T10:00:00.000Z', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '2026-09-25T10:00:00.000Z' }];
const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true,
  stopped: true, stageStart: { stage: 'dev', commit: 'a1b2c3d' },
};
const state: State = movedWork<State>({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions }], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
  (String(input).endsWith('/restart') && init?.method !== 'POST' ? reply({ mode: 'reset', branch: 'hive/1-task-1', commits: 1, files: 2 }) : reply({ ok: true })));
const started = vi.fn();
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); started.mockClear(); });

test('reiniciar etapa… opens the restart dialog with the server\'s preview; the restart hands the task over once taken (#283, #457, #542, #580)', async () => {
  const user = userEvent.setup();
  render(<StartedTaskContext.Provider value={started}><Flow state={state} /></StartedTaskContext.Provider>);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'reiniciar etapa…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reiniciar etapa dev' });
  await within(dialog).findByText('1 commit · 2 arquivos · sessão aaaaaaaa');
  expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/restart');
  await user.click(within(dialog).getByRole('button', { name: 'descartar e reiniciar' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/restart', expect.objectContaining({ method: 'POST' })));
  await waitFor(() => expect(started).toHaveBeenCalledWith('I1'));
});
