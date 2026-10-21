import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { movedWork, type WithWork } from '../fixtures/work';

// Its own file (#315, #685), like TaskMenu.approval.test.tsx: Radix's ContextMenu opens once per file under jsdom.
const stages: Stage[] = [{ name: 'gate', from: { board: ['Ready'] }, approval: true }]; // a manual gate: approval, no prompt
const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'gate', boardColumn: 'Ready', auto: true,
  approval: { since: '2026-09-26T10:00:00.000Z' },
};
const workers: Worker[] = [{ id: 's1', status: 'empty' }];
const state: State = movedWork<State>({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [task], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('the task menu on a task in a manual gate with no session at all offers Aprovar and Enviar feedback…, which opens the feedback dialog (#685)', async () => {
  render(<Flow state={state} onOpen={vi.fn()} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  expect(await screen.findByRole('menuitem', { name: 'aprovar' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'enviar feedback…' }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'enviar feedback…' })).toBeInTheDocument());
});
