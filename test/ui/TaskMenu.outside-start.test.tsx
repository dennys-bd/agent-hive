import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskMenu } from '@/components/TaskMenu';
import { setLanguage } from '@/i18n';
import type { BaseOptions, Stage, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

// Its own file: Radix's ContextMenu opens once per file under jsdom, and the pick closes it. A task outside the flow (#566) is on no flowchart,
// so the menu wraps a bare card.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const OUTSIDE: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, boardColumn: 'Ready', auto: true }; // no stage
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed(stages, []), tasks: [OUTSIDE], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, semaphores: {}, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const openMenu = (): void => {
  render(<TaskMenu task={OUTSIDE} state={state}><li>card</li></TaskMenu>);
  fireEvent.contextMenu(screen.getByText('card'));
};
beforeEach(() => {
  setLanguage('pt');
  const bases: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: [], remote: [] }; // the Start dialog reads them when it opens
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/bases') ? bases : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

test('outside the flow, executar etapas… opens the Start dialog as in the flow, with its destination block (#576 decision 14, #580)', async () => {
  const user = userEvent.setup();
  openMenu();
  await user.click(await screen.findByRole('menuitem', { name: 'executar etapas…' }));
  expect(await screen.findByRole('radiogroup', { name: 'destino' })).toBeInTheDocument();
});
