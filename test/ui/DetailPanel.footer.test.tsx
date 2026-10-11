import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type DetailNav, DetailPanel } from '@/components/DetailPanel';
import { setLanguage } from '@/i18n';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork, withTasks, movedWork } from '../fixtures/work';

// Redesign 06: the footer's way to the task's activity or back to the board, and the metadata grid.
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' },
  stage: 'dev', boardColumn: 'Ready', auto: true, branch: 'hive/1-task-1',
};
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }], tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
const footer = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="detail-footer"]')!;
const value = (label: string): Element | null => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
const navOf = (center: DetailNav['center'], canOpen: boolean): DetailNav => ({
  center, canOpenActivity: vi.fn(() => canOpen), openActivity: vi.fn(), showFlow: vi.fn(),
});
const panel = (nav: DetailNav | undefined, s: State = state) => <DetailPanel state={s} selected={{ taskId: 'I1' }} locale="pt-BR" isShown onClose={() => {}} nav={nav} />;

const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('on the board the footer offers abrir atividade, disabled while the task is no activity, and opening that task\'s activity once it is one', async () => {
  const user = userEvent.setup();
  const idle = navOf('automation', false);
  const { unmount } = render(panel(idle));
  expect(within(footer()).getByRole('button', { name: 'abrir atividade' })).toBeDisabled();
  expect(idle.canOpenActivity).toHaveBeenCalledWith('I1');
  expect(within(footer()).queryByRole('button', { name: 'ver no fluxo' })).not.toBeInTheDocument();
  unmount();
  const running = navOf('automation', true);
  render(panel(running));
  await user.click(within(footer()).getByRole('button', { name: 'abrir atividade' }));
  expect(running.openActivity).toHaveBeenCalledWith('I1');
});

test('under Atividades the footer offers ver no fluxo, which goes back to the board; without a nav only ⋯ is there', async () => {
  const user = userEvent.setup();
  const activities = navOf('activities', true);
  const { unmount } = render(panel(activities));
  expect(within(footer()).queryByRole('button', { name: 'abrir atividade' })).not.toBeInTheDocument();
  await user.click(within(footer()).getByRole('button', { name: 'ver no fluxo' }));
  expect(activities.showFlow).toHaveBeenCalledOnce();
  unmount();
  render(panel(undefined));
  expect(within(footer()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['mais ações']);
});

test('the metadata reads who starts the task (auto, or por você on a manual task), sem PR without one, the issue as repo#n linking to it, and the branch', () => {
  const { unmount } = render(panel(undefined));
  expect(value('início')).toHaveTextContent('auto · o worker começa sozinho');
  expect(value('PRs')).toHaveTextContent('sem PR');
  expect(within(value('issue') as HTMLElement).getByRole('link', { name: 'r#1' })).toHaveAttribute('href', task.item.url);
  expect(value('branch')).toHaveTextContent('hive/1-task-1');
  unmount();
  render(panel(undefined, movedWork({ ...state, tasks: [{ ...task, auto: false }] })));
  expect(value('início')).toHaveTextContent('por você');
});

test('a local task has no issue row', () => {
  const local: WithWork = { ...task, created: true, item: { ...task.item, url: '' } };
  render(panel(undefined, movedWork({ ...state, tasks: [local] })));
  expect(screen.queryByText('issue', { selector: 'dt' })).not.toBeInTheDocument();
});

test('Escape in the always-open feedback box only leaves the field; the next one closes the panel (#426, #685)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const awaiting: State = movedWork({ ...state, tasks: [{ ...task, approval: { since: '2026-09-27T10:00:00.000Z' } }] });
  render(<DetailPanel state={awaiting} selected={{ taskId: 'I1' }} locale="pt-BR" isShown onClose={onClose} />);
  await user.click(screen.getByLabelText('Feedback'));
  await user.keyboard('{Escape}');
  expect(screen.getByLabelText('Feedback')).not.toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
});

// ⋯ opened from the keyboard, Radix's way under jsdom
async function menu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  within(footer()).getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  return screen.findByRole('menu');
}
const WORKTREE: WithWork = { ...task, worktree: '/repo/.hive/worktrees/hive-1-task-1' };

test('⋯ on a GitHub task lists abrir issue no GitHub, copiar link da tarefa, copiar branch, começar sozinho and excluir atividade (redesign 06)', async () => {
  const user = userEvent.setup();
  render(panel(undefined, movedWork({ ...state, tasks: [WORKTREE] })));
  const items = [...(await menu(user)).querySelectorAll('[role^="menuitem"]')]; // menuitem and the switch's menuitemcheckbox
  expect(items.map((item) => item.textContent)).toEqual(['abrir issue no GitHub', 'copiar link da tarefa', 'copiar branch', 'começar sozinho', 'excluir atividade']);
});

test('copiar branch writes the task\'s branch to the clipboard', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true }); // after setup, which installs its own
  render(panel(undefined));
  await user.click(within(await menu(user)).getByRole('menuitem', { name: 'copiar branch' }));
  expect(writeText).toHaveBeenCalledWith('hive/1-task-1');
});

test('começar sozinho is checked on a task the worker may start and posts manual true, keeping the menu open (#164, redesign 06)', async () => {
  const user = userEvent.setup();
  render(panel(undefined));
  const m = await menu(user);
  const item = within(m).getByRole('menuitemcheckbox', { name: 'começar sozinho' });
  expect(item).toHaveAttribute('aria-checked', 'true');
  await user.click(item);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/auto', expect.objectContaining({ method: 'POST', body: JSON.stringify({ auto: false }) }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
});

test('excluir atividade is absent on a checkout task, disabled with its reason while a run holds the task, and opens limpar\'s confirm otherwise (#182, #210, #444)', async () => {
  const user = userEvent.setup();
  const checkout = render(panel(undefined, withTasks(state, [{ ...WORKTREE, local: true }])));
  expect(within(await menu(user)).queryByRole('menuitem', { name: /^excluir atividade/ })).not.toBeInTheDocument();
  checkout.unmount();
  const running: State = movedWork({ ...state, workers: [{ id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1' }], tasks: [{ ...WORKTREE, workerId: 's1' }] });
  const busy = render(panel(undefined, running));
  const blocked = within(await menu(user)).getByRole('menuitem', { name: /^excluir atividade/ });
  expect(blocked).toHaveAttribute('data-disabled');
  expect(blocked).toHaveTextContent('excluir atividade · um worker ou sessão está executando nessa tarefa');
  busy.unmount();
  render(panel(undefined, movedWork({ ...state, tasks: [WORKTREE] })));
  await user.click(within(await menu(user)).getByRole('menuitem', { name: 'excluir atividade' }));
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'excluir atividade' }));
  expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/delete', expect.objectContaining({ method: 'POST' }));
});

test('the blockers section sits right before the metadata; Escape in its add row closes the row, not the panel; the body scrolls with no visible bar (#57)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<DetailPanel state={state} selected={{ taskId: 'I1' }} locale="pt-BR" isShown onClose={onClose} />);
  const blockers = screen.getByRole('region', { name: 'bloqueios' });
  expect(blockers.nextElementSibling).toBe(screen.getByText('início', { selector: 'dt' }).closest('dl'));
  expect(screen.getByRole('heading', { level: 2 }).parentElement).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'scrollbar-none', 'py-3.5');
  await user.click(within(blockers).getByRole('button', { name: '+ adicionar' }));
  expect(within(blockers).getByRole('combobox', { name: '#número ou título…' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(within(blockers).queryByRole('combobox', { name: '#número ou título…' })).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});
