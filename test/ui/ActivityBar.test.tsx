import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ActivityBar } from '@/components/ActivityBar';
import { setLanguage } from '@/i18n';
import type { LocalActivity, TaskActivity } from '@/lib/activities';
import type { ActivityRecord, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityOf } from '../../src/activities';
import { localPairOf, movedWork, type WithWork } from '../fixtures/work';

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
// 2h31m of work and 12.3k tokens recorded, nothing running now
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt/hive-1-task-1',
  workspace: 'hive', branch: 'hive/1-task-1', ...extra,
});
// The task's record (#629): what the facts sum
const activityRecords: ActivityRecord[] = [{ id: 'a-I1', taskIds: ['I1'], sessions: [], usage: { tokens: 12_300, ms: 9_060_000, waitingMs: 0 } }];
const state = (c: WithWork): State => movedWork({ // #629: the worktree and the branch on the task's activity
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, activities: [], activityRecords, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: { hive: ['seed', 'hive test'] }, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const activity = (c: WithWork): TaskActivity => {
  const s = state(c);
  const live = activityOf(s, 'I1');
  if (!live) throw new Error('movedWork gives the task its activity');
  return { kind: 'task', task: s.tasks[0], runs: [], sessions: [], status: 'empty', worker: false, records: activityRecords, record: activityRecords[0], activity: live };
};
const bar = (c: WithWork, onShowFlow = vi.fn()) => <ActivityBar activity={activity(c)} state={state(c)} onShowFlow={onShowFlow} />;

beforeEach(() => setLanguage('pt'));

test('the bar reads the title over a line of etapa, the branch in mono, the time and the tokens as Detalhes totals them; no branch yet leaves it out with its separator (#536, #221)', () => {
  const { rerender } = render(bar(task()));
  expect(screen.getByText('#1 Task 1')).toHaveClass('truncate', 'font-semibold', 'text-[13px]');
  const facts = screen.getByText(/^etapa dev/);
  expect(facts).toHaveTextContent('etapa dev · hive/1-task-1 · 2h31m · 12.3k tokens');
  expect(facts).toHaveClass('text-muted-foreground', 'text-xs');
  expect(within(facts).getByText('hive/1-task-1')).toHaveClass('font-mono');
  const box = facts.closest('[data-activity-bar]');
  expect(box).not.toHaveClass('h-9'); // #221: no 36px box of its own, the header's 44px holds it
  expect(box).not.toHaveClass('border-b');
  expect(facts.previousElementSibling).toHaveTextContent('#1 Task 1'); // the title over the facts
  expect(facts.parentElement).toHaveClass('flex-col');
  rerender(bar(task({ branch: undefined })));
  expect(screen.getByText(/^etapa dev/)).toHaveTextContent(/^etapa dev · 2h31m · 12\.3k tokens$/);
});

test('the workspace\'s commands render as outline buttons, then dormir and the ⋯ (#536, #672)', () => {
  render(bar(task()));
  const seed = screen.getByRole('button', { name: 'seed' });
  expect(seed).toBeEnabled();
  expect(screen.getByRole('button', { name: 'hive test' })).toBeEnabled();
  const sleep = screen.getByRole('button', { name: 'dormir' });
  expect(sleep).toBeDisabled(); // no focused run
  expect(seed.compareDocumentPosition(sleep) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(screen.getByRole('button', { name: 'mais ações' })).toBeInTheDocument();
});

test('the commands, dormir and the ⋯ sit out of the window drag; the title and the facts drag with the header (#221)', () => {
  render(bar(task()));
  const actions = screen.getByRole('button', { name: 'mais ações' }).closest('[data-activity-bar] > :last-child');
  expect(actions).toHaveClass('[-webkit-app-region:no-drag]');
  expect(actions).toContainElement(screen.getByRole('button', { name: 'seed' }));
  expect(actions).toContainElement(screen.getByRole('button', { name: 'dormir' }));
  expect(screen.getByText('#1 Task 1').closest('[class*="no-drag"]')).toBeNull();
});

test('the ⋯ lists the activity\'s items; ver no fluxo shows the flow (#536)', async () => {
  const user = userEvent.setup();
  const onShowFlow = vi.fn();
  render(bar(task(), onShowFlow));
  screen.getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'ver no fluxo' }));
  expect(onShowFlow).toHaveBeenCalledTimes(1);
});

test('a local activity\'s bar reads local, then the workspace and its checkout\'s branch in mono; no commands; its ⋯ holds the local menu (#590)', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ name: 'hive', branch: 'main' }]), { status: 200, headers: { 'content-type': 'application/json' } })));
  const local: LocalActivity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [], sessions: [], kept: [] };
  render(<ActivityBar activity={local} state={state(task())} onShowFlow={vi.fn()} />);
  expect(screen.getByText('local')).toHaveClass('truncate', 'font-semibold', 'text-[13px]');
  await waitFor(() => expect(screen.getByText('main')).toHaveClass('font-mono'));
  expect(screen.getByText('main').parentElement).toHaveTextContent(/^hive · main$/);
  expect(screen.queryByRole('button', { name: 'seed' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'dormir' })).toBeDisabled();
  screen.getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menuitem', { name: 'nova sessão' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'ver no fluxo' })).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});
