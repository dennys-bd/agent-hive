import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type ActivitiesNav, ActivitiesPanel, type ActivitiesPanelProps } from '@/components/ActivitiesPanel';
import { setLanguage, statusText, t } from '@/i18n';
import type { LocalActivity, TaskActivity } from '@/lib/activities';
import { readView } from '@/lib/view-state';
import type { ActivityRecord, Task, Stage } from '../../src/types';
import { localActivityId } from '../../src/activities';
import type { WithWork } from '../fixtures/work';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } })); // the batch's one toast is observable without a Toaster

const task = (id: string, title: string, project: string, stage = 'dev'): WithWork => ({
  item: { itemId: `I${id}`, id, title, body: '', url: '' }, stage, boardColumn: 'Ready', auto: true, workspace: project,
});
// The task's record (#629): 1h30 of work recorded
const records = (id: string): ActivityRecord[] => [{ id: `a-${id}`, taskIds: [`I${id}`], sessions: [], usage: { tokens: 0, ms: 95 * 60_000, waitingMs: 5 * 60_000, parts: [{ tokens: 0, ms: 95 * 60_000, waitingMs: 5 * 60_000 }] } }];
// Task 1 runs its stage and a session the user opened, plus a shell; task 2 has its worktree and nothing running (redesign 03)
const worker: TaskActivity = {
  kind: 'task', task: task('1', 'Task 1', 'hive'), status: 'waiting', worker: true, records: records('1'), record: records('1')[0],
  activity: { id: 'a-1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', branch: 'hive/1-task-1' }, // #629: the branch is the activity's
  runs: [{ ptyId: 'W1', label: 'Claude · abcdef12', kind: 'stage', session: 'abcdef12' }, { ptyId: 'W3', label: 'Claude', kind: 'session' }, { ptyId: 'W4', label: 'Terminal', kind: 'terminal' }],
  sessions: [
    { run: { ptyId: 'W1', label: 'Claude · abcdef12', kind: 'stage', session: 'abcdef12' }, status: 'waiting' },
    { run: { ptyId: 'W3', label: 'Claude', kind: 'session' }, status: 'working' },
  ],
};
const idle: TaskActivity = {
  kind: 'task', task: task('2', 'Task 2', 'site'), runs: [], sessions: [], status: 'empty', worker: false, records: records('2'), record: records('2')[0],
  activity: { id: 'a-2', kind: 'task', workspace: 'site', slug: 'site-2-task-2' },
};
const STAGES: Stage[] = [
  { name: 'dev', prompt: '/hive-build {url}', from: {} },
  { name: 'review', prompt: '/hive-review {url}', from: {} },
  { name: 'done', from: {} }, // no prompt: a task here is done (#586)
];
const quiet = (c: Task, local?: true): TaskActivity => ({
  kind: 'task', task: c, runs: [], sessions: [], status: 'empty', worker: false, records: records(c.item.id), record: records(c.item.id)[0],
  activity: { id: `a-${c.item.id}`, kind: 'task', workspace: 'hive', slug: `hive-${c.item.id}`, ...(local ? { local } : {}) }, // #629: local is the activity's
});
const reviewing = quiet(task('3', 'Task 3', 'hive', 'review'));
const finished = quiet(task('4', 'Task 4', 'hive', 'done'));
const onCheckout = quiet(task('5', 'Task 5', 'hive', 'done'), true);
const MANY = [worker, idle, reviewing, finished, onCheckout];
const stuck = quiet(task('6', 'Task 6', 'hive', 'done'));

const noop = (): void => {};
const navOf = (extra: Partial<ActivitiesNav> = {}): ActivitiesNav => ({ newActivity: noop, addWorkspace: noop, ...extra });
const props = (extra: Partial<ActivitiesPanelProps> = {}): ActivitiesPanelProps => ({
  activities: [worker, idle], workspaces: ['hive', 'site'], workers: [], stages: STAGES, onSelect: noop, onOpenRun: noop, nav: navOf(), ...extra,
});
const group = (name: string): HTMLElement => screen.getByRole('region', { name });
const row = (title: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${title}`) });
// Radix opens a DropdownMenu on pointerdown, which jsdom does not deliver as a PointerEvent; the keyboard path opens the same menu.
const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> => {
  screen.getByRole('button', { name }).focus();
  await user.keyboard('{Enter}');
};
const sessions = (): HTMLElement[] => screen.getAllByRole('button', { name: /^claude/ });
// The headed groups of a workspace (#586), by their names; sem agrupamento's one list has no header
const groupNames = (workspace: string): string[] =>
  within(group(workspace)).queryAllByRole('group').map((g) => g.getAttribute('aria-label') ?? '');
// The workspace views' own debounced post (#779) is the view state's business, not the panel's actions
const posts = (): string[] => vi.mocked(fetch).mock.calls
  .filter(([url, init]) => init?.method === 'POST' && !String(url).startsWith('/view-state/')).map(([url]) => String(url));

const WORKTREES = [{ itemId: 'I1', changed: 3, ahead: 1 }, { itemId: 'I2', changed: 0, ahead: 0 }];
const answer = (url: string): unknown => {
  if (url === '/workspaces/branches') return [{ name: 'hive', branch: 'docs/design-system' }, { name: 'site', branch: null }];
  if (url === '/activities/worktrees') return WORKTREES;
  if (url === '/activities/a-6/delete') return { removed: false, refused: 'worktree has changes' };
  if (url.endsWith('/delete')) return { removed: true };
  return { ok: true };
};

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(answer(url)), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});
afterEach(() => vi.unstubAllGlobals());

test('one group per workspace in the config\'s order, each opening with local and its checkout\'s branch, then its activities (redesign 03)', async () => {
  render(<ActivitiesPanel {...props()} />);
  await waitFor(() => expect(within(group('hive')).getByText('docs/design-system')).toBeInTheDocument());
  expect(within(group('hive')).getByRole('button', { name: /^local/ })).toBeInTheDocument();
  expect(within(group('hive')).getByText('#1 Task 1')).toBeInTheDocument();
  expect(within(group('site')).getByRole('button', { name: 'local' })).toBeInTheDocument(); // no branch read: the name alone
  expect(within(group('site')).getByText('#2 Task 2')).toBeInTheDocument();
});

test('an activity shows its title, worker only on the automation\'s, and its working time, even with nothing running (redesign 03)', () => {
  render(<ActivitiesPanel {...props()} />);
  expect(within(row('#1 Task 1')).getByText('worker')).toBeInTheDocument();
  expect(within(row('#1 Task 1')).getByText('1h30m')).toBeInTheDocument();
  expect(within(row('#2 Task 2')).queryByText('worker')).not.toBeInTheDocument();
});

test('the selected activity is aria-current on the muted fill, and a click on a row selects its task (#457)', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<ActivitiesPanel {...props({ selected: 'I2', onSelect })} />);
  expect(row('#2 Task 2')).toHaveAttribute('aria-current', 'true');
  expect(row('#2 Task 2').parentElement).toHaveClass('bg-muted', 'rounded-md'); // the whole block, sessions included (#586)
  expect(row('#1 Task 1').parentElement).not.toHaveClass('bg-muted');
  expect(row('#1 Task 1')).not.toHaveAttribute('aria-current');
  await user.click(row('#1 Task 1'));
  expect(onSelect).toHaveBeenCalledWith('I1');
});

test('each agent session lists its mark, the agent, its id and its own status; terminals are not listed (redesign 03)', () => {
  render(<ActivitiesPanel {...props()} />);
  const [stage, session] = sessions();
  expect(sessions()).toHaveLength(2);
  expect(stage.parentElement).toHaveClass('border-l', 'border-empty', 'ml-[2px]', 'pl-[9px]'); // the guide line inside the block (#586)
  expect(stage.parentElement?.parentElement).toBe(row('#1 Task 1').parentElement);
  expect(stage.querySelector('svg')).toHaveAttribute('data-icon', 'claude');
  expect(within(stage).getByText('abcdef12')).toHaveClass('font-mono');
  expect(within(stage).getByText('esperando você')).toBeInTheDocument();
  expect(within(session).getByText('trabalhando')).toBeInTheDocument();
  expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
});

test('a click on a session opens that run on its task; only the shown run of the selected activity is marked, on the task fill (#492)', async () => {
  const user = userEvent.setup();
  const onOpenRun = vi.fn();
  const { rerender } = render(<ActivitiesPanel {...props({ selected: 'I1', shown: 'W3', onOpenRun })} />);
  expect(sessions()[1]).toHaveAttribute('aria-current', 'true');
  expect(sessions()[1]).toHaveClass('bg-card', 'text-foreground');
  expect(sessions()[0]).not.toHaveAttribute('aria-current');
  await user.click(sessions()[0]);
  expect(onOpenRun).toHaveBeenCalledWith('I1', 'W1');
  rerender(<ActivitiesPanel {...props({ selected: 'I2', shown: 'W3' })} />);
  expect(sessions().filter((s) => s.getAttribute('aria-current') === 'true')).toEqual([]);
});

test('the selected activity with no tab open marks none of its lines shown (#759)', () => {
  render(<ActivitiesPanel {...props({ selected: 'I1', shown: undefined })} />);
  expect(row('#1 Task 1')).toHaveAttribute('aria-current', 'true');
  expect(sessions().filter((s) => s.hasAttribute('aria-current'))).toEqual([]);
});

test('local selects that workspace\'s local activity, marked once selected, and the chevron collapses its group (#590, redesign 03)', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const { rerender } = render(<ActivitiesPanel {...props({ onSelect })} />);
  await user.click(within(group('site')).getByRole('button', { name: 'local' }));
  expect(onSelect).toHaveBeenCalledWith('local/site');
  rerender(<ActivitiesPanel {...props({ onSelect, selected: 'local/site' })} />);
  expect(within(group('site')).getByRole('button', { name: 'local' })).toHaveAttribute('aria-current', 'true');
  await user.click(within(group('hive')).getByRole('button', { name: 'hive' }));
  expect(within(group('hive')).queryByText('#1 Task 1')).not.toBeInTheDocument();
  expect(within(group('hive')).getByRole('button', { name: 'hive' })).toHaveAttribute('aria-expanded', 'false');
});

test('a closed workspace is still closed when the panel mounts again, its state kept in the view state (#779)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<ActivitiesPanel {...props()} />);
  await user.click(within(group('site')).getByRole('button', { name: 'site' }));
  unmount();
  render(<ActivitiesPanel {...props()} />);
  expect(within(group('site')).getByRole('button', { name: 'site' })).toHaveAttribute('aria-expanded', 'false');
  expect(within(group('site')).queryByText('#2 Task 2')).not.toBeInTheDocument();
  expect(within(group('hive')).getByText('#1 Task 1')).toBeInTheDocument(); // the other workspace stays open
  expect(readView('activitiesView')).toMatchObject({ site: { isOpen: false }, hive: { isOpen: true } });
});

test('the + menu offers nova atividade… with its hint and adicionar workspace…; the footer and ⋯ open Settings on workspaces (redesign 03)', async () => {
  const user = userEvent.setup();
  const newActivity = vi.fn();
  const addWorkspace = vi.fn();
  render(<ActivitiesPanel {...props({ nav: navOf({ newActivity, addWorkspace }) })} />);
  await openMenu(user, 'nova atividade em hive');
  expect(screen.getByText('escolha uma tarefa ou crie uma nova')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: /nova atividade…/ }));
  expect(newActivity).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'adicionar workspace' }));
  await openMenu(user, 'opções de site');
  await user.click(screen.getByRole('menuitem', { name: 'configurações do workspace…' }));
  expect(addWorkspace).toHaveBeenCalledTimes(2);
});

test('a workspace\'s local sessions list under its local entry with their name and, while running, their status; a click on a stopped one continues it (#587)', async () => {
  const user = userEvent.setup();
  const [live, stopped] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  const record = { id: localActivityId('hive'), taskIds: [], sessions: [{ id: live, startedAt: '', stages: [], agent: 'claude' as const, lastUsedAt: '', name: 'no main' }, { id: stopped, startedAt: '', stages: [], agent: 'claude' as const, lastUsedAt: '' }] };
  // #629: the local sessions are the local activity's record's
  const local: LocalActivity = { kind: 'local', activity: { id: localActivityId('hive'), kind: 'local', workspace: 'hive' }, record, workspace: 'hive', runs: [], sessions: [], kept: [] };
  const workers = [{ id: 's', status: 'waiting' as const, runId: 'W9', activityId: localActivityId('hive'), sessionId: live, freeSession: true as const }];
  render(<ActivitiesPanel {...props({ activities: [local, worker, idle], workers })} />);
  const lines = within(group('hive')).getAllByRole('button', { name: /^claude/ }).slice(0, 2); // the local ones come first: the activity's own sessions follow
  expect(lines.map((l) => l.textContent)).toEqual(['claudeno mainesperando você', 'claudeb1b2c3d4dormindo']);
  await user.click(lines[1]);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/activities/local%3Ahive/sessions/${stopped}/open`, expect.objectContaining({ method: 'POST' })));
});

test('each activity\'s row has a second line with its branch and its worktree\'s state; limpa when clean; the state alone with no branch (#586)', async () => {
  render(<ActivitiesPanel {...props()} />);
  await waitFor(() => expect(within(row('#1 Task 1')).getByText('±3 · ↑1')).toBeInTheDocument());
  expect(within(row('#1 Task 1')).getByText('hive/1-task-1')).toHaveClass('font-mono', 'truncate');
  expect(within(row('#2 Task 2')).getByText('limpa')).toBeInTheDocument(); // task 2 has no branch yet
});

test('the ⋯ regroups a workspace by stage, status or none, ✓ on the active mode; done stays last in every mode (#586)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props({ activities: MANY })} />);
  expect(groupNames('hive')).toEqual(['dev', 'review', 'done']);
  await openMenu(user, 'opções de hive');
  expect(screen.getByText('agrupar por')).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: 'etapa' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('menuitemradio', { name: 'status' }));
  expect(groupNames('hive')).toEqual(['esperando você', 'parada', 'finalizado']);
  expect(groupNames('site')).toEqual(['dev']); // the other workspace keeps its own mode
  await openMenu(user, 'opções de hive');
  await user.click(screen.getByRole('menuitemradio', { name: 'sem agrupamento' }));
  expect(groupNames('hive')).toEqual(['finalizado']);
  expect(within(group('hive')).getByText('#3 Task 3')).toBeInTheDocument();
});

test('a workspace picked as sem agrupamento still shows its flat list when the panel mounts again (#779)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<ActivitiesPanel {...props({ activities: MANY })} />);
  await openMenu(user, 'opções de hive');
  await user.click(screen.getByRole('menuitemradio', { name: 'sem agrupamento' }));
  unmount();
  render(<ActivitiesPanel {...props({ activities: MANY })} />);
  expect(groupNames('hive')).toEqual(['finalizado']);
  expect(within(group('hive')).getByText('#3 Task 3')).toBeInTheDocument();
  expect(groupNames('site')).toEqual(['dev']); // the other workspace keeps its own mode
});

test('mostrar worktree off hides every worktree line of that workspace only (#586)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props()} />);
  await waitFor(() => expect(within(row('#1 Task 1')).getByText('±3 · ↑1')).toBeInTheDocument());
  await openMenu(user, 'opções de hive');
  const toggle = screen.getByRole('menuitemcheckbox', { name: 'mostrar worktree' });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  await user.click(toggle);
  expect(within(row('#1 Task 1')).queryByText('hive/1-task-1')).not.toBeInTheDocument();
  expect(within(row('#1 Task 1')).queryByText('±3 · ↑1')).not.toBeInTheDocument();
  expect(within(row('#2 Task 2')).getByText('limpa')).toBeInTheDocument();
});

test('done sits last and starts collapsed, with its count; its chevron opens it (#586)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props({ activities: MANY })} />);
  const header = within(within(group('hive')).getByRole('group', { name: 'done' })).getByRole('button', { name: /^done/ });
  expect(header).toHaveAttribute('aria-expanded', 'false');
  expect(within(header).getByText('2')).toBeInTheDocument();
  expect(within(group('hive')).queryByText('#4 Task 4')).not.toBeInTheDocument();
  expect(within(group('hive')).getByText('#3 Task 3')).toBeInTheDocument(); // review is open by default
  await user.click(header);
  expect(within(group('hive')).getByText('#4 Task 4')).toBeInTheDocument();
});

test('the ⋯ keeps configurações do workspace… and shows remover workspace… disabled (#586)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props()} />);
  await openMenu(user, 'opções de hive');
  expect(screen.getByRole('menuitem', { name: 'remover workspace…' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('menuitem', { name: 'configurações do workspace…' })).toBeInTheDocument();
});

test('a collapsed workspace shows its count and how many wait on the user; with none waiting, the count alone (#586)', async () => {
  const user = userEvent.setup();
  render(<ActivitiesPanel {...props({ activities: MANY })} />);
  await user.click(within(group('hive')).getByRole('button', { name: 'hive' }));
  expect(within(group('hive')).getByText('4 · 1 esperando você')).toBeInTheDocument();
  await user.click(within(group('site')).getByRole('button', { name: 'site' }));
  expect(within(group('site')).getByText('1')).toBeInTheDocument();
});

test('excluir todas… confirms the list, deletes each activity in turn, skips the checkout ones and toasts those that stayed with git\'s reason (#586)', async () => {
  const user = userEvent.setup();
  vi.mocked(toast.error).mockClear();
  render(<ActivitiesPanel {...props({ activities: [...MANY, stuck] })} />);
  await user.click(within(group('hive')).getByRole('button', { name: 'excluir todas…' }));
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent('#4 Task 4');
  expect(dialog).toHaveTextContent('#6 Task 6');
  expect(dialog).toHaveTextContent('Não podem ser excluídas, executam no checkout: #5 Task 5'); // toHaveTextContent folds the newline into a space
  expect(posts()).toEqual([]);
  expect(dialog).toHaveAccessibleName('Excluir atividades finalizadas');
  await user.click(within(dialog).getByRole('button', { name: 'excluir' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Estas atividades ficaram:\n#6 Task 6: worktree has changes', { className: 'whitespace-pre-line', duration: Infinity }));
  expect(posts()).toEqual(['/activities/a-4/delete', '/activities/a-6/delete']);
  expect(vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/activities/a-4/delete')?.[1]?.body).toBeUndefined(); // never forced
});

test('an activity in review or awaiting approval with no session at work shows it on its status line, worktree shown or not; a stopped one shows nothing (#663, #696)', async () => {
  const user = userEvent.setup();
  const inReview: TaskActivity = { ...quiet(task('7', 'Task 7', 'hive', 'review')), status: 'review' };
  const held: TaskActivity = { ...quiet(task('8', 'Task 8', 'hive')), status: 'approval' };
  render(<ActivitiesPanel {...props({ activities: [inReview, held, reviewing] })} />);
  expect(within(row('#7 Task 7')).getByText('aguardando review')).toHaveClass('text-review');
  expect(within(row('#8 Task 8')).getByText('aguardando aprovação')).toHaveClass('text-approval');
  expect(within(row('#3 Task 3')).queryByText('parada')).not.toBeInTheDocument();
  await openMenu(user, 'opções de hive');
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'mostrar worktree' }));
  expect(within(row('#7 Task 7')).getByText('aguardando review')).toBeInTheDocument();
});

test('the status line sits between the worktree line and the sessions: review in its colour, sleeping muted, both as status · sleeping, none without either (#696)', () => {
  const both: TaskActivity = { ...quiet(task('7', 'Task 7', 'hive')), status: 'review', sleeping: true };
  const asleepOnly: TaskActivity = { ...quiet(task('8', 'Task 8', 'hive')), sleeping: true };
  render(<ActivitiesPanel {...props({ activities: [both, asleepOnly, idle] })} />);
  expect(row('#7 Task 7')).toHaveTextContent(`${statusText('review')}·${t('session.sleeping')}`);
  expect(within(row('#8 Task 8')).getByText(t('session.sleeping'))).toHaveClass('text-muted-foreground');
  expect(row('#2 Task 2')).not.toHaveTextContent(t('session.sleeping'));
});

test('a task\'s kept terminals hang under its sessions on the guide line, terminal N and sleeping when asleep; a captured session\'s line opens its terminal (#696)', async () => {
  const user = userEvent.setup();
  const onOpenRun = vi.fn();
  const captured = { ptyId: 'W3', label: 'Claude', kind: 'session' as const, terminalId: 'W4' };
  const kept: TaskActivity = {
    ...worker, sessions: [worker.sessions[0], { run: captured, status: 'working' }],
    terminals: [{ terminalId: 'W4', label: 'Terminal 1', n: 1, asleep: false }, { terminalId: 'T9', label: 'Terminal 2', n: 2, asleep: true }],
  };
  render(<ActivitiesPanel {...props({ activities: [kept, idle], onOpenRun })} />);
  expect(screen.getByRole('button', { name: /^terminal 1/ })).not.toHaveTextContent(t('session.sleeping'));
  expect(screen.getByRole('button', { name: /^terminal 2/ })).toHaveTextContent(t('session.sleeping'));
  await user.click(sessions()[1]);
  expect(onOpenRun).toHaveBeenCalledWith('I1', 'W4');
});
