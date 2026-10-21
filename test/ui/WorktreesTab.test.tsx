import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorktreesTab } from '@/components/settings/WorktreesTab';
import { setLanguage, t } from '@/i18n';
import type { Task, Worker, State, WorktreeRow } from '../../src/types';
import { SPAWN_FAILED } from '../../src/types';
import { activityIdOf, taskPairOf, withPointedWork } from '../fixtures/work';

const REFUSAL = "the branch 'hive/3-done' is not fully merged into HEAD";
const ORPHAN: WorktreeRow = { workspace: 'hive', slug: 'hive-9-gone', path: '/repo/.hive/worktrees/hive-9-gone', branch: 'hive/9-gone', orphan: 'noTask', nested: [] };
const FAILED: WorktreeRow = {
  workspace: 'hive', slug: 'hive-3-done', path: '/repo/.hive/worktrees/hive-3-done', branch: 'hive/3-done', orphan: 'deleteActivityFailed', nested: [],
  task: { id: 'I3', activityId: 'a-I3', title: '#3 Done', error: REFUSAL, removable: true },
};
const RUNNING: WorktreeRow = { workspace: 'hive', slug: 'hive-1-local', path: '/repo/.hive/worktrees/hive-1-local', branch: null, nested: [], task: { id: 'L1', activityId: 'a-L1', title: 'HIVE-1 Local', removable: false } };
const DETACHED: WorktreeRow = { workspace: 'hive', slug: 'hive-2-detached', path: '/repo/.hive/worktrees/hive-2-detached', branch: null, nested: [], task: { id: 'L2', activityId: 'a-L2', title: 'HIVE-2 Detached', removable: false } };

const taskOf = (itemId: string, title: string, stage: string): Task => ({ item: { itemId, id: itemId, title, body: '', url: '' }, stage, boardColumn: stage, auto: true });
const WORKING: Worker = { id: 's1', activityId: activityIdOf('L1'), status: 'working' };
const STATE: Pick<State, 'tasks' | 'workers' | 'terminals' | 'activities' | 'activityRecords'> =
  withPointedWork({ tasks: [taskOf('L1', 'HIVE-1 Local', 'Build'), taskOf('L2', 'HIVE-2 Detached', 'Plan')], workers: [WORKING], terminals: [], activities: [taskPairOf('L2').activity], activityRecords: taskPairOf('L2').records }); // #727: a task with a worktree has a live activity; without one it reads new
const REMOVABLE: WorktreeRow = { ...DETACHED, task: { ...DETACHED.task!, removable: true } };

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
let rows: WorktreeRow[] = [];
let answers: Record<string, unknown> = {}; // POST url → its answer; anything else removes
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  return reply(url === '/worktrees' ? rows : (answers[url] ?? { removed: true }));
});
beforeEach(() => { setLanguage('pt'); rows = [ORPHAN, FAILED, RUNNING, DETACHED]; answers = {}; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const displayOf = (row: WorktreeRow): string => row.task?.title ?? row.branch ?? row.slug;
const findRow = (row: WorktreeRow): HTMLElement => screen.getByText(displayOf(row)).closest('li')!;
const gets = (): number => fetchMock.mock.calls.filter(([url]) => url === '/worktrees').length;
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [String(url), init?.body]);
const dialog = () => screen.getByRole('alertdialog');
const trashOf = (row: WorktreeRow) => within(findRow(row)).getByRole('button', { name: t('worktrees.remove') });

test('every worktree is listed by default, under its workspace with its counts; the toggle narrows to the orphans; the note closes the task', async () => {
  const user = userEvent.setup();
  render(<WorktreesTab state={STATE} />);
  const hive = await screen.findByRole('region', { name: 'hive' });
  expect(within(hive).getByText('4 worktrees · 2 órfãs')).toBeInTheDocument();
  for (const row of [ORPHAN, FAILED, RUNNING, DETACHED]) expect(within(hive).getByText(displayOf(row))).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: 'worktrees' })).toBeInTheDocument();
  expect(screen.getByText(t('worktrees.hint'))).toHaveTextContent(/^tudo em \.hive\/worktrees · órfã = nenhuma tarefa do fluxo aponta para ela/);
  expect(screen.getByText(t('worktrees.footer'))).toHaveTextContent(/^com sessão aberta não dá para apagar: feche a sessão da tarefa antes\./);
  await user.click(screen.getByRole('radio', { name: 'órfãs · 2' }));
  expect(screen.queryByText('HIVE-1 Local')).not.toBeInTheDocument();
  expect(screen.getByText('hive/9-gone')).toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: 'todas · 4' }));
  expect(screen.getByText('HIVE-1 Local')).toBeInTheDocument();
});

test('an active row shows its stage and status, and an open session; its × is disabled then, with the reason; otherwise it confirms and posts the task route', async () => {
  const user = userEvent.setup();
  rows = [RUNNING, REMOVABLE];
  render(<WorktreesTab state={STATE} />);
  await screen.findByText('HIVE-1 Local');
  expect(findRow(RUNNING)).toHaveTextContent(`Build · ${t('status.working')} · ${t('worktrees.sessionOpen')}`);
  expect(trashOf(RUNNING)).toBeDisabled();
  expect(trashOf(RUNNING).closest('[title]')).toHaveAttribute('title', t('worktrees.sessionBlocks'));
  expect(findRow(REMOVABLE)).toHaveTextContent(`Plan · ${t('worktrees.stopped')}`);
  await user.click(trashOf(REMOVABLE));
  await user.click(within(dialog()).getByRole('button', { name: t('detail.deleteActivity') }));
  await waitFor(() => expect(posts()).toEqual([['/activities/a-L2/delete', undefined]]));
});

test('an orphan shows its branch and órfã · sem tarefa no fluxo; delete activity failed shows the task and the failure with the error (#181, #215, #322)', async () => {
  render(<WorktreesTab />);
  await screen.findByText('hive/9-gone');
  expect(findRow(ORPHAN)).toHaveTextContent(`—hive/9-gone${t('worktrees.orphan')}`);
  expect(screen.getByText('hive/9-gone')).toHaveAttribute('title', 'hive/9-gone');
  expect(findRow(FAILED)).toHaveTextContent('I3');
  expect(findRow(FAILED)).toHaveTextContent('#3 Done');
  const failed = within(findRow(FAILED)).getByText(t('worktrees.deleteActivityFailed'));
  expect(failed.closest('[title]')).toHaveAttribute('title', REFUSAL);
  expect(findRow(FAILED)).not.toHaveTextContent(REFUSAL); // only in the tooltip
  expect(trashOf(ORPHAN)).toBeEnabled();
});

test('× confirms with the orphan text and posts the slug route; a deleteActivity-failed row posts the task route; each answer reloads (#181)', async () => {
  const user = userEvent.setup();
  render(<WorktreesTab />);
  await screen.findByText('hive/9-gone');
  await user.click(trashOf(ORPHAN));
  expect(dialog()).toHaveAccessibleName('Apagar worktree'); // no task owns it: not an activity
  expect(dialog()).toHaveTextContent('branch: hive/9-gone');
  expect(dialog()).toHaveTextContent('tarefa: sem tarefa');
  expect(dialog()).toHaveTextContent('Nenhuma tarefa é dona dela');
  await user.click(within(dialog()).getByRole('button', { name: t('detail.deleteActivity') }));
  await waitFor(() => expect(gets()).toBe(2));
  await user.click(trashOf(FAILED));
  expect(dialog()).toHaveAccessibleName('Excluir atividade');
  expect(dialog()).toHaveTextContent('branch: hive/3-done');
  expect(dialog()).toHaveTextContent('tarefa: #3 Done');
  expect(dialog()).toHaveTextContent(REFUSAL);
  expect(dialog()).toHaveTextContent('a tarefa mantém a sessão');
  await user.click(within(dialog()).getByRole('button', { name: t('detail.deleteActivity') }));
  await waitFor(() => expect(gets()).toBe(3));
  expect(posts()).toEqual([['/worktrees/hive/hive-9-gone/remove', undefined], ['/activities/a-I3/delete', undefined]]);
});

test('apagar órfãs confirms with the count and posts each cleanable orphan without force, one after another; shows removed and refused; reloads (#181, #513)', async () => {
  const user = userEvent.setup();
  const blocked: WorktreeRow = { ...FAILED, slug: 'hive-4-open', task: { ...FAILED.task!, id: 'I4', activityId: 'a-I4', title: '#4 Open', removable: false } };
  rows = [ORPHAN, FAILED, blocked, RUNNING];
  answers = { '/activities/a-I3/delete': { removed: false, refused: REFUSAL } };
  render(<WorktreesTab />);
  await screen.findByText('hive/9-gone');
  const cleanAllButton = screen.getByRole('button', { name: t('worktrees.cleanOrphans') });
  expect(cleanAllButton).toBeEnabled();
  await user.click(cleanAllButton);
  expect(dialog()).toHaveTextContent('remover 2 worktrees órfãs sem forçar?');
  await user.click(within(dialog()).getByRole('button', { name: t('worktrees.cleanOrphans') }));
  expect(await screen.findByText('removidas: hive-9-gone')).toBeInTheDocument();
  expect(screen.getByText(`o git recusou hive-3-done: ${REFUSAL}`)).toBeInTheDocument();
  expect(posts()).toEqual([['/worktrees/hive/hive-9-gone/remove', undefined], ['/activities/a-I3/delete', undefined]]);
  await waitFor(() => expect(gets()).toBe(2));
});

test('with no orphan, the orphans view says so and apagar órfãs is disabled; with no worktree at all, the list says so (#513)', async () => {
  const user = userEvent.setup();
  rows = [RUNNING, DETACHED];
  render(<WorktreesTab />);
  await screen.findByText('HIVE-1 Local');
  expect(screen.getByRole('button', { name: t('worktrees.cleanOrphans') })).toBeDisabled();
  await user.click(screen.getByRole('radio', { name: 'órfãs · 0' }));
  expect(screen.getByText(t('worktrees.empty'))).toBeInTheDocument();
});

test('with no worktree at all the list says so', async () => {
  rows = [];
  render(<WorktreesTab />);
  expect(await screen.findByText(t('worktrees.none'))).toBeInTheDocument();
});

test('rows are grouped under their workspace, and an orphan\'s removal names its workspace (#179)', async () => {
  const user = userEvent.setup();
  rows = [ORPHAN, { ...ORPHAN, workspace: 'site', path: '/site/.hive/worktrees/hive-9-gone' }];
  render(<WorktreesTab />);
  const site = await screen.findByRole('region', { name: 'site' });
  expect(within(screen.getByRole('region', { name: 'hive' })).getByText('hive/9-gone')).toBeInTheDocument();
  await user.click(within(site).getByRole('button', { name: t('worktrees.remove') }));
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: t('detail.deleteActivity') }));
  await waitFor(() => expect(posts()).toEqual([['/worktrees/site/hive-9-gone/remove', undefined]]));
});

test('a failed start reads as its short message in the confirm and on hover, never the raw text (#945)', async () => {
  const user = userEvent.setup();
  const row: WorktreeRow = { ...FAILED, task: { ...FAILED.task!, error: `${SPAWN_FAILED}/repo has changes that are not committed:\n M src/app.ts` } };
  rows = [row];
  render(<WorktreesTab />);
  await screen.findByText('#3 Done');
  const short = t('start.failed.checkout_dirty');
  expect(within(findRow(row)).getByText(t('worktrees.deleteActivityFailed')).closest('[title]')).toHaveAttribute('title', short);
  await user.click(trashOf(row));
  expect(dialog()).toHaveTextContent(short);
  expect(dialog()).not.toHaveTextContent('not committed');
});

test('a kept worktree (its activity outlived its task, #861) reads as kept and its × posts the workspace route', async () => {
  const user = userEvent.setup();
  const KEPT: WorktreeRow = { ...ORPHAN, slug: 'hive-5-kept', path: '/repo/.hive/worktrees/hive-5-kept', branch: 'hive/5-kept', orphan: 'kept' };
  rows = [KEPT];
  render(<WorktreesTab />);
  await screen.findByText('hive/5-kept');
  expect(within(findRow(KEPT)).getByText(t('worktrees.kept'))).toBeInTheDocument();
  await user.click(trashOf(KEPT));
  await user.click(within(dialog()).getByRole('button', { name: t('detail.deleteActivity') }));
  await waitFor(() => expect(posts()).toEqual([['/worktrees/hive/hive-5-kept/remove', undefined]]));
});

test('a row names what its nested worktrees hold uncommitted, a clean one says nothing; the footer says they go first (#653)', async () => {
  rows = [{ ...REMOVABLE, nested: [{ path: 'docs', uncommitted: 2 }, { path: 'ee', uncommitted: 0 }] }, { ...ORPHAN, nested: [{ path: 'docs', uncommitted: 1 }] }];
  render(<WorktreesTab state={STATE} />);
  await screen.findByText('HIVE-2 Detached');
  expect(findRow(REMOVABLE)).toHaveTextContent(`Plan · ${t('worktrees.stopped')} · docs: 2 sem commit`);
  expect(findRow(REMOVABLE)).not.toHaveTextContent('ee:');
  expect(findRow(ORPHAN)).toHaveTextContent(`${t('worktrees.orphan')} · docs: 1 sem commit`);
  expect(screen.getByText(t('worktrees.footer'))).toHaveTextContent('remove antes as worktrees dos repos aninhados');
});
