import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspacesEditor } from '@/components/settings/WorkspacesEditor';
import { refusalText } from '@/components/DeleteActivity';
import { setLanguage, t } from '@/i18n';
import { emptyWorkspace, type WorkspaceDraft } from '@/lib/settings-form';
import type { HeldActivity, WorkspaceHoldings, WorktreeRow } from '../../src/types';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

// The × of a saved workspace card (#751): it reads what the workspace holds, and anything held opens the removal dialog.
const NONE: WorkspaceHoldings = { activities: [], worktrees: [], branches: [], tasks: [], running: false };
const act = (id: string, removable: HeldActivity extends infer H ? H : never): HeldActivity => ({ ...removable, activityId: `a-${id}`, task: { id, title: `Title ${id}` } }) as HeldActivity;
const GO1 = act('core-91', { removable: true } as HeldActivity);
const GO2 = act('core-94', { removable: true } as HeldActivity);
const orphan = (slug: string): WorktreeRow => ({ workspace: 'hive', slug, path: `/repo/${slug}`, branch: `hive/${slug}`, orphan: 'noTask', nested: [] });
const ORPHAN1 = orphan('core-88-headers');
const ORPHAN2 = orphan('core-80-spike');
const OWNED: WorktreeRow = { ...orphan('core-91-owned'), orphan: undefined, task: { id: 'core-91', activityId: 'a-core-91', title: 'Title core-91', removable: true } };
const FULL: WorkspaceHoldings = {
  activities: [GO1, GO2], worktrees: [OWNED, ORPHAN1, ORPHAN2], running: false,
  branches: [{ slug: 'core-91-owned', branch: 'hive/core-91-owned', target: 'main' }], tasks: [{ id: 'core-102', title: 'Webhook signatures v2' }],
};

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
let holdings: WorkspaceHoldings = NONE;
let readGate: Promise<void> | undefined;
let readFails = false;
let answers: Record<string, unknown> = {};
let postGates: Record<string, Promise<void>> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === '/workspaces/hive/holdings') {
    await readGate;
    return readFails ? new Response('{"error":"git exploded"}', { status: 500 }) : json(holdings);
  }
  if (init?.method === 'POST') { await postGates[url]; return json(answers[url] ?? { removed: true }); }
  return json({});
});
beforeEach(() => {
  setLanguage('pt'); holdings = NONE; readGate = undefined; readFails = false; answers = {}; postGates = {};
  fetchMock.mockClear(); toastError.mockClear(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// The editor over a saved 'hive' and an unsaved 'scratch'
function Harness() {
  const [rows, setRows] = useState<WorkspaceDraft[]>(() => [{ ...emptyWorkspace(), name: 'hive', path: '/repo' }, { ...emptyWorkspace(), name: 'scratch', path: '/scratch' }]);
  return <WorkspacesEditor workspaces={rows} savedNames={['hive']} onChange={setRows} onCapSaved={vi.fn()} />;
}
const xOf = (n: number) => screen.getByRole('button', { name: t('settings.workspaces.remove', { n }), hidden: true });
const hasCard = (name: string): boolean => screen.queryByRole('region', { name, hidden: true }) !== null;
const posts = (): [string, unknown][] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [String(url), init?.body]);
const reads = (): number => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/holdings')).length;
const dialog = () => within(screen.getByRole('alertdialog'));
const button = (key: Parameters<typeof t>[0]) => dialog().getByRole('button', { name: t(key) });
const OPEN = async (): Promise<ReturnType<typeof userEvent.setup>> => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(xOf(1));
  await screen.findByRole('alertdialog');
  return user;
};
const route = (id: string): string => `/activities/a-${id}/delete`;
const orphanRoute = (slug: string): string => `/worktrees/hive/${slug}/remove`;

test('a saved workspace that holds work opens the dialog already filled, listing activities, orphan worktrees, branches and tasks; the row stays', async () => {
  holdings = FULL;
  await OPEN();
  const d = dialog();
  expect(screen.getByRole('alertdialog', { name: t('settings.workspaces.removal.title', { name: 'hive' }) })).toBeInTheDocument();
  expect(d.getByText('Title core-91')).toBeInTheDocument();
  expect(d.getAllByText(t('settings.workspaces.removal.row.willGo'))).toHaveLength(2);
  expect(d.getByText('core-88-headers')).toBeInTheDocument();
  expect(d.queryByText('core-91-owned')).not.toBeInTheDocument(); // a task's worktree is covered by its activity
  expect(d.getAllByText(t('worktrees.orphan'))).toHaveLength(2);
  expect(d.getByText('hive/core-91-owned')).toBeInTheDocument();
  expect(d.getByText(t('settings.workspaces.removal.branch.target', { target: 'main' }))).toBeInTheDocument();
  expect(d.getByText('Webhook signatures v2')).toBeInTheDocument();
  expect(d.getByRole('heading', { name: /^tarefas/ })).toHaveTextContent(t('settings.workspaces.removal.tasks.hint', { name: 'hive' }));
  expect(hasCard('hive')).toBe(true);
});

test('a section with nothing in it is omitted', async () => {
  holdings = { ...NONE, activities: [GO1] };
  await OPEN();
  const heading = (key: Parameters<typeof t>[0]) => dialog().queryByRole('heading', { name: new RegExp(t(key)) });
  expect([heading('settings.workspaces.removal.activities') !== null, heading('settings.workspaces.removal.worktrees'), heading('settings.workspaces.removal.branches'), heading('settings.workspaces.removal.tasks')]).toEqual([true, null, null, null]);
});

test('a saved workspace that holds nothing leaves the form with no dialog', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(xOf(1));
  await waitFor(() => expect(hasCard('hive')).toBe(false));
  expect([reads(), screen.queryByRole('alertdialog')]).toEqual([1, null]);
});

test('an unsaved row leaves the form at once, with no read at all', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(xOf(2));
  expect([hasCard('scratch'), reads()]).toEqual([false, 0]);
});

test('the × is busy and disabled while the read is pending, then the dialog opens', async () => {
  holdings = FULL;
  let release = (): void => undefined;
  readGate = new Promise<void>((resolve) => { release = resolve; });
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(xOf(1));
  expect(xOf(1)).toBeDisabled();
  expect(xOf(1)).toHaveAttribute('aria-busy', 'true');
  expect(within(xOf(1)).getByTestId('spinner')).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  release();
  await screen.findByRole('alertdialog');
  expect(xOf(1)).not.toBeDisabled();
});

test('a failed read toasts with the i18n copy, never the server message, keeps the row, and a new click reads again', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  readFails = true;
  await user.click(xOf(1));
  await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  expect(toastError).toHaveBeenCalledWith(t('settings.workspaces.removal.readFailed', { name: 'hive' }), { description: t('settings.workspaces.removal.readFailed.hint') });
  expect([hasCard('hive'), xOf(1).hasAttribute('aria-busy') && xOf(1).getAttribute('aria-busy') === 'true']).toEqual([true, false]);
  readFails = false;
  await user.click(xOf(1));
  await waitFor(() => expect(reads()).toBe(2));
  expect(hasCard('hive')).toBe(false);
});

test('clean up and remove posts each removable activity then each orphan worktree, in order and never forced, then closes and drops the row', async () => {
  holdings = FULL;
  const user = await OPEN();
  await user.click(button('settings.workspaces.removal.cleanUp'));
  await waitFor(() => expect(hasCard('hive')).toBe(false));
  expect(posts()).toEqual([[route('core-91'), undefined], [route('core-94'), undefined], [orphanRoute('core-88-headers'), undefined], [orphanRoute('core-80-spike'), undefined]]);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('while cleaning: the progress line counts the posts, every button is disabled and the header × is gone', async () => {
  holdings = { ...NONE, activities: [GO1, GO2] };
  let release = (): void => undefined;
  postGates[route('core-91')] = new Promise<void>((resolve) => { release = resolve; });
  const user = await OPEN();
  await user.click(button('settings.workspaces.removal.cleanUp'));
  const d = dialog();
  expect(await d.findByText(t('settings.workspaces.removal.progress', { n: 1, total: 2 }))).toBeInTheDocument();
  expect(d.getByText(t('settings.workspaces.removal.row.deleting'))).toBeInTheDocument();
  expect(d.getByText(t('settings.workspaces.removal.row.queued'))).toBeInTheDocument();
  expect(d.getAllByRole('button').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  release();
  await waitFor(() => expect(hasCard('hive')).toBe(false));
});

test('a refusal stays listed with its reason and a force button; forcing posts { force: true } to that row only; none left, the row leaves', async () => {
  holdings = FULL;
  const refused = { reason: 'unmerged', branch: 'hive/core-80-spike', target: 'main' } as const;
  answers[orphanRoute('core-80-spike')] = { removed: false, refused };
  const user = await OPEN();
  await user.click(button('settings.workspaces.removal.cleanUp'));
  const alert = await dialog().findByRole('alert');
  expect(alert).toHaveTextContent(refusalText(refused));
  expect(dialog().getByText(t('settings.workspaces.removal.outcome', { removed: 3, refused: 1 }))).toBeInTheDocument();
  expect(dialog().queryByRole('button', { name: t('settings.workspaces.removal.cleanUp') })).not.toBeInTheDocument();
  expect(hasCard('hive')).toBe(true);
  answers[orphanRoute('core-80-spike')] = { removed: true };
  await user.click(dialog().getByRole('button', { name: t('task.force') }));
  const confirm = within(screen.getAllByRole('alertdialog').at(-1)!);
  expect(confirm.getByText(t('confirm.title.forceDelete'))).toBeInTheDocument();
  await user.click(confirm.getByRole('button', { name: t('task.force') }));
  await waitFor(() => expect(hasCard('hive')).toBe(false));
  expect(posts().slice(4)).toEqual([[orphanRoute('core-80-spike'), JSON.stringify({ force: true })]]);
});

test('a forced row that is refused again keeps its new reason and the row stays', async () => {
  holdings = { ...NONE, activities: [GO1] };
  answers[route('core-91')] = { removed: false, refused: { reason: 'dirty', path: '/p', files: 'a.ts' } };
  const user = await OPEN();
  await user.click(button('settings.workspaces.removal.cleanUp'));
  await dialog().findByRole('alert');
  answers[route('core-91')] = { removed: false, refused: { reason: 'unexpected' } };
  await user.click(dialog().getByRole('button', { name: t('task.force') }));
  await user.click(within(screen.getAllByRole('alertdialog').at(-1)!).getByRole('button', { name: t('task.force') }));
  await waitFor(() => expect(dialog().getByRole('alert')).toHaveTextContent(t('deleteActivity.refused.unexpected')));
  expect(hasCard('hive')).toBe(true);
});

test('a post that throws counts as refused with the unexpected wording', async () => {
  holdings = { ...NONE, activities: [GO1] };
  const user = await OPEN();
  fetchMock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await user.click(button('settings.workspaces.removal.cleanUp'));
  expect(await dialog().findByRole('alert')).toHaveTextContent(t('deleteActivity.refused.unexpected'));
});

test.each([['running'], ['deleting'], ['nothingToDelete'], ['local']] as const)('a %s activity shows its reason and is never posted', async (reason) => {
  const stays = act('core-99', { removable: false, reason } as HeldActivity);
  holdings = { ...NONE, activities: [GO1, stays] };
  const user = await OPEN();
  expect(dialog().getByText(t(`settings.workspaces.removal.reason.${reason}`))).toBeInTheDocument();
  await user.click(button('settings.workspaces.removal.cleanUp'));
  await waitFor(() => expect(hasCard('hive')).toBe(false));
  expect(posts().map(([url]) => url)).toEqual([route('core-91')]);
});

test('remove anyway drops the row and posts nothing', async () => {
  holdings = FULL;
  const user = await OPEN();
  await user.click(button('settings.workspaces.removal.removeAnyway'));
  await waitFor(() => expect(hasCard('hive')).toBe(false));
  expect([posts(), screen.queryByRole('alertdialog')]).toEqual([[], null]);
});

test('cancel closes the dialog and the row stays', async () => {
  holdings = FULL;
  const user = await OPEN();
  await user.click(dialog().getAllByRole('button', { name: t('settings.cancel') })[0]!);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect([hasCard('hive'), posts()]).toEqual([true, []]);
});

test('a running worker: the status line shows, the rows stay listed, and neither clean up nor remove anyway is offered', async () => {
  holdings = { ...FULL, running: true, activities: [act('core-91', { removable: false, reason: 'running' } as HeldActivity)] };
  await OPEN();
  const d = dialog();
  expect(d.getByText(t('settings.workspaces.removal.running', { name: 'hive' }))).toBeInTheDocument();
  expect(d.getByText(t('settings.workspaces.removal.running.hint'))).toBeInTheDocument();
  expect(d.getByText('Title core-91')).toBeInTheDocument();
  expect(d.queryByText(t('settings.workspaces.removal.lead.actions'))).not.toBeInTheDocument();
  for (const key of ['settings.workspaces.removal.cleanUp', 'settings.workspaces.removal.removeAnyway'] as const) expect(d.queryByRole('button', { name: t(key) })).not.toBeInTheDocument();
});

test("a task's worktree whose activity is not listed is shown with the orphans and deleted through its task's route", async () => {
  const kept: WorktreeRow = { ...orphan('core-77-kept'), orphan: 'kept', task: { id: 'core-77', activityId: 'a-core-77', title: 'Title core-77', removable: true } };
  holdings = { ...NONE, worktrees: [kept] };
  const user = await OPEN();
  expect(dialog().getByText('core-77-kept')).toBeInTheDocument();
  await user.click(button('settings.workspaces.removal.cleanUp'));
  await waitFor(() => expect(hasCard('hive')).toBe(false));
  expect(posts()).toEqual([[route('core-77'), undefined]]);
});

test("Enter on a refused row's force button opens that row's force confirm, never the dialog's remove anyway", async () => {
  holdings = { ...NONE, activities: [GO1] };
  answers[route('core-91')] = { removed: false, refused: { reason: 'unexpected' } };
  const user = await OPEN();
  await user.click(button('settings.workspaces.removal.cleanUp'));
  await dialog().findByRole('alert');
  dialog().getByRole('button', { name: t('task.force') }).focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByText(t('confirm.title.forceDelete'))).toBeInTheDocument();
  expect(hasCard('hive')).toBe(true);
});
