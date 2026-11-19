import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DetailPanel } from '@/components/DetailPanel';
import type { CommentsState } from '@/hooks/use-comments';
import { setLanguage } from '@/i18n';
import type { ActivityRecord, Checkpoint, State, TaskFile } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

let comments: CommentsState = { kind: 'list', comments: [] };
vi.mock('@/hooks/use-comments', () => ({ useComments: () => comments }));
let files: TaskFile[] = [];
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => files }));

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const checkpoint = (n: number): Checkpoint => ({
  n, stage: 'dev', start: 'a'.repeat(40), head: 'b'.repeat(40), commit: `3f1c9e2${'0'.repeat(33)}`, branch: 'hive/1-task-1',
  at: new Date(Date.now() - 5 * 60_000).toISOString(), ended: 'done',
});
// I0 lists I1: both in one tree, both hive tasks (so both show relacionamentos), both with a checkpoint; I1 ran a session and has a body
const EPIC: WithWork = {
  item: { itemId: 'I0', id: '0', title: 'Epic', body: '', url: 'https://github.com/acme/r/issues/0', children: ['I1'] },
  stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/repo/.hive/worktrees/hive-0-epic', checkpoints: [checkpoint(1)],
};
const CHILD: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: 'the issue body', url: 'https://github.com/acme/r/issues/1', parent: 'I0' },
  stage: 'dev', boardColumn: 'Ready', auto: true, sessionId: SESSION, branch: 'hive/1-task-1', worktree: '/repo/.hive/worktrees/hive-1-task-1', checkpoints: [checkpoint(1)],
};
const RAN: ActivityRecord[] = [{ id: 'a-I1', taskIds: ['I1'], sessions: [{ id: SESSION, startedAt: '', stages: ['dev'], agent: 'claude', lastUsedAt: '' }] }];
const STATE: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [{ id: 's1', status: 'empty' }], ...flowed([{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }], []),
  tasks: [EPIC, CHILD], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, semaphores: {}, activities: [], activityRecords: RAN, usage: [], budget: {}, usageRules: [],
  disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS,
  shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
const panel = (taskId: string) => <DetailPanel state={STATE} selected={{ taskId }} locale="pt-BR" isShown onClose={() => {}} onOpenTask={() => {}} />;
const SECTIONS = ['árvore', 'relacionamentos', 'pontos de restauração', 'linha do tempo'];
const opened = (): boolean[] => SECTIONS.map((name) => (screen.getByRole('group', { name }) as HTMLDetailsElement).open);
// true when `a` comes before `b` in the document
const before = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

beforeEach(() => {
  setLanguage('pt');
  comments = { kind: 'list', comments: [] };
  files = [{ key: 'spec', path: 'docs/spec.md', base: 'worktree' }];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

test('the body reads, top to bottom, title, status, facts, resultados, sessões, árvore, relacionamentos, pontos de restauração, linha do tempo, descrição and comentários (#958)', () => {
  render(panel('I1'));
  const order = [
    screen.getByRole('heading', { name: '#1 Task 1' }), screen.getByRole('region', { name: 'parada' }), screen.getByText('trabalhou', { selector: 'dt' }),
    screen.getByRole('region', { name: 'resultados' }), screen.getByRole('region', { name: 'sessões' }),
    ...SECTIONS.map((name) => screen.getByRole('group', { name })),
    screen.getByRole('heading', { name: 'descrição' }), screen.getByRole('region', { name: 'comentários' }),
  ];
  expect(order.slice(1).map((el, i) => before(order[i], el))).toEqual(order.slice(1).map(() => true));
  expect(within(screen.getByRole('region', { name: 'comentários' })).getByText('sem comentários')).toBeInTheDocument();
});

test('árvore starts open and the other three closed, and each goes back to that when the panel shows another task (#958, #961)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(panel('I1'));
  expect(opened()).toEqual([true, false, false, false]);
  for (const name of SECTIONS) await user.click(screen.getByRole('group', { name }).querySelector('summary')!);
  expect(opened()).toEqual([false, true, true, true]);
  rerender(panel('I0'));
  expect(opened()).toEqual([true, false, false, false]);
});

test('linha do tempo comes right after pontos de restauração, with its closed line (#961)', () => {
  render(panel('I1'));
  const timeline = screen.getByRole('group', { name: 'linha do tempo' });
  expect(screen.getByRole('group', { name: 'pontos de restauração' }).nextElementSibling).toBe(timeline);
  expect(timeline.querySelector('summary')).toHaveTextContent('nada registrado ainda'); // setup.ts's empty timeline
});
