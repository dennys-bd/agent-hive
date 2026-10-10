import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: 'x' }], tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [],
  usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT,
  approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};

// Kept apart: Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))); });

test('M on a focused task opens its right-click menu (#585)', async () => {
  render(<Flow state={state} />);
  fireEvent.keyDown(screen.getByText('#1 Task 1').closest('li')!, { key: 'm' });
  expect(await screen.findByRole('menuitem', { name: 'executar etapas…' })).toBeInTheDocument();
});
