// The native view's table (#756): its fixtures, its fetch, and what its tests read off the screen; each test file mocks sonner itself.
import { render, screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { vi } from 'vitest';
import { ProjectTable } from '@/components/ProjectTable';
import { forgetProjects } from '@/hooks/use-project';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { ProjectItem, ProjectView, SourceConfig, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

export const SOURCE: SourceConfig = { name: 'roadmap', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' };
export const row = (n: number, extra: Partial<ProjectItem> = {}): ProjectItem => ({
  itemId: `roadmap:PVTI_${n}`, id: String(n), title: `Issue ${n}`, body: `body ${n}`, url: `https://github.com/acme/r/issues/${n}`,
  labels: [], assignees: [], fields: {}, pullRequests: [], ...extra,
});
export const VIEW: ProjectView = {
  statuses: [{ name: 'Todo' }, { name: 'Ready', stage: 'dev' }, { name: 'Done' }],
  fields: [
    { name: 'Priority', type: 'singleSelect', options: ['P0', 'P1', 'P2'] }, { name: 'Estimate', type: 'number' }, { name: 'Target', type: 'date' },
    { name: 'Progress', type: 'progress' }, { name: 'Sprint', type: 'iteration', options: ['S1', 'S2'] },
  ],
  items: [
    row(12, { status: 'Ready', labels: ['bug'], assignees: ['ana'], fields: { Priority: 'P2', Estimate: 5, Target: '2026-10-20', Progress: '1/3' } }),
    row(3, { status: 'Todo', fields: { Priority: 'P0', Estimate: 1 }, out: 'filter' }),
    row(40, { status: 'Done', fields: { Estimate: 13 }, pullRequests: [{ number: 7, url: 'https://github.com/acme/r/pull/7', state: 'open', checks: 'green' }] }),
  ],
  builtins: { status: 0, labels: 1, assignees: 1 }, truncated: false, // status, Priority, labels, resp., then the other fields
};
// #12 is a task of roadmap: the issue listed by the poll
export const TASK: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Issue 12', body: '', url: '', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
export const state = (tasks: Task[]): State => ({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks, sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: { roadmap: 'hive' }, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
export const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const answer = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonRes(String(input).endsWith('/project') ? VIEW : { ok: true });
export const fetchMock = vi.fn(answer);
/** Each test's start: pt, no cached view, every column saved and no groups (each test seeds its own), the view answered. */
export function resetProjectTest(): void {
  setLanguage('pt');
  forgetProjects();
  // a view saved since the blocked-by column exists (#61), the column hidden: the tests that do not read it keep their columns
  resetViewState({ projectViews: { roadmap: { groupBy: null, collapsed: [], columns: ALL, blockedByShown: true } } });
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
}

export const ALL = ['status', 'field:Priority', 'labels', 'assignee', 'field:Estimate', 'field:Target', 'field:Progress', 'field:Sprint', 'pr'];
export const TABS = { label: 'GitHub Project', active: 'native' as const, onPick: () => undefined };
export function renderTable({ onGoTo = vi.fn(), onOpenIssue = vi.fn(), tasks = [TASK] }: { onGoTo?: (taskId: string) => void; onOpenIssue?: (item: ProjectItem) => void; tasks?: Task[] } = {}) {
  return render(<ProjectTable state={state(tasks)} source={SOURCE} tabs={TABS} onGoTo={onGoTo} onOpenIssue={onOpenIssue} />);
}
export const rowOf = (id: string): HTMLElement => screen.getByText(id).closest('tr')!;
// The issue numbers of the rows shown, group rows skipped
export const numbers = (): (string | null)[] => screen.getAllByRole('row').slice(1).flatMap((r) => within(r).queryAllByText(/^#\d+$/).slice(0, 1)).map((n) => n.textContent);

// Radix opens a menu on a pointerdown jsdom does not always deliver after another test's clicks: Enter on the focused trigger, as other tests do
export async function openMenu(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  screen.getByRole('button', { name }).focus();
  await user.keyboard('{Enter}');
}
export const heads = (): (string | null)[] => screen.getAllByRole('columnheader').map((h) => h.textContent);

