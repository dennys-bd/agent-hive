import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { type DetailNav, type DetailPage, DetailPanel } from '@/components/DetailPanel';
import { DetailSlot, DetailSlotProvider } from '@/components/DetailSlot';
import type { CommentsState } from '@/hooks/use-comments';
import { setLanguage } from '@/i18n';
import type { State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withWork } from '../fixtures/work';

// Every task id the panel asked useComments for: a page reads none, its comments are the center's
const read: (string | undefined)[] = [];
const COMMENTS: CommentsState = { kind: 'list', comments: [{ author: 'ana', createdAt: '2026-10-01T09:00:00Z', body: 'a comment', url: 'https://github.com/acme/r/issues/1#c1' }] };
vi.mock('@/hooks/use-comments', () => ({ useComments: (id?: string) => { read.push(id); return COMMENTS; } }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

const URL1 = 'https://github.com/acme/r/issues/1';
const USED = '2026-10-01T09:00:00.000Z';
// A GitHub task of the roadmap source with blockers read (#56), and a hive task, the selection
const TASK: Task = {
  item: { itemId: 'roadmap:PVTI_1', id: '1', title: 'Task 1', body: 'the issue body', url: URL1, source: 'roadmap', blockers: { blockedBy: [], blocking: [] } },
  stage: 'dev', boardColumn: 'Ready', auto: false,
};
const HIVE: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Local', body: 'the local body', url: '' }, stage: 'dev', boardColumn: '', auto: false, created: true };
const BASE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [TASK, HIVE],
  sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['site'],
  sourceWorkspaces: { roadmap: 'site' }, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT,
  approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
// TASK's activity, stopped, with its branch and one session
const STATE: State = withWork(BASE, TASK.item.itemId, { workspace: 'site', branch: 'hive/1-task-1' }, {
  sessions: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: USED, stages: ['dev'], lastUsedAt: USED }],
});
const NAV: DetailNav = { center: 'automation', canOpenActivity: () => false, openActivity: () => {}, showFlow: () => {} };

// The panel as the Dashboard drives it under Automação, the selection HIVE, beside a page that renders BLOCK into the slot
function renderPanel(page?: DetailPage) {
  const onOpenIssue = vi.fn();
  const view = render(
    <DetailSlotProvider>
      <DetailPanel state={STATE} selected={{ taskId: HIVE.item.itemId }} locale="pt-BR" isShown onClose={() => {}} nav={NAV} page={page} onOpenIssue={onOpenIssue} />
      <DetailSlot><p>BLOCK</p></DetailSlot>
    </DetailSlotProvider>,
  );
  return { ...view, onOpenIssue };
}
const aside = (): HTMLElement => screen.getByRole('complementary', { name: 'detalhe' });
const footer = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-slot="detail-footer"]');
// true when `a` comes before `b` in the document
const before = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

beforeEach(() => { setLanguage('pt'); read.length = 0; });

test('on an issue page with a task the panel draws that task, not the selection: title, workspace · source, status, the page\'s block, blockers, properties, sessions, footer; no issue body, no comments read (#64)', () => {
  renderPanel({ kind: 'issue', url: URL1, task: TASK });
  const order = [
    screen.getByRole('heading', { name: '#1 Task 1' }), screen.getByText('site · roadmap'), screen.getByRole('region', { name: 'parada' }),
    within(aside()).getByText('BLOCK'), screen.getByRole('region', { name: 'bloqueios' }), screen.getByText('branch', { selector: 'dt' }),
    screen.getByRole('region', { name: 'sessões' }), footer() as HTMLElement,
  ];
  expect(order.slice(1).map((el, i) => before(order[i], el))).toEqual([true, true, true, true, true, true, true]);
  expect(screen.queryByRole('heading', { name: 'HIVE-1 Local' })).not.toBeInTheDocument();
  expect(screen.queryByText('the issue body')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'comentários' })).not.toBeInTheDocument();
  expect(read.at(-1)).toBeUndefined();
  expect(screen.queryByRole('button', { name: 'issue ›' })).not.toBeInTheDocument(); // an issue page is the issue already
});

test('with no page the panel shows the selected task with its body and comments, as before, and no slot (#64)', () => {
  renderPanel();
  expect(screen.getByRole('heading', { name: 'HIVE-1 Local' })).toBeInTheDocument();
  expect(screen.getByText('the local body')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'comentários' })).toHaveTextContent('a comment');
  expect(screen.queryByText('BLOCK')).not.toBeInTheDocument();
  expect(read.at(-1)).toBe(HIVE.item.itemId);
});

test('on a PR page whose task is a GitHub issue, issue › ends the title row and opens that issue; a hive task gets no link (#64)', async () => {
  const user = userEvent.setup();
  const { onOpenIssue, unmount } = renderPanel({ kind: 'pr', url: 'https://github.com/acme/r/pull/7', task: TASK });
  const link = screen.getByRole('button', { name: 'issue ›' });
  expect(link).toHaveClass('text-muted-foreground', 'hover:text-foreground');
  await user.click(link);
  expect(onOpenIssue).toHaveBeenCalledWith(URL1);
  unmount();
  renderPanel({ kind: 'pr', url: 'https://github.com/acme/r/pull/8', task: HIVE });
  expect(screen.getByRole('heading', { name: 'HIVE-1 Local' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'issue ›' })).not.toBeInTheDocument();
});

test('a page with no task in the flow: the panel holds the page\'s block alone, no task, no empty state, no footer (#64)', () => {
  renderPanel({ kind: 'issue', url: 'https://github.com/acme/r/issues/9' });
  expect(within(aside()).getByText('BLOCK')).toBeInTheDocument();
  expect(within(aside()).queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.queryByText('Nenhuma tarefa selecionada')).not.toBeInTheDocument();
  expect(footer()).toBeNull();
  expect(read.at(-1)).toBeUndefined();
});
