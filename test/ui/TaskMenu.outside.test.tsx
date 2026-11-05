import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskMenu } from '@/components/TaskMenu';
import { setLanguage } from '@/i18n';
import type { Stage, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

// Its own file: Radix's ContextMenu opens once per file under jsdom, and the pick closes it. A task outside the flow (#566) is on no flowchart,
// so the menu wraps a bare card.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const OUTSIDE: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, boardColumn: 'Ready', auto: true }; // no stage
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed(stages, []), tasks: [OUTSIDE], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const openMenu = (): void => {
  render(<TaskMenu task={OUTSIDE} state={state}><li>card</li></TaskMenu>);
  fireEvent.contextMenu(screen.getByText('card'));
};
beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

const items = (): string[] => [...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent ?? '');

test('outside the flow, levar ao fluxo… stands where começar sozinho, mover para etapa and tirar do fluxo stand in the flow, and opens the take-to-flow dialog on the task (#576 decisions 10, 13)', async () => {
  const user = userEvent.setup();
  openMenu();
  const take = await screen.findByRole('menuitem', { name: 'levar ao fluxo…' });
  const names = items();
  for (const absent of ['começar sozinho', 'mover para etapa', 'tirar do fluxo']) expect(names).not.toContain(absent);
  expect(names.slice(0, 2)).toEqual(['executar etapas…', 'abrir sessão livre…']);
  expect(names.indexOf('levar ao fluxo…')).toBe(names.findIndex((n) => n.startsWith('mover para workspace')) - 1);
  await user.click(take);
  expect(await screen.findByRole('alertdialog', { name: 'Levar ao fluxo' })).toHaveTextContent('#1 Task 1');
});
