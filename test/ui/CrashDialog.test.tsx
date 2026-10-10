import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CrashDialog } from '@/components/CrashDialog';
import { setLanguage } from '@/i18n';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import type { WithWork } from '../fixtures/work';

const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, stopped: true };
const state: State = {
  signal: 'yellow', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [{ id: 's1', status: 'empty' }], terminals: [], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: 'x' }],
  tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the crash popup lists each task a crash stopped by its label and a click selects it; closing it posts the dismissal (#283)', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<CrashDialog state={{ ...state, crash: { at: '2026-09-25T10:00:00.000Z', tasks: ['I1', 'gone'] } }} onSelect={onSelect} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('A Hive não fechou direito. Estas tarefas estavam executando e ficaram paradas:');
  await user.click(screen.getByRole('button', { name: '#1 Task 1' }));
  expect(onSelect).toHaveBeenCalledWith('I1');
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/crash/dismiss', expect.objectContaining({ method: 'POST' }));
});

test('no crash, no popup (#283)', () => {
  render(<CrashDialog state={state} onSelect={() => {}} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
