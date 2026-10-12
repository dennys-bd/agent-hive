import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ActivityMenu, ActivityMenuButton } from '@/components/ActivityMenu';
import { AgentsContext } from '@/components/NewRunButton';
import { setLanguage } from '@/i18n';
import type { Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Its own file: Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx), so the menu is opened once and every
// state below arrives through rerender.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt', ...extra,
});
const live: Worker = { id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' };
const state = (c: Task, workers: Worker[] = []): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const item = (name: string): HTMLElement => screen.getByRole('menuitem', { name });
const names = (): string[] => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
beforeEach(() => { setLanguage('pt'); });

test('right-click on an activity: nova sessão, executar etapas…, the diffs, ver no fluxo, then dormir, and excluir atividade… in the destructive colour; aprovar and enviar feedback… only while the stage awaits approval (redesign 03)', async () => {
  const user = userEvent.setup();
  const onShowFlow = vi.fn();
  const menu = (c: Task, workers: Worker[] = []) => <ActivityMenu task={c} state={state(c, workers)} onShowFlow={onShowFlow}><button type="button">row</button></ActivityMenu>;
  const { rerender } = render(menu(task({ workerId: 's1' }), [live]));
  fireEvent.contextMenu(screen.getByRole('button', { name: 'row' }));
  await screen.findByRole('menuitem', { name: 'ver no fluxo' });
  expect(names()).toEqual(['nova sessão', 'executar etapas…', 'diff da etapa', 'diff da worktree', 'mostrar PR', 'ver no fluxo', 'dormir', expect.stringMatching(/^excluir atividade…/)]);
  expect(item('executar etapas…')).toHaveAttribute('data-disabled'); // the stage runs
  expect(item('dormir')).not.toHaveClass('text-destructive'); // sleeping loses nothing (#672)
  expect(screen.getByRole('menuitem', { name: /^excluir atividade…/ })).toHaveClass('text-destructive');
  expect(screen.getByRole('menuitem', { name: /^excluir atividade…/ })).toHaveAttribute('data-disabled'); // a run is live
  rerender(menu(task({ approval: { since: '2026-09-28T10:00:00.000Z' } })));
  expect(names().slice(0, 2)).toEqual(['aprovar', 'enviar feedback…']);
  expect(screen.queryByRole('menuitem', { name: 'dormir' })).not.toBeInTheDocument();
  rerender(menu(task()));
  expect(screen.queryByRole('menuitem', { name: 'aprovar' })).not.toBeInTheDocument();
  expect(item('executar etapas…')).not.toHaveAttribute('data-disabled'); // the stage never ran: a start
  expect(item('excluir atividade…')).not.toHaveAttribute('data-disabled');
  await user.click(item('ver no fluxo'));
  expect(onShowFlow).toHaveBeenCalledTimes(1);
});

test('the ⋯ opens the same items as the right-click, as a dropdown, from one list; ver no fluxo shows the flow (#536)', async () => {
  const user = userEvent.setup();
  const onShowFlow = vi.fn();
  const running = task({ workerId: 's1' });
  render(<ActivityMenuButton task={running} state={state(running, [live])} onShowFlow={onShowFlow} />);
  screen.getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('menuitem', { name: 'ver no fluxo' });
  // the right-click's list for the same task, in the test above
  expect(names()).toEqual(['nova sessão', 'executar etapas…', 'diff da etapa', 'diff da worktree', 'mostrar PR', 'ver no fluxo', 'dormir', expect.stringMatching(/^excluir atividade…/)]);
  expect(item('dormir')).not.toHaveClass('text-destructive'); // sleeping loses nothing (#672)
  expect(screen.getByRole('menu')).toHaveClass('w-[236px]');
  await user.click(item('ver no fluxo'));
  expect(onShowFlow).toHaveBeenCalledTimes(1);
});

test('executar etapas… opens the Start dialog on executar etapas for the activity\'s task (redesign 11)', async () => {
  const user = userEvent.setup();
  const body = JSON.stringify({ hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<ActivityMenuButton task={task()} state={state(task())} onShowFlow={vi.fn()} />);
  screen.getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'executar etapas…' }));
  expect(await screen.findByRole('dialog', { name: 'Iniciar #1' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'executar etapas' })).toBeChecked();
  vi.unstubAllGlobals();
});

test('nova sessão lists every agent; one boot did not find is disabled and named off PATH (#931)', async () => {
  const user = userEvent.setup();
  render(
    <AgentsContext.Provider value={[{ agent: 'claude', available: true }, { agent: 'codex', available: false }]}>
      <ActivityMenuButton task={task()} state={state(task())} onShowFlow={vi.fn()} />
    </AgentsContext.Provider>,
  );
  screen.getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  (await screen.findByRole('menuitem', { name: 'nova sessão' })).focus();
  await user.keyboard('{ArrowRight}');
  expect(await screen.findByRole('menuitem', { name: 'claude' })).not.toHaveAttribute('data-disabled');
  expect(screen.getByRole('menuitem', { name: 'codex · fora do PATH' })).toHaveAttribute('data-disabled');
});
