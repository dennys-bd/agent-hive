import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type ActivitiesNav, ActivitiesPanel, type ActivitiesPanelProps } from '@/components/ActivitiesPanel';
import { setLanguage, statusText } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { readView } from '@/lib/view-state';
import type { ActivityRecord, Stage } from '../../src/types';
import type { WithWork } from '../fixtures/work';
import { mainFlows } from '../fixtures/main-flow.js';

const task = (id: string, title: string, project: string, stage = 'dev'): WithWork => ({
  item: { itemId: `I${id}`, id, title, body: '', url: '' }, stage, boardColumn: 'Ready', auto: true, workspace: project,
});
// The task's record (#629): 1h30 of work recorded
const records = (id: string): ActivityRecord[] => [{ id: `a-${id}`, taskIds: [`I${id}`], sessions: [], usage: { tokens: 0, ms: 95 * 60_000, waitingMs: 5 * 60_000, parts: [{ tokens: 0, ms: 95 * 60_000, waitingMs: 5 * 60_000 }] } }];
const stage = { ptyId: 'W1', label: 'Claude · abcdef12', kind: 'stage' as const, session: 'abcdef12' };
const captured = { ptyId: 'W3', label: 'Claude', kind: 'session' as const, terminalId: 'T2' }; // drawn in terminal 2's place (#347)
// Task 1 waits on the user and draws three lines: its stage session, terminal 1, and the captured session in terminal 2's place
const waiting: TaskActivity = {
  kind: 'task', task: task('1', 'Task 1', 'hive'), status: 'waiting', worker: true, records: records('1'), record: records('1')[0],
  activity: { id: 'a-1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', branch: 'hive/1-task-1' },
  runs: [stage, captured],
  sessions: [{ run: stage, status: 'waiting' }, { run: captured, status: 'working' }],
  terminals: [{ terminalId: 'T1', label: 'Terminal 1', n: 1, asleep: false }, { terminalId: 'T2', label: 'Terminal 2', n: 2, asleep: false, runId: 'W3' }],
};
// Task 2 keeps nothing: no line, so no chevron
const quiet: TaskActivity = {
  kind: 'task', task: task('2', 'Task 2', 'hive'), runs: [], sessions: [], status: 'empty', worker: false, records: records('2'), record: records('2')[0],
  activity: { id: 'a-2', kind: 'task', workspace: 'hive', slug: 'hive-2-task-2' },
};
const session = (ptyId: string) => ({ ptyId, label: 'Claude', kind: 'session' as const });
// Task 3 works in review with one session; task 4 is the same in the other workspace
const working: TaskActivity = {
  kind: 'task', task: task('3', 'Task 3', 'hive', 'review'), status: 'working', worker: false, records: records('3'), record: records('3')[0],
  activity: { id: 'a-3', kind: 'task', workspace: 'hive', slug: 'hive-3-task-3' },
  runs: [session('W5')], sessions: [{ run: session('W5'), status: 'working' }],
};
const elsewhere: TaskActivity = {
  ...working, task: task('4', 'Task 4', 'site'), records: records('4'), record: records('4')[0],
  activity: { id: 'a-4', kind: 'task', workspace: 'site', slug: 'site-4-task-4' },
  runs: [session('W6')], sessions: [{ run: session('W6'), status: 'working' }],
};
const ALL = [waiting, quiet, working, elsewhere];
const STAGES: Stage[] = [
  { name: 'dev', prompt: '/hive-build {url}', from: {} },
  { name: 'review', prompt: '/hive-review {url}', from: {} },
  { name: 'done', from: {} },
];

const noop = (): void => {};
const nav: ActivitiesNav = { newActivity: noop, addWorkspace: noop };
const props = (extra: Partial<ActivitiesPanelProps> = {}): ActivitiesPanelProps => ({
  activities: ALL, workspaces: ['hive', 'site'], workers: [], flows: mainFlows(STAGES), onSelect: noop, onOpenRun: noop, nav, ...extra,
});
const group = (name: string): HTMLElement => screen.getByRole('region', { name });
const row = (title: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${title}`) });
const chevron = (title: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^(Recolher|Expandir) ${title}$`) });
// The session and terminal lines of a workspace, in order (#347)
const lines = (workspace: string): string[] =>
  within(group(workspace)).queryAllByRole('button', { name: /^(claude|terminal)/ }).map((b) => b.textContent ?? '');

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/view-state') ? { ok: true } : []), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('collapsing a task hides its session and terminal lines and marks how many it hid; expanding brings them back (#913)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props()} />);
  expect(lines('hive')).toHaveLength(4); // task 1's three, then task 3's one
  expect(chevron('#1 Task 1')).toHaveAttribute('aria-expanded', 'true');
  expect(chevron('#1 Task 1')).toHaveAccessibleName('Recolher #1 Task 1');
  await user.click(chevron('#1 Task 1'));
  expect(chevron('#1 Task 1')).toHaveAttribute('aria-expanded', 'false');
  expect(chevron('#1 Task 1')).toHaveAccessibleName('Expandir #1 Task 1');
  expect(lines('hive')).toHaveLength(1); // task 3's alone
  expect(screen.queryByRole('button', { name: /^terminal 1/ })).not.toBeInTheDocument();
  // three: what expanding draws, not its two sessions plus its two terminals (#347)
  expect(within(row('#1 Task 1')).getByText('3 linhas ocultas')).toHaveClass('sr-only');
  expect(within(row('#1 Task 1')).getByText('3')).toHaveAttribute('aria-hidden', 'true');
  await user.click(chevron('#1 Task 1'));
  expect(lines('hive')).toHaveLength(4);
  expect(within(row('#1 Task 1')).queryByText('3 linhas ocultas')).not.toBeInTheDocument();
});

test('a collapsed task waiting on the user marks its status word after the count; one that works marks the count alone; a task with no lines has no chevron (#913)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props()} />);
  expect(screen.queryByRole('button', { name: /^(Recolher|Expandir) #2 Task 2$/ })).not.toBeInTheDocument();
  await user.click(chevron('#1 Task 1'));
  await user.click(chevron('#3 Task 3'));
  expect(within(row('#1 Task 1')).getByText(statusText('waiting'))).toHaveClass('text-waiting');
  expect(within(row('#3 Task 3')).getByText('1 linha oculta')).toBeInTheDocument();
  expect(within(row('#3 Task 3')).queryByText(statusText('working'))).not.toBeInTheDocument();
});

test('a collapsed task is still collapsed when the panel mounts again, saved in its workspace\'s view (#913, #779)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<ActivitiesPanel {...props()} />);
  await user.click(chevron('#1 Task 1'));
  unmount();
  render(<ActivitiesPanel {...props()} />);
  expect(chevron('#1 Task 1')).toHaveAttribute('aria-expanded', 'false');
  expect(chevron('#3 Task 3')).toHaveAttribute('aria-expanded', 'true');
  expect(lines('hive')).toHaveLength(1);
  await waitFor(() => expect(readView('activitiesView')).toMatchObject({ hive: { collapsedTasks: ['I1'] }, site: { collapsedTasks: [] } }));
});
