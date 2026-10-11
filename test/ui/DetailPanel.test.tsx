import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DetailPanel, type Selection } from '@/components/DetailPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import type { CommentsState } from '@/hooks/use-comments';
import { setLanguage } from '@/i18n';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { ActivityRecord, Stage, StageCommands, TaskFile, TaskPr, Shortcuts, Transition, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, SPAWN_FAILED } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork, withTasks, movedWork, withWork } from '../fixtures/work';

const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' },
  stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
  branch: 'hive/1-task-1', worktree: '/repo/.hive/worktrees/hive-1-task-1',
};
const worker: Worker = { id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1', tokens: 12345 };
// Task I1's record (#629): its sessions, PRs and usage; by default the one session its sessionId names
const rec = (made: Partial<Omit<ActivityRecord, 'id' | 'taskIds'>> = {}): ActivityRecord[] => [{ id: 'a-I1', taskIds: ['I1'], sessions: [], ...made }];
const RAN = rec({ sessions: [{ id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: '', stages: ['dev'], lastUsedAt: '' }] });
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [worker], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }], tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: RAN, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});
const TASK: Selection = { taskId: 'I1' };
const STOPPED: WithWork = { ...task, workerId: undefined }; // ran once: session, branch and worktree kept
const IDLE: State = withPointedWork({ ...state, workers: [{ id: 's1', status: 'empty' }], tasks: [STOPPED] });
const MERGED = "the branch 'hive/1-task-1' is not fully merged into HEAD"; // the pre-check's reason, as the route answers it
// The details panel's tooltip for each removalBlocker (#210)
const BLOCKED = {
  running: 'um worker ou sessão está executando nessa tarefa',
  deleting: 'a atividade já está sendo excluída',
  nothingToDelete: 'nada para excluir',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const posted = (body?: unknown) => expect.objectContaining({ method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const dialog = () => screen.getByRole('alertdialog');
const section = () => screen.getByRole('region', { name: 'comentários' });
// The panel's footer (#304, #341) and the menu behind its ⋯ (redesign 06), opened from the keyboard: Radix's way under jsdom
const footer = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="detail-footer"]')!;
async function menu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  within(footer()).getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  return screen.findByRole('menu');
}
const removeItem = (m: HTMLElement): HTMLElement => within(m).getByRole('menuitem', { name: /^excluir atividade/ });
// ⋯ › excluir atividade, then its confirm
async function askRemoval(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(removeItem(await menu(user)));
}
const aside = (): HTMLElement => screen.getByRole('complementary', { name: 'detalhe' });
// true when `a` comes before `b` in the document: the panel's reading order (#304)
const before = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
// A manual task (#164) with two Claude sessions and no automatic worker: task.workerId is never set (#216).
const manualWorker = (id: string, runId: string, extra: Partial<Worker> = {}): Worker => ({ id, status: 'working', activityId: activityIdOf('I1'), runId: runId, freeSession: true, ...extra });
const SESSIONS: State = withPointedWork({
  ...state,
  workers: [manualWorker('m1', 'aaaaaaaa-0000-4000-8000-000000000001', { tokens: 100 }), manualWorker('m2', 'bbbbbbbb-0000-4000-8000-000000000002', { status: 'waiting', question: 'which base?' })],
  tasks: [{ ...STOPPED, auto: false }],
});

// The transcript polls and the comments fetch on their own: both stubbed, so this file's fetch mock only sees the close POST.
let comments: CommentsState = { kind: 'unsupported' };
vi.mock('@/hooks/use-comments', () => ({ useComments: () => comments }));
let files: TaskFile[] = [];
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => files }));

// The panel as MainDock drives it (#342, #452): the body of the dock's Detalhes tab. `shown` says whether that tab is the shown tab of an
// open panel; `spy` sees every close of that panel. The selection lives outside and this panel never changes it.
function Panel({ state: s = state, initial, shown = true, spy = () => {} }: { state?: State; initial?: Selection; shown?: boolean; spy?: () => void }) {
  return <DetailPanel state={s} selected={initial} locale="pt-BR" isShown={shown} onClose={spy} />;
}

const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); comments = { kind: 'unsupported' }; files = []; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); setShortcuts({}); });

test('excluir atividade is always in ⋯: disabled with the reason in its label for a running task, one with manual sessions, one being cleaned and one with nothing to delete (#236); enabled for a stopped task with a worktree, a missing one included (#182, #210, redesign 06)', async () => {
  const user = userEvent.setup();
  const { worktree: _worktree, ...noWorktree } = STOPPED;
  const cases: [State, string | undefined][] = [
    [state, BLOCKED.running], // the file's running task: its worker is inside the worktree
    [SESSIONS, BLOCKED.running], // a manual task with two Claude sessions and no workerId (#164)
    [withTasks(IDLE, [{ ...STOPPED, deleting: true }]), BLOCKED.deleting], // #629: the mark and the worktree are the activity's
    [withTasks(IDLE, [noWorktree]), BLOCKED.nothingToDelete],
    [IDLE, undefined],
    [movedWork({ ...IDLE, tasks: [{ ...STOPPED, missing: true }] }), undefined],
  ];
  for (const [s, reason] of cases) {
    const { unmount } = render(<Panel state={s} initial={TASK} />);
    const item = removeItem(await menu(user));
    expect([item.hasAttribute('data-disabled'), item.textContent]).toEqual([reason !== undefined, reason === undefined ? 'excluir atividade' : `excluir atividade · ${reason}`]);
    unmount();
  }
});

test('limpar confirms, then posts with no body; a refusal opens the force popup with git\'s words even when it lands while the task is marked, manter focused; manter posts nothing more (#182)', async () => {
  const user = userEvent.setup();
  let answer: (res: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { rerender } = render(<Panel state={IDLE} initial={TASK} />);
  await askRemoval(user);
  expect(dialog()).toHaveTextContent('Excluir esta atividade? Isto apaga: • a worktree • o branch local • os terminais'); // today's scope (#236)
  expect(dialog()).not.toHaveTextContent('sessões');
  await user.click(within(dialog()).getByRole('button', { name: 'excluir atividade' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/delete', posted());
  rerender(<Panel state={withTasks(IDLE, [{ ...STOPPED, deleting: true }])} initial={TASK} />); // the route's mark reaches the panel before its answer
  expect(removeItem(await menu(user))).toHaveTextContent(`excluir atividade · ${BLOCKED.deleting}`);
  await user.keyboard('{Escape}');
  answer(reply({ removed: false, refused: MERGED }));
  const popup = await screen.findByRole('alertdialog');
  expect(popup).toHaveTextContent(MERGED);
  expect(popup).toHaveTextContent('perdidos de vez');
  expect(within(popup).getByRole('button', { name: 'manter' })).toHaveFocus();
  await user.click(within(popup).getByRole('button', { name: 'manter' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('forçar closes the popup and posts again with force true (#182)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementationOnce(async () => reply({ removed: false, refused: MERGED }));
  render(<Panel state={IDLE} initial={TASK} />);
  await askRemoval(user);
  await user.click(within(dialog()).getByRole('button', { name: 'excluir atividade' }));
  const popup = await screen.findByRole('alertdialog');
  await user.click(within(popup).getByRole('button', { name: 'forçar' }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/delete', posted({ force: true }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()); // the default mock's answer opens nothing
});

test('a stopped task shows its content with no tab bar (#209): its body rendered as markdown, or a muted line when the issue has none', () => {
  const stopped: WithWork = { ...task, workerId: undefined, item: { ...task.item, body: '## Plan\n\n- [ ] build' } };
  const idle: State = movedWork({ ...state, workers: [{ id: 's1', status: 'empty' }], tasks: [stopped] });
  const { unmount } = render(<Panel state={idle} initial={TASK} />);
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(screen.queryByText('sem descrição')).not.toBeInTheDocument();
  unmount();
  render(<Panel state={{ ...idle, tasks: [{ ...stopped, item: { ...stopped.item, body: '' } }] }} initial={TASK} />);
  expect(screen.getByText('sem descrição')).toBeInTheDocument();
});

test('comments: loading, then each one headed by author and local date linking to it with its body rendered; none; a failure inline; hidden on a board without comments', () => {
  const at = '2026-09-20T10:00:00Z';
  const panel = () => <Panel initial={TASK} />;
  comments = { kind: 'loading' };
  const { rerender } = render(panel());
  expect(section()).toHaveTextContent('carregando…');
  comments = { kind: 'list', comments: [{ author: 'ghost', createdAt: at, body: '**lgtm**', url: 'https://github.com/acme/r/issues/1#issuecomment-1' }] };
  rerender(panel());
  const link = within(section()).getByRole('link', { name: `ghost · ${new Date(at).toLocaleString('pt-BR')}` });
  expect(link).toHaveAttribute('href', 'https://github.com/acme/r/issues/1#issuecomment-1');
  expect(link).toHaveAttribute('target', '_blank');
  expect(within(section()).getByText('lgtm').tagName).toBe('STRONG');
  comments = { kind: 'list', comments: [] };
  rerender(panel());
  expect(section()).toHaveTextContent('sem comentários');
  comments = { kind: 'error', message: 'github api: HTTP 502' };
  rerender(panel());
  expect(section()).toHaveTextContent('não deu pra carregar os comentários: github api: HTTP 502');
  expect(screen.getByText('etapa dev')).toBeInTheDocument(); // the failure stays inside the section: the task data is still there
  comments = { kind: 'unsupported' };
  rerender(panel());
  expect(screen.queryByRole('region', { name: 'comentários' })).not.toBeInTheDocument();
});

test('a local task has no issue link and no board line: the title reads HIVE-1 without #, and its description is the body', () => {
  const local: WithWork = { ...task, workerId: undefined, created: true, boardColumn: '', item: { itemId: 'local:1', id: 'HIVE-1', title: 'Local', body: '## Steps', url: '' } };
  render(<Panel state={movedWork<State>({ ...state, workers: [{ id: 's1', status: 'empty' }], tasks: [local] })} initial={{ taskId: 'local:1' }} />);
  expect(screen.getByRole('heading', { name: 'HIVE-1 Local' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'issue' })).not.toBeInTheDocument();
  expect(screen.queryByText(/^board:/)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument();
});

test('the sessions section lists the task\'s sessions, oldest first: short id, the stages joined by →, the last use as a local clock; absent without any (#236, redesign 06)', () => {
  const used = '2026-09-24T15:30:00.000Z';
  const listed = rec({ sessions: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['spec', 'plan', 'build'], lastUsedAt: used },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', startedAt: '2026-09-23T10:00:00.000Z', stages: ['review'], lastUsedAt: used },
  ] });
  const { unmount } = render(<Panel state={movedWork({ ...IDLE, activityRecords: listed })} initial={TASK} />);
  const time = new Date(used).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const items = within(screen.getByRole('region', { name: 'sessões' })).getAllByRole('listitem').map((li) => li.textContent);
  expect(items).toEqual([`aaaaaaaaspec → plan → build · ${time}abrirlimpar`, `bbbbbbbbreview · ${time}abrirlimpar`]);
  unmount();
  const { sessionId: _sessionId, ...never } = STOPPED;
  render(<Panel state={movedWork({ ...IDLE, tasks: [never], activityRecords: [] })} initial={TASK} />);
  expect(screen.queryByRole('region', { name: 'sessões' })).not.toBeInTheDocument();
});

test('each session a worker may resume gets abrir, which posts that session\'s route; a session a worker holds reads aberta; a repo session ends with repo principal (#208, redesign 06)', async () => {
  const user = userEvent.setup();
  const used = '2026-09-24T15:30:00.000Z';
  const [a, b] = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'];
  const listed = rec({ sessions: [{ id: a, startedAt: used, stages: ['spec'], lastUsedAt: used, repo: true }, { id: b, startedAt: used, stages: ['dev'], lastUsedAt: used }] });
  const held: Worker = { id: 'm1', status: 'working', activityId: activityIdOf('I1'), runId: 'W2', freeSession: true, sessionId: b };
  render(<Panel state={movedWork({ ...IDLE, workers: [held], activityRecords: listed })} initial={TASK} />);
  const items = within(screen.getByRole('region', { name: 'sessões' })).getAllByRole('listitem');
  expect(items[0]).toHaveTextContent(/^aaaaaaaaspec · .+ · repo principalabrirlimpar$/);
  expect(within(items[1]).queryByRole('button', { name: 'abrir' })).not.toBeInTheDocument();
  expect(items[1]).toHaveTextContent(/aberta$/);
  await user.click(within(items[0]).getByRole('button', { name: 'abrir' }));
  expect(fetchMock).toHaveBeenLastCalledWith(`/activities/a-I1/sessions/${a}/open`, posted({}));
});

test('abrir attaches the run the route answered, no extra click on terminal: its detached window when it has one; no run, nothing (#249, #252)', async () => {
  const user = userEvent.setup();
  const focusDetached = vi.fn(async () => true);
  vi.stubGlobal('hive', { focusDetached });
  const listed = rec({ sessions: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-24T15:30:00.000Z', stages: ['spec'], lastUsedAt: '2026-09-24T15:30:00.000Z' }] });
  fetchMock.mockImplementationOnce(async () => reply({ ok: true, ptyId: 'W1' }));
  const { unmount } = render(<Panel state={movedWork({ ...IDLE, activityRecords: listed })} initial={TASK} />);
  await user.click(screen.getByRole('button', { name: 'abrir' }));
  await waitFor(() => expect(focusDetached).toHaveBeenCalledWith('W1'));
  unmount();
  focusDetached.mockClear();
  fetchMock.mockImplementationOnce(async () => reply({ ok: true }));
  render(<Panel state={movedWork({ ...IDLE, activityRecords: listed })} initial={TASK} />);
  await user.click(screen.getByRole('button', { name: 'abrir' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/activities/a-I1/sessions/${listed[0].sessions[0].id}/open`, posted({})));
  expect(focusDetached).not.toHaveBeenCalled();
});

test('the PR row lists every PR of the task, oldest first: #<n> linking to it and its state; sem PR without one (#207, redesign 06)', () => {
  const prs: TaskPr[] = [{ url: 'https://github.com/acme/r/pull/7', state: 'merged' }, { url: 'https://github.com/acme/r/pull/8', state: 'closed' }, { url: 'https://github.com/acme/r/pull/9', state: 'open' }];
  const { unmount } = render(<Panel state={movedWork({ ...IDLE, activityRecords: rec({ prs }) })} initial={TASK} />);
  const row = screen.getByText('PRs', { selector: 'dt' }).nextElementSibling as HTMLElement;
  expect(row).toHaveTextContent('#7 · mergeado#8 · fechado#9 · aberto');
  expect(within(row).getByRole('link', { name: '#9' })).toHaveAttribute('href', prs[2].url);
  expect(within(row).getByRole('link', { name: '#9' })).toHaveAttribute('target', '_blank');
  unmount();
  render(<Panel state={IDLE} initial={TASK} />);
  expect(screen.getByText('PRs', { selector: 'dt' }).nextElementSibling).toHaveTextContent('sem PR');
});

test('limpar\'s confirm lists only what the scope removes; in a delete activity stage a task with nothing to delete keeps the item, whose confirm says it only moves the task on, and posts the same route (#236)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Panel state={movedWork({ ...IDLE, deleteActivity: { session: true, transcripts: true, nonAutoTasks: false } })} initial={TASK} />);
  await askRemoval(user);
  expect(dialog()).toHaveTextContent('Excluir esta atividade? Isto apaga: • a worktree • o branch local • os terminais • as sessões do agente: a próxima execução começa uma nova • as transcrições das sessões no disco');
  unmount();
  const { worktree: _worktree, sessionId: _sessionId, ...bare } = STOPPED;
  const inDeleteActivity: State = movedWork({ ...IDLE, stages: [...IDLE.stages, { name: 'done', from: {}, action: 'deleteActivity' }], tasks: [{ ...bare, stage: 'done' }] });
  render(<Panel state={inDeleteActivity} initial={TASK} />);
  await askRemoval(user);
  expect(dialog()).toHaveTextContent('Nada para excluir nessa tarefa: ela segue para a próxima etapa.');
  await user.click(within(dialog()).getByRole('button', { name: 'excluir atividade' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/delete', posted());
});

test('resultados lists the files of the task\'s result below the sessions, key and file name, and never its PRs, which the PRs field already lists (#809); a click on a file opens it in the editor pane; absent with nothing produced (#258, #818, redesign 06)', async () => {
  const user = userEvent.setup();
  const openFile = vi.fn<OpenFile>(() => true);
  files = [{ key: 'spec', path: 'docs/spec.md', base: 'worktree' }, { key: 'plan', path: 'docs/plan.md', base: 'workspace' }];
  const { unmount } = render(<FileOpenerContext.Provider value={openFile}><Panel state={movedWork({ ...IDLE, activityRecords: rec({ sessions: RAN[0].sessions, prs: [{ url: 'https://github.com/acme/r/pull/9', state: 'open' }] }) })} initial={TASK} /></FileOpenerContext.Provider>);
  const results = screen.getByRole('region', { name: 'resultados' });
  expect(results).toHaveTextContent(/^resultadosspecspec\.mdplanplan\.md$/);
  expect(within(results).queryByRole('link')).not.toBeInTheDocument();
  expect(before(screen.getByRole('region', { name: 'sessões' }), results)).toBe(true);
  await user.click(within(results).getByRole('button', { name: 'plan.md' }));
  expect(openFile).toHaveBeenCalledWith('I1', 'docs/plan.md', undefined, { preview: true });
  unmount();
  files = [];
  render(<Panel state={IDLE} initial={TASK} />);
  expect(screen.queryByRole('region', { name: 'resultados' })).not.toBeInTheDocument();
});

test('after a delete activity a result file\'s click opens nothing and posts nothing: the IDE is gone (#629, #818)', async () => {
  const user = userEvent.setup();
  files = [{ key: 'spec', path: 'docs/spec.md', base: 'workspace' }];
  const kept = [{ id: 'a-old', taskIds: ['I1'], sessions: [] }, { id: 'a-new', taskIds: ['I1'], sessions: [] }];
  render(<Panel state={{ ...IDLE, activities: [], activityRecords: kept }} initial={TASK} />);
  await user.click(within(screen.getByRole('region', { name: 'resultados' })).getByRole('button', { name: 'spec.md' }));
  expect(fetchMock).not.toHaveBeenCalledWith('/activities/a-new/open-file', expect.anything());
});

test('the total row counts every run on the task: working time with the waiting left out, a running session included, and the tokens; zero while nothing is recorded (#248, redesign 06)', () => {
  const MINUTE = 60_000;
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const recorded = rec({ usage: { tokens: 3_400_000, ms: 90 * MINUTE, waitingMs: 30 * MINUTE } });
  const running: Worker = { ...worker, status: 'waiting', startedAt: ago(12 * MINUTE), waitingSince: ago(2 * MINUTE) };
  const total = (): Element | null => screen.getByText('total', { selector: 'dt' }).nextElementSibling;
  const { unmount } = render(<Panel state={movedWork({ ...state, workers: [running], activityRecords: recorded })} initial={TASK} />);
  expect(total()).toHaveTextContent('1h10m · 3.4M tokens'); // 90 + 12 minutes, less 30 + 2 waiting
  unmount();
  render(<Panel state={IDLE} initial={TASK} />);
  expect(total()).toHaveTextContent('0m · 0 tokens');
});

test('the panel has no tab bar whether or not a run holds the task: one pane, the task (#209, #283)', () => {
  render(<Panel initial={TASK} />); // the file's running task
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(screen.getByText('etapa dev')).toBeInTheDocument();
});

test('the body reads the title, the status box, the metadata, the sessions, the results, then behind a divider the issue (redesign 06)', () => {
  files = [{ key: 'spec', path: 'docs/spec.md', base: 'worktree' }];
  const produced: WithWork = { ...STOPPED, item: { ...STOPPED.item, body: 'the issue body' } };
  render(<Panel state={movedWork({ ...IDLE, tasks: [produced] })} initial={TASK} />);
  const order = [
    screen.getByRole('heading', { name: '#1 Task 1' }), screen.getByRole('region', { name: 'parada' }), screen.getByText('branch', { selector: 'dt' }),
    screen.getByRole('region', { name: 'sessões' }), screen.getByRole('region', { name: 'resultados' }), screen.getByText('the issue body'),
  ];
  expect(order.slice(1).map((el, i) => before(order[i], el))).toEqual([true, true, true, true, true]);
  expect(order.map((el) => el.closest('.border-t') !== null)).toEqual([false, false, false, false, false, true]);
});

test('each session a worker may resume gets limpar beside abrir, which posts that session\'s clear at once, no confirm; a held session has neither; the bulk clear is gone (#304)', async () => {
  const user = userEvent.setup();
  const used = '2026-09-24T15:30:00.000Z';
  const [a, b] = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'];
  const listed = rec({ sessions: [{ id: a, startedAt: used, stages: ['spec'], lastUsedAt: used }, { id: b, startedAt: used, stages: ['dev'], lastUsedAt: used }] });
  const held: Worker = { id: 'm1', status: 'working', activityId: activityIdOf('I1'), runId: 'W2', freeSession: true, sessionId: a };
  render(<Panel state={movedWork({ ...IDLE, workers: [held], activityRecords: listed })} initial={TASK} />);
  const items = within(within(screen.getByRole('region', { name: 'sessões' })).getByRole('list')).getAllByRole('listitem');
  expect(within(items[0]).queryAllByRole('button')).toEqual([]);
  expect(within(items[1]).getAllByRole('button').map((btn) => btn.textContent)).toEqual(['abrir', 'limpar']);
  await user.click(within(items[1]).getByRole('button', { name: 'limpar' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenLastCalledWith(`/activities/a-I1/sessions/${b}/clear`, posted());
  expect(screen.queryByRole('button', { name: /sessões antigas/ })).not.toBeInTheDocument();
});

test('a task awaiting approval with a held session gets its status box: time left, aprovar and estender, and under them the feedback box, sent with enviar (#268, #685)', async () => {
  const user = userEvent.setup();
  const until = new Date(Date.now() + 5 * 60_000).toISOString();
  const held: State = movedWork({ ...state, workers: [{ ...worker, status: 'approval' }], tasks: [{ ...task, approval: { since: new Date().toISOString(), until } }] });
  render(<Panel state={held} initial={TASK} />);
  const band = screen.getByRole('region', { name: 'aguardando aprovação' });
  expect(band).toHaveTextContent('etapa dev');
  expect(within(band).getByText(/resta \d+m/)).toBeInTheDocument();
  await user.click(within(band).getByRole('button', { name: 'estender' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approval/extend', posted());
  await user.click(within(band).getByRole('button', { name: 'aprovar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approve', posted());
  expect(within(band).queryByRole('button', { name: 'enviar feedback…' })).not.toBeInTheDocument();
  expect(within(band).queryByRole('button', { name: 'começar agora' })).not.toBeInTheDocument();
  expect(within(band).getByRole('button', { name: 'enviar' })).toBeDisabled();
  await user.type(within(band).getByLabelText('Feedback'), 'split the spec');
  await user.click(within(band).getByRole('button', { name: 'enviar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'split the spec', start: true }));
});

test('a task awaiting approval with no session held gets aprovar and the feedback box with começar agora and na ordem, no estender; a task awaiting nothing reads parada with neither (#268, #685)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Panel state={IDLE} initial={TASK} />);
  const idle = within(screen.getByRole('region', { name: 'parada' }));
  expect(idle.queryByRole('button', { name: 'aprovar' })).not.toBeInTheDocument(); // continuar is #580's
  expect(idle.queryByLabelText('Feedback')).not.toBeInTheDocument();
  rerender(<Panel state={movedWork({ ...IDLE, tasks: [{ ...STOPPED, approval: { since: new Date().toISOString() } }] })} initial={TASK} />);
  const band = screen.getByRole('region', { name: 'aguardando aprovação' });
  expect(within(band).queryByRole('button', { name: 'estender' })).not.toBeInTheDocument();
  expect(within(band).queryByRole('button', { name: 'enviar' })).not.toBeInTheDocument();
  await user.type(within(band).getByLabelText('Feedback'), 'add tests');
  await user.click(within(band).getByRole('button', { name: 'na ordem' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'add tests', start: false }));
  await user.click(within(band).getByRole('button', { name: 'começar agora' })); // the test's state still awaits: the box stays, its text kept
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'add tests', start: true }));
});

test('a task in a manual gate with no session at all gets aprovar and the feedback box, no estender (#685)', async () => {
  const user = userEvent.setup();
  const gated: State = withTasks({ ...IDLE, stages: [{ name: 'dev', from: { board: ['Ready'] }, approval: true }], activityRecords: rec() }, [{ ...STOPPED, approval: { since: new Date().toISOString() } }]);
  render(<Panel state={gated} initial={TASK} />);
  const band = screen.getByRole('region', { name: 'aguardando aprovação' });
  expect(within(band).queryByRole('button', { name: 'estender' })).not.toBeInTheDocument();
  await user.click(within(band).getByRole('button', { name: 'aprovar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approve', posted());
  await user.type(within(band).getByLabelText('Feedback'), 'tighten the scope');
  await user.click(within(band).getByRole('button', { name: 'começar agora' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'tighten the scope', start: true }));
});

test('a task in a manual gate whose previous stage ran gets the status box of a task with no held session: aprovar and the feedback box with começar agora and na ordem (HIVE-2, #685)', async () => {
  const user = userEvent.setup();
  const used = '2026-09-26T10:00:00.000Z';
  const reviewed: State = withTasks({
    ...IDLE,
    stages: [{ name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' }, { name: 'dev', from: { board: ['Ready'] }, approval: true }], // dev is the gate
    activityRecords: rec({ sessions: [{ id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: used, stages: ['spec'], lastUsedAt: used }] }),
  }, [{ ...STOPPED, approval: { since: new Date().toISOString() } }]);
  render(<Panel state={reviewed} initial={TASK} />);
  const band = screen.getByRole('region', { name: 'aguardando aprovação' });
  expect(within(band).queryByRole('button', { name: 'enviar feedback…' })).not.toBeInTheDocument();
  await user.type(within(band).getByLabelText('Feedback'), 'tighten the scope');
  await user.click(within(band).getByRole('button', { name: 'na ordem' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'tighten the scope', start: false }));
  await user.click(within(band).getByRole('button', { name: 'começar agora' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', posted({ text: 'tighten the scope', start: true }));
});

test('the panel is a docked aside, never a dialog, and opening it leaves the focus where it was; the title opens the body, with no X of its own (#341, #342)', () => {
  render(<Panel initial={TASK} />);
  expect(aside().tagName).toBe('ASIDE');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body).toHaveFocus();
  expect(screen.getByRole('heading', { name: '#1 Task 1' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /fechar|close/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('separator')).not.toBeInTheDocument(); // the dock group's divider sizes it now
});

test('Escape closes the panel holding Detalhes wherever the focus is and keeps the task; a confirm, a text field or a terminal keeps its own Escape (#341, #426, #452)', async () => {
  const user = userEvent.setup();
  const spy = vi.fn();
  render(
    <>
      <button type="button">task do board</button>
      <input aria-label="campo" />
      <div className="xterm"><textarea aria-label="terminal" /></div>
      <Panel state={IDLE} initial={TASK} spy={spy} />
    </>,
  );
  await askRemoval(user);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  for (const name of ['campo', 'terminal']) {
    screen.getByRole('textbox', { name }).focus();
    await user.keyboard('{Escape}');
  }
  expect(spy).not.toHaveBeenCalled();
  screen.getByRole('button', { name: 'task do board' }).focus();
  await user.keyboard('{Escape}');
  expect(spy).toHaveBeenCalledTimes(1);
  expect(aside()).toBeInTheDocument(); // the selection stays: the dock only collapses the panel
});

test('Escape with nothing focused closes the panel (#426, #452)', async () => {
  const user = userEvent.setup();
  const spy = vi.fn();
  render(<Panel initial={TASK} spy={spy} />);
  (document.activeElement as HTMLElement | null)?.blur();
  await user.keyboard('{Escape}');
  expect(spy).toHaveBeenCalledTimes(1);
});

test('Escape does nothing while Detalhes is not the shown tab of an open panel, and closes it once it is (#452)', async () => {
  const user = userEvent.setup();
  const spy = vi.fn();
  const { rerender } = render(<Panel initial={TASK} shown={false} spy={spy} />);
  await user.keyboard('{Escape}');
  expect(spy).not.toHaveBeenCalled();
  rerender(<Panel initial={TASK} shown spy={spy} />);
  await user.keyboard('{Escape}');
  expect(spy).toHaveBeenCalledTimes(1);
});

test('with no task selected, or one no longer in the state, the body is the empty state Nenhuma tarefa selecionada and no task aside (#452)', () => {
  const { unmount } = render(<Panel />);
  expect(screen.getByText('Nenhuma tarefa selecionada')).toBeInTheDocument();
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  unmount();
  render(<Panel initial={{ taskId: 'gone' }} />);
  expect(screen.getByText('Nenhuma tarefa selecionada')).toBeInTheDocument();
});

test('Escape is a fixed key: alone it closes the panel, with a modifier it does not, and no shortcuts map moves it, a stale one naming closePanel included (#481)', async () => {
  const user = userEvent.setup();
  const spy = vi.fn();
  setShortcuts({ closePanel: 'CmdOrCtrl+Shift+X' } as unknown as Shortcuts); // a map from before #481
  render(<Panel initial={TASK} spy={spy} />);
  await user.keyboard('{Control>}{Shift>}x{/Shift}{/Control}');
  await user.keyboard('{Shift>}{Escape}{/Shift}');
  expect(spy).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(spy).toHaveBeenCalledTimes(1);
});

test('a pointerdown and click anywhere outside the panel never closes it: a docked panel is no dismissable layer (#341, replaces the #184 guard)', async () => {
  const user = userEvent.setup();
  const spy = vi.fn();
  render(
    <>
      <button type="button">outro task</button>
      <Panel initial={TASK} spy={spy} />
    </>,
  );
  await user.click(screen.getByRole('button', { name: 'outro task' }));
  await user.click(document.body);
  expect(spy).not.toHaveBeenCalled();
  expect(aside()).toBeInTheDocument();
});

test('⋯ has no excluir atividade on a checkout task: there is no worktree to remove (#444)', async () => {
  const user = userEvent.setup();
  render(<Panel state={withTasks(IDLE, [{ ...STOPPED, local: true }])} initial={TASK} />);
  expect(within(await menu(user)).queryByRole('menuitem', { name: /^excluir atividade/ })).not.toBeInTheDocument();
});

test('a task\'s error shows in full at the top of the body, above the approval band, and is gone once the task no longer carries it (#482)', () => {
  const error = "cleanup refused: the branch 'hive/1-task-1' is not fully merged into HEAD\nrun it again with force to delete it anyway";
  const failed: State = movedWork({ ...IDLE, tasks: [{ ...STOPPED, error, approval: { since: new Date().toISOString() } }] });
  const { rerender } = render(<Panel state={failed} initial={TASK} />);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toBe(error); // the whole text, line break included, never truncated
  expect(before(alert, screen.getByRole('region', { name: 'aguardando aprovação' }))).toBe(true);
  const approval = failed.activities.find((a) => a.kind === 'task')?.approval; // #629: the activity's
  rerender(<Panel state={movedWork({ ...IDLE, tasks: [{ ...STOPPED, approval }] })} initial={TASK} />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('while a commands stage runs, the running block takes the status box\'s place; once it ends the status box is back (#914)', () => {
  const checks: Stage = { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build'], stopOnFailure: true };
  const run: StageCommands = { stage: 'checks', at: 0, ptyId: 'P0', runId: 'R0', failed: [], workerId: 'w1', started: [] };
  const running = withWork({ ...IDLE, stages: [...IDLE.stages, checks] }, 'I1', { commands: run });
  const { rerender } = render(<Panel state={running} initial={TASK} />);
  expect(screen.getByRole('region', { name: 'executando checks' })).toBeInTheDocument();
  expect(screen.queryByText(/^etapa dev/)).not.toBeInTheDocument();
  rerender(<Panel state={IDLE} initial={TASK} />);
  expect(screen.queryByRole('region', { name: 'executando checks' })).not.toBeInTheDocument();
  expect(screen.getByText(/^etapa dev/)).toBeInTheDocument();
});

test('a task out of tries shows the exhausted block in place of the status box and no raw error line; with tries left the tentativas section sits under the status box (#916)', () => {
  const key = '["dev","verdict","failed"]';
  const loop: Transition = { from: 'dev', to: 'dev', when: 'verdict', verdict: 'failed', maxTries: 3 };
  const at = '2026-10-11T10:00:00.000Z';
  const out = withWork({ ...IDLE, transitions: [loop] }, 'I1', { stopped: true, error: 'tries out: verdict:failed · 3', tries: { [key]: 3 } }, { sessions: RAN[0].sessions });
  const { unmount } = render(<Panel state={out} initial={TASK} />);
  expect(screen.getByRole('region', { name: 'tentativas esgotadas' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();
  const left = withWork({ ...IDLE, transitions: [loop] }, 'I1', { via: key, tries: { [key]: 1 }, tryLog: [{ transition: key, n: 1, max: 3, cause: 'lint', error: '', at, stage: 'dev' }] }, { sessions: RAN[0].sessions });
  render(<Panel state={left} initial={TASK} />);
  expect(screen.queryByRole('region', { name: 'tentativas esgotadas' })).not.toBeInTheDocument();
  const tries = screen.getByText('tentativas').closest('details') as HTMLElement;
  expect(before(screen.getAllByRole('region')[0], tries)).toBe(true); // the status box first, then the section
});

test('a failed start shows its short message in the viewer\'s language; the raw text (path, git\'s lines) only behind detalhes, closed by default (#945)', async () => {
  const user = userEvent.setup();
  const raw = '/repo has changes that are not committed:\n M src/app.ts\n?? notes.md';
  render(<Panel state={movedWork({ ...IDLE, tasks: [{ ...STOPPED, error: SPAWN_FAILED + raw }] })} initial={TASK} />);
  const alert = screen.getByRole('alert');
  expect(within(alert).getByText('o workspace tem mudanças não commitadas: faça commit ou stash e inicie de novo')).toHaveClass('text-destructive');
  expect(alert).not.toHaveTextContent('/repo');
  const toggle = within(alert).getByRole('button', { name: 'detalhes' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(alert).toHaveTextContent('/repo has changes that are not committed: M src/app.ts ?? notes.md');
  expect(alert).not.toHaveTextContent('start failed');
  await user.click(toggle);
  expect(alert).not.toHaveTextContent('/repo');
});
