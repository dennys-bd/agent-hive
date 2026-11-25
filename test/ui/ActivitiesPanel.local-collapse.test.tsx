import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type ActivitiesNav, ActivitiesPanel, type ActivitiesPanelProps } from '@/components/ActivitiesPanel';
import { setLanguage, statusText } from '@/i18n';
import type { LocalActivity, TaskActivity } from '@/lib/activities';
import { readView } from '@/lib/view-state';
import { localActivityId } from '../../src/activities';
import type { Stage, Worker } from '../../src/types';
import { mainFlows } from '../fixtures/main-flow.js';

const live = 'a1b2c3d4-0000-4000-8000-000000000001';
const record = { id: localActivityId('hive'), taskIds: [], sessions: [{ id: live, startedAt: '', stages: [], agent: 'claude' as const, lastUsedAt: '' }] };
// hive's local entry draws two lines: its kept session, then its terminal
const local: LocalActivity = {
  kind: 'local', activity: { id: localActivityId('hive'), kind: 'local', workspace: 'hive' }, record, workspace: 'hive', runs: [], sessions: [], kept: [],
  terminals: [{ terminalId: 'T1', label: 'Terminal 1', n: 1, asleep: false }],
};
const waiting: Worker[] = [{ id: 's', status: 'waiting', runId: 'W9', activityId: localActivityId('hive'), sessionId: live, freeSession: true }];
const session = { ptyId: 'W5', label: 'Claude', kind: 'session' as const };
const working: TaskActivity = {
  kind: 'task', task: { item: { itemId: 'I3', id: '3', title: 'Task 3', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive' },
  status: 'working', worker: false, records: [], record: { id: 'a-3', taskIds: ['I3'], sessions: [] }, activity: { id: 'a-3', kind: 'task', workspace: 'hive', slug: 'hive-3-task-3' },
  runs: [session], sessions: [{ run: session, status: 'working' }],
};
const STAGES: Stage[] = [{ name: 'dev', prompt: '/hive-build {url}', from: {} }, { name: 'done', from: {} }];

const noop = (): void => {};
const nav: ActivitiesNav = { newActivity: noop, addWorkspace: noop };
const props = (extra: Partial<ActivitiesPanelProps> = {}): ActivitiesPanelProps => ({
  activities: [local, working], workspaces: ['hive', 'site'], workers: waiting, flows: mainFlows(STAGES), onSelect: noop, onOpenRun: noop, nav, ...extra,
});
const group = (name: string): HTMLElement => screen.getByRole('region', { name });
const localRow = (workspace: string): HTMLElement => within(group(workspace)).getByRole('button', { name: /^local/ });
const block = (workspace: string): HTMLElement => localRow(workspace).parentElement as HTMLElement;
const chevron = (workspace: string): HTMLElement => within(block(workspace)).getByRole('button', { name: 'linhas' });
const drawnLines = (): string[] => within(block('hive')).queryAllByRole('button', { name: /^(claude|terminal)/ }).map((b) => b.textContent ?? '');

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/view-state') ? { ok: true } : []), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('collapsing the local entry hides its session and terminal lines, marks the count then waiting, and saves its local key (#1033)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props()} />);
  expect(drawnLines()).toHaveLength(2);
  expect(chevron('hive')).toHaveAttribute('aria-expanded', 'true');
  await user.click(chevron('hive'));
  expect(chevron('hive')).toHaveAttribute('aria-expanded', 'false');
  expect(drawnLines()).toEqual([]);
  expect(within(localRow('hive')).getByText('2 linhas ocultas')).toHaveClass('sr-only');
  expect(within(localRow('hive')).getByText(statusText('waiting'))).toHaveClass('text-waiting');
  await waitFor(() => expect(readView('activitiesView')).toMatchObject({ hive: { collapsedTasks: ['local/hive'] } }));
  await user.click(chevron('hive'));
  expect(drawnLines()).toHaveLength(2);
});

test('a local entry with no lines has no chevron (#1033)', () => {
  render(<ActivitiesPanel {...props()} />);
  expect(within(block('site')).queryByRole('button', { name: 'linhas' })).not.toBeInTheDocument();
});

test('a terminal that draws a live session in its place counts once: the marker says what expanding draws (#1033, #347)', async () => {
  const user = userEvent.setup();
  const merged: LocalActivity = { ...local, terminals: [{ terminalId: 'T1', label: 'Terminal 1', n: 1, asleep: false, runId: 'W9' }] };
  render(<ActivitiesPanel {...props({ activities: [merged, working] })} />);
  expect(drawnLines()).toHaveLength(1);
  await user.click(chevron('hive'));
  expect(within(localRow('hive')).getByText('1 linha oculta')).toBeInTheDocument();
});

const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> => {
  screen.getByRole('button', { name }).focus();
  await user.keyboard('{Enter}');
};

test('recolher atividades collapses the local entry with the tasks; expandir atividades opens it again (#1033)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props()} />);
  await openMenu(user, 'opções de hive');
  await user.click(screen.getByRole('menuitem', { name: 'recolher atividades' }));
  expect(chevron('hive')).toHaveAttribute('aria-expanded', 'false');
  expect(readView('activitiesView')).toMatchObject({ hive: { collapsedTasks: ['local/hive', 'I3'] } });
  await openMenu(user, 'opções de hive');
  await user.click(screen.getByRole('menuitem', { name: 'expandir atividades' }));
  expect(chevron('hive')).toHaveAttribute('aria-expanded', 'true');
  expect(drawnLines()).toHaveLength(2);
});

test('a group header sits in the workspace header\'s chevron column: pl-1.5 (#1033)', () => {
  render(<ActivitiesPanel {...props()} />);
  const header = within(within(group('hive')).getByRole('group', { name: 'dev' })).getByRole('button', { name: /^dev/ }).parentElement;
  expect(header).toHaveClass('pl-1.5');
});
