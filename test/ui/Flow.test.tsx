import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { FlowShownContext } from '@/components/MainDock';
import { setLanguage, t } from '@/i18n';
import { MARGIN } from '@/lib/flow-layout';
import { readView, resetViewState } from '@/lib/view-state';
import type { ActivityRecord, BaseOptions, Item, Task, Session, Stage, Transition, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const task = (id: string, stage: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}` }, stage, boardColumn: 'Ready', auto: true, ...extra,
});
// Task 1's kept sessions, in its record (#629)
const rec = (sessions: Session[]): ActivityRecord[] => [{ id: 'a-I1', taskIds: ['I1'], sessions }];
const worker = (id: string, taskId?: string): Worker => ({ id, status: taskId ? 'working' : 'empty', ...(taskId ? { activityId: activityIdOf(taskId), ptyId: `w-${id}` } : {}) });
const state = (tasks: WithWork[], workers: Worker[], cols: Stage[] = stages, sourceOrder: string[] = []): State =>
  withPointedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: workers.length, workers, stages: cols, tasks, sourceOrder, localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] });
const titles = () => screen.getAllByText(/^#\d Task/).map((el) => el.textContent);
const header = (name: string): HTMLElement => screen.getByRole('heading', { level: 3, name }).parentElement!; // a stage's header row (#542)

// jsdom has no DataTransfer: the stub carries what dragStart set to the drop, as the browser's would. Reused across the events of one drag.
const dataTransfer = () => {
  const data = new Map<string, string>();
  return { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: 'move', dropEffect: 'move' };
};

// jsdom's own getBoundingClientRect is all zeros: stub a fixed box so a clientY above/below its midpoint (20) reads as the
// upper/lower half, whichever task the event fires on.
const stubTaskRect = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 40, height: 40, left: 0, right: 0, width: 100, x: 0, y: 0, toJSON: () => undefined } as DOMRect);

// jsdom has no DragEvent constructor, so a clientY passed through fireEvent.dragOver/drop's init is silently dropped (it falls
// back to a plain Event, which ignores unknown init keys); these set it directly on the dispatched event instead.
const dragOverAt = (el: Element, dt: unknown, clientY: number) => fireEvent(el, Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer: dt, clientY }));
const dropAt = (el: Element, dt: unknown, clientY: number) => fireEvent(el, Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt, clientY }));

// GET /tasks/:id/bases answers `bases` (a task that already has its worktree, unless a test says otherwise); every POST answers ok.
const WITH_WORKTREE: BaseOptions = { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] };
const NO_WORKTREE: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: ['feature-x'], remote: [] };
let bases = WITH_WORKTREE;
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
  new Response(JSON.stringify(String(input).endsWith('/bases') ? bases : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); bases = WITH_WORKTREE; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('a missing task offers fechar / manter; fechar asks once, with no worktree question, and posts close with no body; manter posts keep (#182)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state([task('1', 'dev', { missing: true })], [worker('s1')])} />);
  expect(screen.getByText('sumiu da source')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'manter' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/keep', expect.objectContaining({ method: 'POST' }));
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('fechar essa tarefa? A sessão termina e a tarefa sai do Hive.');
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'fechar' }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/close', expect.objectContaining({ method: 'POST', body: undefined }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
});

test('a running task shows abrir and no iniciar; a blocked task and a stage without prompt show no button (#542)', () => {
  const running = task('1', 'dev', { workerId: 's1', branch: 'hive-1-task-1' });
  render(<Flow state={state([running, task('2', 'dev', { item: { ...task('2', 'dev').item, blockedBy: ['1'] } }), task('3', 'review')], [worker('s1', 'I1'), worker('s2')])} />);
  expect(screen.getByRole('button', { name: 'abrir' })).toBeInTheDocument();
  expect(screen.getByText('⊘ bloqueada por 1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'iniciar' })).not.toBeInTheDocument();
  expect(screen.getByText('trabalhando')).toBeInTheDocument();
  expect(screen.queryByText('vazia')).not.toBeInTheDocument(); // both stages have a task
});

test('a task awaiting approval shows Aprovar on the board task itself; clicking it posts approve and does not open the panel (#349)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const waiting = task('1', 'dev', { approval: { since: '2026-09-25T10:00:00.000Z' } });
  render(<Flow state={state([waiting], [worker('s1')])} onOpen={onOpen} />);
  await user.click(screen.getByRole('button', { name: 'aprovar' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/approve', expect.objectContaining({ method: 'POST' })));
  expect(onOpen).not.toHaveBeenCalled();
});

test('a task not awaiting approval shows no Aprovar on the board task (#349)', () => {
  render(<Flow state={state([task('1', 'dev')], [worker('s1')])} />);
  expect(screen.queryByRole('button', { name: 'aprovar' })).not.toBeInTheDocument();
});

test('a stage header shows its name, the count the source pick lets through, auto when the stage has a prompt or an action whatever its cap, and no +; an empty stage still shows the empty body line (#316, #542)', () => {
  const cols: Stage[] = [...stages, { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' }, { name: 'capped', from: { board: ['X'] }, prompt: '/x', maxWorkers: 0 }];
  const { rerender } = render(<Flow state={state([], [worker('s1')], cols)} />);
  expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['dev', 'review', 'done', 'capped']);
  expect(within(header('dev')).getByText('0')).toBeInTheDocument();
  expect(within(header('dev')).queryByText('auto')).not.toBeInTheDocument(); // the stage's auto is gone (#134)
  expect(screen.queryByText('manual')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /nova tarefa/ })).not.toBeInTheDocument();
  expect(screen.getAllByText('vazia')).toHaveLength(4);
  rerender(<Flow state={state([task('1', 'dev')], [worker('s1')], cols)} />);
  expect(within(header('dev')).getByText('1')).toBeInTheDocument();
});

// The Start dialog's executar etapas, once the bases it read let it go
async function runStages(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const run = within(await screen.findByRole('dialog')).getByRole('button', { name: /executar etapas/ });
  await waitFor(() => expect(run).toBeEnabled());
  await user.click(run);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

test('iniciar opens the Start dialog even on a task that already has its worktree: it asks no base, and executar etapas posts start, with or without a free worker (redesign 10, 11)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Flow state={state([task('3', 'dev')], [worker('s1')])} />);
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  expect(screen.getByRole('dialog', { name: 'Iniciar #3' })).toBeInTheDocument();
  await runStages(user);
  expect(fetchMock).toHaveBeenCalledWith('/tasks/I3/bases');
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I3/start', expect.objectContaining({ method: 'POST', body: '{}' }));
  rerender(<Flow state={state([task('1', 'dev', { workerId: 's1' }), task('3', 'dev')], [worker('s1', 'I1')])} />); // every worker taken
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  await runStages(user);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I3/start', expect.objectContaining({ method: 'POST', body: '{}' }));
});

test('a stopped task in a delete activity stage offers excluir, not iniciar, even without a free worker and posts start straight away, whatever the blockers; a stopped task in a prompt stage still offers iniciar (#210)', async () => {
  const user = userEvent.setup();
  const cleanup: Stage[] = [stages[0], { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity', after: '5d' }];
  const blocked = task('2', 'done', { item: { ...task('2', 'done').item, blockedBy: ['1'] } });
  render(<Flow state={state([task('1', 'dev', { workerId: 's1' }), blocked, task('3', 'dev')], [worker('s1', 'I1')], cleanup)} />);
  expect(screen.queryByText('bloqueada por 1')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'iniciar' })).toHaveLength(1); // task 3, stopped in dev
  await user.click(screen.getByRole('button', { name: 'excluir' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I2/start', expect.objectContaining({ method: 'POST', body: undefined }));
});

test('a task in a delete-activity stage hides excluir while a free session is open on it and shows it once it closes; a terminal does not hide it (#228, #573)', () => {
  const deleting: Stage[] = [stages[0], { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' }];
  const session: Worker = { ...worker('s1', 'I1'), freeSession: true };
  const { rerender } = render(<Flow state={state([task('1', 'done')], [session], deleting)} />);
  expect(screen.queryByRole('button', { name: 'excluir' })).not.toBeInTheDocument();
  rerender(<Flow state={withPointedWork({ ...state([task('1', 'done')], [worker('s1')], deleting), terminals: [{ terminalId: 'sh1', activityId: activityIdOf('I1'), startedAt: '2026-09-26T00:00:00Z', cwd: '/repo' }] })} />);
  expect(screen.getByRole('button', { name: 'excluir' })).toBeInTheDocument();
  rerender(<Flow state={state([task('1', 'done')], [worker('s1')], deleting)} />);
  expect(screen.getByRole('button', { name: 'excluir' })).toBeInTheDocument();
});

test('the upper half of a task shows the line before it and posts before it; the lower half shows and posts before the next task in the stage, or the end on the last one', () => {
  const rect = stubTaskRect();
  render(<Flow state={state([task('1', 'dev'), task('2', 'dev'), task('3', 'dev'), task('4', 'dev')], [worker('s1')])} />);
  const [one, , three, four] = ['#1 Task 1', '#2 Task 2', '#3 Task 3', '#4 Task 4'].map((text) => screen.getByText(text).closest('li')!);
  const dt = dataTransfer();

  fireEvent.dragStart(one, { dataTransfer: dt });
  dragOverAt(three, dt, 10); // upper half: before task 3
  expect(three).toHaveAttribute('data-drop', 'before');
  dropAt(three, dt, 10);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: JSON.stringify({ before: 'I3' }) }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
  fetchMock.mockClear();

  fireEvent.dragStart(one, { dataTransfer: dt });
  dragOverAt(three, dt, 30); // lower half: before the next task (4), not 3
  expect(three).not.toHaveAttribute('data-drop');
  expect(four).toHaveAttribute('data-drop', 'before');
  dropAt(three, dt, 30);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: JSON.stringify({ before: 'I4' }) }));
  fireEvent.dragEnd(one, { dataTransfer: dt });

  fireEvent.dragStart(one, { dataTransfer: dt });
  dragOverAt(four, dt, 30); // 4 is last: the lower half means the end, so no task is "before"
  expect(four).not.toHaveAttribute('data-drop');
  expect(screen.getByRole('list', { name: 'dev' })).toHaveAttribute('data-drop', 'end');
  dropAt(four, dt, 30);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: undefined }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
  rect.mockRestore();
});

test('the stage tail posts the end; the same drop is refused when the dragged task is already last, matching the no-line no-op rule', () => {
  render(<Flow state={state([task('1', 'dev'), task('2', 'dev')], [worker('s1')])} />);
  const [one, two] = ['#1 Task 1', '#2 Task 2'].map((text) => screen.getByText(text).closest('li')!);
  const list = screen.getByRole('list', { name: 'dev' });
  const dt = dataTransfer();

  fireEvent.dragStart(one, { dataTransfer: dt });
  fireEvent.dragOver(list, { dataTransfer: dt });
  expect(list).toHaveAttribute('data-drop', 'end');
  fireEvent.drop(list, { dataTransfer: dt });
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: undefined }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
  fetchMock.mockClear();

  fireEvent.dragStart(two, { dataTransfer: dt });
  fireEvent.dragOver(list, { dataTransfer: dt });
  expect(list).not.toHaveAttribute('data-drop'); // task 2 is already last: the tail would not move it
  fireEvent.drop(list, { dataTransfer: dt });
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.dragEnd(two, { dataTransfer: dt });
});

test('a target that would leave the task where it is shows no line and posts nothing: before itself, or before the task that already follows it', () => {
  const rect = stubTaskRect();
  render(<Flow state={state([task('1', 'dev'), task('2', 'dev'), task('3', 'dev')], [worker('s1')])} />);
  const [one, two] = ['#1 Task 1', '#2 Task 2'].map((text) => screen.getByText(text).closest('li')!);
  const dt = dataTransfer();

  fireEvent.dragStart(one, { dataTransfer: dt });
  dragOverAt(one, dt, 10); // before itself
  expect(one).not.toHaveAttribute('data-drop');
  dropAt(one, dt, 10);
  expect(fetchMock).not.toHaveBeenCalled();

  dragOverAt(one, dt, 30); // after itself: before task 2, which already follows it
  expect(two).not.toHaveAttribute('data-drop');
  dropAt(one, dt, 30);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.dragEnd(one, { dataTransfer: dt });
  rect.mockRestore();
});

test('dragend and leaving the list clear the line, though the dragged task stays dimmed until dragend; another stage still refuses the drop', () => {
  const rect = stubTaskRect();
  render(<Flow state={state([task('1', 'dev', { leaving: true }), task('2', 'dev'), task('3', 'review')], [worker('s1')])} />);
  const [one, , three] = ['#1 Task 1', '#2 Task 2', '#3 Task 3'].map((text) => screen.getByText(text).closest('li')!);
  expect(one).toHaveAttribute('draggable', 'true');
  expect(screen.getAllByTitle('arraste pra reordenar')).toHaveLength(1); // the leaving task: it cannot change stage
  expect(screen.getAllByTitle('arraste pra reordenar ou mover para outra etapa')).toHaveLength(2); // auto on moves too (#708)
  const devList = screen.getByRole('list', { name: 'dev' });
  const dt = dataTransfer();

  fireEvent.dragStart(one, { dataTransfer: dt });
  expect(one).toHaveClass('opacity-50');
  dragOverAt(screen.getByText('#2 Task 2').closest('li')!, dt, 30); // 2 is last: the lower half means the end
  expect(devList).toHaveAttribute('data-drop', 'end');

  expect(fireEvent.dragOver(three, { dataTransfer: dt })).toBe(true); // another stage: not a drop target, so no line either
  expect(three).not.toHaveAttribute('data-drop');

  fireEvent.dragLeave(devList, { dataTransfer: dt, relatedTarget: document.body });
  expect(devList).not.toHaveAttribute('data-drop');
  expect(one).toHaveClass('opacity-50'); // still mid-drag: only the line goes, not the dim

  fireEvent.dragEnd(one, { dataTransfer: dt });
  expect(one).not.toHaveClass('opacity-50');
  expect(fireEvent.dragOver(screen.getByText('#2 Task 2').closest('li')!, { dataTransfer: dt })).toBe(true); // nothing is being dragged any more
  rect.mockRestore();
});

test('a dragged task no longer in this stage mid-drag (e.g. a live update) is never mistaken for already sitting at the hovered target (#122)', () => {
  const rect = stubTaskRect();
  const { rerender } = render(<Flow state={state([task('1', 'dev'), task('2', 'dev'), task('3', 'dev')], [worker('s1')])} />);
  const one = screen.getByText('#1 Task 1').closest('li')!;
  const dt = dataTransfer();
  fireEvent.dragStart(one, { dataTransfer: dt });
  rerender(<Flow state={state([task('2', 'dev'), task('3', 'dev')], [worker('s1')])} />); // task 1 left the stage mid-drag
  const two = screen.getByText('#2 Task 2').closest('li')!;
  dragOverAt(two, dt, 10); // upper half: before task 2, now the first task
  expect(two).toHaveAttribute('data-drop', 'before');
  dropAt(two, dt, 10);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: JSON.stringify({ before: 'I2' }) }));
  rect.mockRestore();
});

test('a task that may change stage shows the drop line in another stage and posts move-to with that stage and where it landed, before a task or at the end with no before; in its own stage it still posts move (#366)', () => {
  const rect = stubTaskRect();
  render(<Flow state={state([task('1', 'dev', { auto: false }), task('4', 'dev'), task('2', 'review'), task('3', 'review')], [worker('s1')])} />);
  const [one, four, two, three] = ['#1 Task 1', '#4 Task 4', '#2 Task 2', '#3 Task 3'].map((text) => screen.getByText(text).closest('li')!);
  const dt = dataTransfer();

  fireEvent.dragStart(one, { dataTransfer: dt });
  dragOverAt(two, dt, 10); // upper half of 2: before it
  expect(two).toHaveAttribute('data-drop', 'before');
  dropAt(two, dt, 10);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'review', drop: { before: 'I2' } }) }));
  fireEvent.dragEnd(one, { dataTransfer: dt });

  fireEvent.dragStart(one, { dataTransfer: dt });
  dragOverAt(three, dt, 30); // lower half of the last task: the end, which a task from another stage always moves to
  expect(screen.getByRole('list', { name: 'review' })).toHaveAttribute('data-drop', 'end');
  dropAt(three, dt, 30);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'review', drop: {} }) }));
  fireEvent.dragEnd(one, { dataTransfer: dt });

  fireEvent.dragStart(one, { dataTransfer: dt });
  dragOverAt(four, dt, 30); // its own stage: after 4, the last, is the end
  dropAt(four, dt, 30);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: undefined }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
  rect.mockRestore();
});

test('an empty stage keeps its list, which takes a task that may change stage at its end (#366)', () => {
  render(<Flow state={state([task('1', 'dev', { created: true })], [worker('s1')])} />);
  const one = screen.getByText('1 Task 1').closest('li')!; // a local task's label has no # (#132)
  const review = screen.getByRole('list', { name: 'review' });
  expect(within(review).getByText('vazia')).toBeInTheDocument();
  const dt = dataTransfer();
  fireEvent.dragStart(one, { dataTransfer: dt });
  fireEvent.dragOver(review, { dataTransfer: dt });
  expect(review).toHaveAttribute('data-drop', 'end');
  fireEvent.drop(review, { dataTransfer: dt });
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'review', drop: {} }) }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
});

test('a source task with auto on shows the drop line in another stage and posts move-to (#708)', () => {
  render(<Flow state={state([task('1', 'dev'), task('2', 'review')], [worker('s1')])} />);
  const one = screen.getByText('#1 Task 1').closest('li')!;
  expect(one).toHaveAttribute('title', 'arraste pra reordenar ou mover para outra etapa');
  const review = screen.getByRole('list', { name: 'review' });
  const dt = dataTransfer();
  fireEvent.dragStart(one, { dataTransfer: dt });
  fireEvent.dragOver(review, { dataTransfer: dt });
  expect(review).toHaveAttribute('data-drop', 'end');
  fireEvent.drop(review, { dataTransfer: dt });
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'review', drop: {} }) }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
});

test('a task its stage run holds gets no drop line in another stage but still reorders in its own; each tooltip says what a drag may do, or to stop the stage first (#366)', () => {
  const rect = stubTaskRect();
  render(<Flow state={state([task('1', 'dev', { auto: false, workerId: 's1' }), task('2', 'dev', { leaving: true }), task('3', 'review', { auto: false })], [worker('s1', 'I1')])} />);
  const [one, two, three] = ['#1 Task 1', '#2 Task 2', '#3 Task 3'].map((text) => screen.getByText(text).closest('li')!);
  expect([one, two, three].map((li) => li.getAttribute('title'))).toEqual(['pare a etapa pra mover para outra etapa', 'arraste pra reordenar', 'arraste pra reordenar ou mover para outra etapa']);
  const review = screen.getByRole('list', { name: 'review' });
  const dt = dataTransfer();

  fireEvent.dragStart(one, { dataTransfer: dt });
  expect(fireEvent.dragOver(three, { dataTransfer: dt })).toBe(true); // not prevented: the browser shows the no-drop cursor
  expect(fireEvent.dragOver(review, { dataTransfer: dt })).toBe(true);
  expect(review).not.toHaveAttribute('data-drop');
  dragOverAt(two, dt, 30); // its own stage: after 2, the last, is the end
  expect(screen.getByRole('list', { name: 'dev' })).toHaveAttribute('data-drop', 'end');
  dropAt(two, dt, 30);
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: undefined }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
  rect.mockRestore();
});

test('the flow is a canvas (#134, #908): one node per stage with its executor line, the arrows\' pills and no end circle; lista › opens the node\'s list panel and selects the node', async () => {
  const user = userEvent.setup();
  const transitions = [{ from: 'dev', to: 'review', when: 'done' as const }, { from: 'review', to: 'end', when: 'done' as const }];
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(400);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200);
  render(<Flow state={{ ...state([task('1', 'dev')], [worker('s1')]), transitions }} />);
  const canvas = screen.getByRole('region', { name: 'fluxograma' });
  expect(canvas).toHaveClass('relative', 'min-h-0', 'flex-1', 'overflow-hidden', 'bg-background'); // fills the area below the header (#908)
  expect(canvas.className.split(' ').filter((c) => c === 'border' || c.startsWith('rounded-') || /^m[xytblr]?-/.test(c))).toEqual([]);
  expect(within(canvas).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['dev', 'review']);
  expect(within(canvas).queryByText('terminou')).not.toBeInTheDocument(); // the default path goes unlabelled, the arrow to end is Settings' (#908)
  expect(within(canvas).queryByText('fim')).not.toBeInTheDocument();
  await user.click(within(canvas).getAllByRole('button', { name: 'lista ›' })[0]);
  expect(screen.getByRole('region', { name: 'dev' })).toBeInTheDocument();
  expect(canvas.querySelector('[data-stage="dev"]')).toHaveClass('border-foreground');
  vi.restoreAllMocks();
});

test('every node may grow to the canvas\'s bottom and the chart is exactly as tall as the canvas, with no node measured (#908)', () => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(800);
  render(<Flow state={{ ...state([task('1', 'dev')], [worker('s1')]), transitions: [{ from: 'dev', to: 'review', when: 'done' }] }} />);
  const canvas = screen.getByRole('region', { name: 'fluxograma' });
  expect(canvas.querySelector<HTMLElement>('[data-stage="dev"]')!.style.maxHeight).toBe(`${800 - 2 * MARGIN}px`);
  expect(canvas.querySelector<HTMLElement>('[data-flow-stages] > div')!.style.height).toBe('800px');
  vi.restoreAllMocks();
});

test('the flow view draws no pill on the default path, a passed verdict included; a labelled arrow, a back edge with its tries and a loop keep theirs (#908)', () => {
  const cols: Stage[] = [...stages, { name: 'pr', from: { board: ['PR'] } }];
  const transitions: Transition[] = [
    { from: 'dev', to: 'review', when: 'done' },
    { from: 'review', to: 'pr', when: 'approved' },
    { from: 'dev', to: 'review', when: 'approved', label: 'design' },
    { from: 'dev', to: 'review', when: 'verdict', verdict: 'passed' },
    { from: 'review', to: 'dev', when: 'verdict', verdict: 'failed', maxTries: 3 },
    { from: 'pr', to: 'pr', when: 'feedback' },
  ];
  render(<Flow state={{ ...state([], [worker('s1')], cols), transitions }} />);
  const canvas = screen.getByRole('region', { name: 'fluxograma' });
  expect(within(canvas).queryByText('terminou')).not.toBeInTheDocument();
  expect(within(canvas).queryByText('aprovado')).not.toBeInTheDocument();
  expect(within(canvas).queryByText('passou')).not.toBeInTheDocument();
  for (const pill of ['design', 'falhou · 3x', 'feedback']) expect(within(canvas).getByText(pill)).toBeInTheDocument();
});

// A forward arrow, a back edge with its tries, a loop and an unlabelled skip forward (#909)
const LOOP_STAGES: Stage[] = [...stages, { name: 'pr', from: { board: ['PR'] } }];
const LOOPED: Transition[] = [
  { from: 'dev', to: 'review', when: 'done' },
  { from: 'review', to: 'dev', when: 'verdict', verdict: 'failed', maxTries: 3 },
  { from: 'pr', to: 'pr', when: 'feedback' },
  { from: 'dev', to: 'pr', when: 'approved' },
];
const kinds = (canvas: HTMLElement): (string | null)[] => [...canvas.querySelectorAll('path[data-kind]')].map((p) => p.getAttribute('data-kind'));

test('↺ voltas hides every back edge, loop and unlabelled skip with their pills, the row falling to the margin, keeps it in flowView, and brings them back (#909)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState()); // drops the pending post
  const user = userEvent.setup();
  render(<Flow state={{ ...state([], [worker('s1')], LOOP_STAGES), transitions: LOOPED }} />);
  const canvas = screen.getByRole('region', { name: 'fluxograma' });
  const row = (): string => canvas.querySelector<HTMLElement>('[data-stage="dev"]')!.parentElement!.style.top;
  const loops = screen.getByRole('button', { name: '↺ voltas' });
  expect(loops).toHaveAttribute('aria-pressed', 'true');
  expect(kinds(canvas)).toEqual(['forward', 'above', 'loop', 'above']);
  for (const pill of ['falhou · 3x', 'feedback']) expect(within(canvas).getByText(pill)).toBeInTheDocument();
  expect(row()).not.toBe(`${MARGIN}px`);
  await user.click(loops);
  expect(kinds(canvas)).toEqual(['forward']);
  for (const pill of ['falhou · 3x', 'feedback']) expect(within(canvas).queryByText(pill)).not.toBeInTheDocument();
  expect(row()).toBe(`${MARGIN}px`);
  expect(readView('flowView')).toEqual({ loops: false, zoom: 1, pan: { x: 0, y: 0 }, collapsed: [], outline: [] });
  await user.click(loops);
  expect(kinds(canvas)).toEqual(['forward', 'above', 'loop', 'above']);
  expect(readView('flowView')).toEqual({ loops: true, zoom: 1, pan: { x: 0, y: 0 }, collapsed: [], outline: [] });
});

test('a stored flowView with loops off draws the flow without them on the first render, the button not pressed: the reload case (#909)', () => {
  resetViewState({ flowView: { loops: false, zoom: 1, pan: { x: 0, y: 0 } } });
  onTestFinished(() => resetViewState());
  render(<Flow state={{ ...state([], [worker('s1')], LOOP_STAGES), transitions: LOOPED }} />);
  const canvas = screen.getByRole('region', { name: 'fluxograma' });
  expect(screen.getByRole('button', { name: '↺ voltas' })).toHaveAttribute('aria-pressed', 'false');
  expect(kinds(canvas)).toEqual(['forward']);
  expect(within(canvas).queryByText('falhou · 3x')).not.toBeInTheDocument();
});

// #910: the canvas's scrolling pane, the sizer of the scaled size inside it, and the element that scales
const paneOf = (canvas: HTMLElement): HTMLElement => canvas.querySelector<HTMLElement>('[data-flow-stages]')!;
const sizerOf = (canvas: HTMLElement): HTMLElement => canvas.querySelector<HTMLElement>('[data-flow-stages] > div')!;
const scaledOf = (canvas: HTMLElement): HTMLElement => canvas.querySelector<HTMLElement>('[data-flow-stages] > div > div')!;
// The pane's size as the canvas measures it: jsdom lays nothing out, and the ResizeObserver stub never calls back, so a mount reads it
const viewport = (width: number, height: number): void => {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height);
};
// Two stages and the arrow between them: MARGIN + 2 × NODE_WIDTH (220) + GAP + MARGIN = 560 wide, MARGIN + NODE_MIN + MARGIN = 208 tall at NODE_MIN
const twoStages = (): State => ({ ...state([task('1', 'dev')], [worker('s1')]), transitions: [{ from: 'dev', to: 'review', when: 'done' }] });

test('− and + move the zoom by 10% and the number goes back to 100%; the chart scales inside a centred sizer, the list panel does not, and flowView keeps the zoom (#910)', async () => {
  onTestFinished(() => { vi.restoreAllMocks(); });
  const user = userEvent.setup();
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(400); // an overflowing node shows its lista › footer
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200);
  render(<Flow state={twoStages()} />);
  const canvas = screen.getByRole('region', { name: 'fluxograma' });
  expect(paneOf(canvas)).toHaveClass('flex', 'overflow-auto');
  expect(sizerOf(canvas)).toHaveClass('m-auto', 'shrink-0'); // a chart smaller than the canvas sits centred at every zoom
  expect(scaledOf(canvas)).toHaveClass('origin-top-left');
  expect(scaledOf(canvas).style.transform).toBe('scale(1)');
  const zoomIn = screen.getByRole('button', { name: 'aproximar' });
  expect(zoomIn).toHaveAttribute('title', 'aproximar · Ctrl+=');
  expect(screen.getByRole('button', { name: 'ajustar' })).toHaveAttribute('title', 'ajustar · Shift+1'); // jsdom runs as off macOS
  await user.click(zoomIn);
  expect(screen.getByRole('button', { name: '110%' })).toHaveAttribute('title', 'voltar a 100% · Ctrl+0');
  expect(scaledOf(canvas).style.transform).toBe('scale(1.1)');
  expect(readView('flowView')).toEqual({ loops: true, zoom: 1.1, pan: { x: 0, y: 0 }, collapsed: [], outline: [] });
  await user.click(within(canvas).getAllByRole('button', { name: 'lista ›' })[0]);
  const panel = screen.getByRole('region', { name: 'dev' });
  expect(scaledOf(canvas).contains(panel)).toBe(false);
  expect(panel.style.transform).toBe('');
  await user.click(screen.getByRole('button', { name: 'afastar' }));
  await user.click(screen.getByRole('button', { name: 'afastar' }));
  expect(scaledOf(canvas).style.transform).toBe('scale(0.9)');
  await user.click(screen.getByRole('button', { name: '90%' }));
  expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument();
  expect(readView('flowView')).toEqual({ loops: true, zoom: 1, pan: { x: 0, y: 0 }, collapsed: [], outline: [] });
});

test('ajustar on a chart wider than the canvas zooms out until it fits and scrolls to the start, the nodes still reaching the bottom; on a small chart it is 100% (#910)', async () => {
  onTestFinished(() => { vi.restoreAllMocks(); });
  const user = userEvent.setup();
  viewport(448, 600);
  const { unmount } = render(<Flow state={twoStages()} />);
  let canvas = screen.getByRole('region', { name: 'fluxograma' });
  paneOf(canvas).scrollLeft = 30;
  await user.click(screen.getByRole('button', { name: 'ajustar' }));
  expect(screen.getByRole('button', { name: '80%' })).toBeInTheDocument(); // 448 / 560
  expect(scaledOf(canvas).style.transform).toBe('scale(0.8)');
  expect(sizerOf(canvas).style.width).toBe('448px');
  expect([paneOf(canvas).scrollLeft, paneOf(canvas).scrollTop]).toEqual([0, 0]);
  expect(canvas.querySelector<HTMLElement>('[data-stage="dev"]')!.style.maxHeight).toBe(`${600 / 0.8 - 2 * MARGIN}px`);
  expect(readView('flowView')).toEqual({ loops: true, zoom: 0.8, pan: { x: 0, y: 0 }, collapsed: [], outline: [] });
  unmount();
  viewport(1000, 600);
  render(<Flow state={twoStages()} />);
  canvas = screen.getByRole('region', { name: 'fluxograma' });
  expect(screen.getByRole('button', { name: '80%' })).toBeInTheDocument(); // flowView's zoom, back
  await user.click(screen.getByRole('button', { name: 'ajustar' }));
  expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument(); // never above 100%
  expect(sizerOf(canvas).style.width).toBe('560px');
});

test('a stored flowView with zoom 0.8 and a pan draws the chart at 80% scrolled to that pan, and a scroll keeps the new pan: the come-back case (#910)', () => {
  onTestFinished(() => { vi.restoreAllMocks(); });
  viewport(400, 600);
  resetViewState({ flowView: { loops: true, zoom: 0.8, pan: { x: 120, y: 15 } } });
  render(<Flow state={twoStages()} />);
  const canvas = screen.getByRole('region', { name: 'fluxograma' });
  expect(screen.getByRole('button', { name: '80%' })).toBeInTheDocument();
  expect(scaledOf(canvas).style.transform).toBe('scale(0.8)');
  expect([paneOf(canvas).scrollLeft, paneOf(canvas).scrollTop]).toEqual([120, 15]);
  paneOf(canvas).scrollLeft = 50;
  fireEvent.scroll(paneOf(canvas));
  expect(readView('flowView')).toEqual({ loops: true, zoom: 0.8, pan: { x: 50, y: 15 }, collapsed: [], outline: [] });
});

test('a zoom keeps the centre of the last scroll, not of the offsets the browser already clamped to the smaller chart (#910)', async () => {
  onTestFinished(() => { vi.restoreAllMocks(); });
  const user = userEvent.setup();
  viewport(400, 600);
  render(<Flow state={twoStages()} />);
  const pane = paneOf(screen.getByRole('region', { name: 'fluxograma' }));
  pane.scrollLeft = 100;
  fireEvent.scroll(pane);
  pane.scrollLeft = 0; // the clamp a zoom out's smaller sizer makes before the anchor runs
  await user.click(screen.getByRole('button', { name: 'afastar' }));
  expect(pane.scrollLeft).toBeCloseTo((100 + 200) * 0.9 - 200); // anchoredScroll(100, 200, 1, 0.9)
});

// A wheel on the pane as its native listener gets it; false when the listener prevented it
const wheel = (pane: HTMLElement, init: WheelEventInit): boolean => {
  let isKept = true;
  act(() => { isKept = pane.dispatchEvent(new WheelEvent('wheel', { cancelable: true, ...init })); });
  return isKept;
};
const percent = (): string | null => screen.getByRole('button', { name: /^\d+%$/ }).textContent;

test('⌘ + wheel, Ctrl + wheel and a pinch zoom the flow one 10% step and keep the page from zooming; a plain wheel and one with no deltaY only scroll (#81)', () => {
  onTestFinished(() => { vi.restoreAllMocks(); });
  viewport(400, 600);
  render(<Flow state={twoStages()} />);
  const pane = paneOf(screen.getByRole('region', { name: 'fluxograma' }));
  expect(wheel(pane, { deltaY: -100 })).toBe(true);
  expect(percent()).toBe('100%');
  expect(wheel(pane, { deltaY: -100, metaKey: true })).toBe(false);
  expect(percent()).toBe('110%');
  expect(wheel(pane, { deltaY: 2, ctrlKey: true })).toBe(false); // a pinch out: Chromium sends it as a wheel with ctrlKey
  expect(percent()).toBe('100%');
  expect(wheel(pane, { deltaY: 0, ctrlKey: true })).toBe(true);
  expect(percent()).toBe('100%');
});

test('a wheel zoom keeps the point under the pointer in place; one at the bound is still prevented, and the next button zoom anchors at the centre again (#81)', async () => {
  onTestFinished(() => { vi.restoreAllMocks(); });
  const user = userEvent.setup();
  viewport(400, 600);
  resetViewState({ flowView: { loops: true, zoom: 1.4, pan: { x: 100, y: 0 } } });
  render(<Flow state={twoStages()} />);
  const pane = paneOf(screen.getByRole('region', { name: 'fluxograma' }));
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ left: 50, top: 20 } as DOMRect);
  expect(wheel(pane, { deltaY: -100, metaKey: true, clientX: 150, clientY: 50 })).toBe(false); // the pointer 100, 30 into the pane
  expect(percent()).toBe('150%');
  const afterWheel = ((100 + 100) * 1.5) / 1.4 - 100;
  expect(pane.scrollLeft).toBeCloseTo(afterWheel);
  expect(pane.scrollTop).toBeCloseTo((30 * 1.5) / 1.4 - 30);
  expect(wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 450, clientY: 50 })).toBe(false); // at 150%: no zoom, but the page stays put
  expect(percent()).toBe('150%');
  expect(pane.scrollLeft).toBeCloseTo(afterWheel);
  await user.click(screen.getByRole('button', { name: 'afastar' }));
  expect(pane.scrollLeft).toBeCloseTo(((afterWheel + 200) * 1.4) / 1.5 - 200); // the centre, not the 400 px of the wheel at the bound
});

test('coming back to the flow after Atividades hid it (display: none) puts the last scroll back (#596, #910)', () => {
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const resizes: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class { constructor(read: () => void) { resizes.push(read); } observe(): void {} disconnect(): void {} });
  viewport(400, 600);
  render(<Flow state={twoStages()} />);
  const pane = paneOf(screen.getByRole('region', { name: 'fluxograma' }));
  pane.scrollLeft = 40;
  pane.scrollTop = 25;
  fireEvent.scroll(pane);
  viewport(0, 0); // hidden: the pane has no size and the browser drops its offsets
  act(() => { for (const read of resizes) read(); });
  pane.scrollLeft = 0;
  pane.scrollTop = 0;
  viewport(400, 600);
  act(() => { for (const read of resizes) read(); });
  expect([pane.scrollLeft, pane.scrollTop]).toEqual([40, 25]);
});

// Radix opens a DropdownMenu on pointerdown, which jsdom does not deliver as a PointerEvent; the keyboard path opens the same menu.
const openStageMenu = async (user: ReturnType<typeof userEvent.setup>, index: number) => {
  screen.getAllByRole('button', { name: 'ações da etapa' })[index].focus();
  await user.keyboard('{Enter}');
};

test('every stage has a stage-actions menu whose reset item is enabled only while the order differs from the board and posts reset-order', async () => {
  const user = userEvent.setup();
  const tasks = [task('1', 'dev'), task('2', 'dev'), task('3', 'review')];
  const { rerender } = render(<Flow state={state(tasks, [worker('s1')], stages, ['I2', 'I1', 'I3'])} />);
  expect(screen.getAllByRole('button', { name: 'ações da etapa' })).toHaveLength(2); // one per stage, whether or not it differs
  await openStageMenu(user, 1); // review sits as the board lists it
  expect(screen.getByRole('menuitem', { name: 'restaurar ordem da source' })).toHaveAttribute('data-disabled');
  await user.keyboard('{Escape}');
  await openStageMenu(user, 0);
  await user.click(screen.getByRole('menuitem', { name: 'restaurar ordem da source' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/stages/dev/reset-order', expect.objectContaining({ method: 'POST', body: undefined }));
  rerender(<Flow state={state(tasks, [worker('s1')])} />); // before the first poll: no board order to differ from
  await openStageMenu(user, 0);
  expect(screen.getByRole('menuitem', { name: 'restaurar ordem da source' })).toHaveAttribute('data-disabled');
  await user.keyboard('{Escape}'); // close it: an open menu left mounted at cleanup can swallow the next test's first click
});

test('the board no longer renders the signal strip itself (#357: it moved to the header)', () => {
  render(<Flow state={state([task('1', 'dev')], [worker('s1')])} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('a click on a task\'s free area opens it; its buttons, its PR link, a dialog it opened and a drag never do', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const ran = { sessionId: 'a1b2c3d4-0000-4000-8000-000000000001', worktree: '/wt/hive-1-task-1' };
  // #629: the session and the PR are the task's record's
  const records = [{ ...rec([{ id: ran.sessionId, startedAt: '', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '' }])[0], prs: [{ url: 'https://github.com/o/r/pull/9', state: 'open' as const }] }];
  render(<Flow state={{ ...state([task('1', 'dev', ran), task('2', 'dev', { missing: true })], [worker('s1')]), activityRecords: records }} onOpen={onOpen} />);
  await user.click(screen.getByRole('button', { name: 'continuar' })); // the task ran: its session is the stage's (#283)
    await user.click(screen.getByRole('button', { name: 'fechar' }));
  await user.click(screen.getByRole('alertdialog')); // portaled out of the li, yet its clicks still bubble through React to it
  await user.keyboard('{Escape}');
  const one = screen.getByText('#1 Task 1').closest('li')!;
  const dt = dataTransfer();
  fireEvent.dragStart(one, { dataTransfer: dt });
  fireEvent.drop(screen.getByText('#2 Task 2').closest('li')!, { dataTransfer: dt });
  fireEvent.dragEnd(one, { dataTransfer: dt });
  expect(onOpen).not.toHaveBeenCalled();
  await user.click(screen.getByText('#1 Task 1'));
  expect(onOpen).toHaveBeenLastCalledWith('I1');
  await user.click(screen.getByText('sumiu da source'));
  expect(onOpen).toHaveBeenLastCalledWith('I2');
  expect(onOpen).toHaveBeenCalledTimes(2);
});

test('a task with no worktree yet: the Start dialog asks the base, with the default preselected; cancelar closes it without a post (#131)', async () => {
  bases = NO_WORKTREE;
  const user = userEvent.setup();
  render(<Flow state={state([task('3', 'dev')], [worker('s1')])} />);
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  const dialog = screen.getByRole('dialog', { name: 'Iniciar #3' });
  expect(await within(dialog).findByRole('combobox', { name: 'origin/main' })).toBeInTheDocument();
  await user.click(within(dialog).getByRole('combobox', { name: 'origin/main' }));
  expect(screen.getByRole('option', { name: 'feature-x' })).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'cancelar' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1); // the GET only: nothing started
});

test('a local task reads HIVE-1 without #, and its face has no remover, stopped or running: removal lives in its menu and its panel (#132, #355)', () => {
  const local = task('1', 'dev', { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Local', body: '', url: '' }, boardColumn: '', created: true });
  const { rerender } = render(<Flow state={state([local], [worker('s1')])} />);
  expect(screen.getByText('HIVE-1 Local')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'remover' })).not.toBeInTheDocument();
  rerender(<Flow state={state([{ ...local, workerId: 's1' }], [worker('s1', 'local:1')])} />);
  expect(screen.queryByRole('button', { name: 'remover' })).not.toBeInTheDocument();
});

// The right-click menu itself (mark / unmark manual, mover para and its submenu) is tested in Flow.contextmenu.test.tsx, kept
// apart because Radix's ContextMenu never shows content again once closed under jsdom, and this file's many Dialog / DropdownMenu /
// Popover tests already exhaust that budget (#164).
const sessionWorker = (id: string, runId: string): Worker => ({ id, status: 'working', activityId: activityIdOf('I1'), runId: runId, freeSession: true, sessionId: `${runId.slice(0, 8)}-0000-4000-8000-00000000000c` });

test('a task shows the auto badge unless it is manual; a manual task offers what any task offers (iniciar, its blockers) (#164, #542)', () => {
  const blocked = task('1', 'dev', { auto: false, item: { ...task('1', 'dev').item, blockedBy: ['9'] } });
  const { rerender } = render(<Flow state={state([blocked], [worker('s1')])} />);
  const item = () => screen.getByText('#1 Task 1').closest('li')!;
  expect(within(item()).queryByText('auto')).not.toBeInTheDocument();
  expect(screen.getByText('⊘ bloqueada por 9')).toBeInTheDocument();
  rerender(<Flow state={state([task('1', 'dev', { auto: false })], [worker('s1')])} />);
  expect(screen.getByRole('button', { name: 'iniciar' })).toBeInTheDocument();
  rerender(<Flow state={state([task('1', 'dev')], [worker('s1')])} />);
  expect(within(item()).getByText('auto')).toBeInTheDocument();
});

test('a task with several sessions borders itself in the worst of them: a waiting session outranks a working one (#229)', () => {
  const waiting = { ...sessionWorker('m1', 'aaaaaaaa-0000-4000-8000-000000000001'), status: 'waiting' as const };
  render(<Flow state={state([task('1', 'dev', { workerId: 's1' })], [worker('s1', 'I1'), waiting])} />);
  const item = screen.getByText('#1 Task 1').closest('li')!;
  expect(item).toHaveClass('border-waiting');
  expect(within(item).getByText(/esperando você/)).toBeInTheDocument();
});

test('a stopped task whose stage ran offers continuar, which posts continue; reiniciar is the menu\'s now; a task that never ran offers iniciar (#283, #542)', async () => {
  const user = userEvent.setup();
  const sessions = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-25T10:00:00.000Z', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '2026-09-25T10:00:00.000Z' }];
  const ran = task('1', 'dev', { stopped: true, stageStart: { stage: 'dev', commit: 'a1b2c3d' } });
  const { rerender } = render(<Flow state={{ ...state([ran], [worker('s1')]), activityRecords: rec(sessions) }} />);
  expect(screen.queryByRole('button', { name: 'iniciar' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'reiniciar etapa…' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'continuar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/continue', expect.objectContaining({ method: 'POST' }));
  rerender(<Flow state={state([task('2', 'dev')], [worker('s1')])} />);
  expect(screen.getByRole('button', { name: 'iniciar' })).toBeInTheDocument();
});

test('a task whose stage session is held by a live free session offers no continuar; abrir reaches that run (#402)', async () => {
  const user = userEvent.setup();
  const focusDetached = vi.fn(async () => true);
  vi.stubGlobal('hive', { focusDetached });
  const held = sessionWorker('s2', 'cccccccc-0000-4000-8000-000000000003');
  const sessions = [{ id: held.sessionId!, startedAt: '2026-09-25T10:00:00.000Z', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '2026-09-25T10:00:00.000Z' }];
  render(<Flow state={{ ...state([task('1', 'dev', { stopped: true, worktree: '/wt/hive-1-task-1' })], [worker('s1'), held]), activityRecords: rec(sessions) }} />);
  expect(screen.queryByRole('button', { name: 'continuar' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'abrir' }));
  expect(focusDetached).toHaveBeenCalledWith('cccccccc-0000-4000-8000-000000000003');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('the workspace line names the workspace each task resolves to, and sem workspace when no rule resolves one (#179, #542)', () => {
  const hinted = task('2', 'dev', { item: { ...task('2', 'dev').item, workspaceHint: 'site' } });
  render(<Flow state={{ ...state([task('1', 'dev'), hinted], [worker('s1')]), workspaces: ['hive', 'site'] }} />);
  expect(within(screen.getByText('#2 Task 2')).getByTitle('site')).toBeInTheDocument();
  expect(within(screen.getByText('#1 Task 1')).queryByTitle(/./)).not.toBeInTheDocument();
});

test('a stage with stopped missing tasks shows the strip with their count; close all confirms, naming the running ones, and posts close-missing for that stage (#279)', async () => {
  const user = userEvent.setup();
  const tasks = [
    task('1', 'dev', { missing: true }), task('2', 'dev', { missing: true }), task('3', 'dev', { missing: true, workerId: 's1' }),
    task('4', 'review', { missing: true, workerId: 's2' }), // review's only missing task runs: no strip there
  ];
  render(<Flow state={state(tasks, [worker('s1', 'I3'), worker('s2', 'I4')])} />);
  expect(screen.getByText(t('stage.missing', { n: 2 }))).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: t('stage.closeMissing') })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: t('stage.closeMissing') }));
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByText(`${t('confirm.closeMissingAll', { n: 2 })} ${t('confirm.closeMissingRunning', { m: 1 })}`)).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: t('stage.closeMissing') }));
  expect(fetchMock).toHaveBeenLastCalledWith('/stages/dev/close-missing', expect.objectContaining({ method: 'POST', body: undefined }));
});

test('no strip while nothing in the stage is closable (a running or deleting missing task, an orphan, a task on the board); with no running missing task the confirm names only what closes (#279)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Flow state={state([
    task('1', 'dev', { missing: true, workerId: 's1' }), task('2', 'dev', { missing: true, workerId: 's2' }), task('3', 'dev', { missing: true, deleting: true }),
    task('4', 'dev', { orphan: true }), task('5', 'dev'),
  ], [worker('s1', 'I1'), worker('s2', 'I2')])} />);
  expect(screen.queryByRole('button', { name: t('stage.closeMissing') })).not.toBeInTheDocument();
  rerender(<Flow state={state([task('6', 'review', { missing: true })], [worker('s1')])} />);
  expect(screen.getByText(t('stage.missing', { n: 1 }))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: t('stage.closeMissing') }));
  expect(within(screen.getByRole('alertdialog')).getByText(t('confirm.closeMissingAll', { n: 1 }))).toBeInTheDocument();
});

test('a task awaiting approval shows the approval colour and aguardando aprovação with no Start, Continue or Restart, and aprovar while a held run keeps its worker (#268, #542)', () => {
  const since = '2026-09-25T10:00:00.000Z';
  const ran = rec([{ id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: since, stages: ['dev'], agent: 'claude' as const, lastUsedAt: since }]);
  const { rerender } = render(<Flow state={{ ...state([task('1', 'dev', { approval: { since } })], [worker('s1')]), activityRecords: ran }} />);
  const tile = () => screen.getByText('#1 Task 1').closest('li')!;
  expect(tile()).toHaveClass('border-approval');
  expect(within(tile()).getByText(/aguardando aprovação/)).toBeInTheDocument();
  for (const name of [t('task.start'), t('task.continue'), t('task.restartStage')]) expect(within(tile()).queryByRole('button', { name })).not.toBeInTheDocument();
  const holding: Worker = { id: 's1', status: 'approval', activityId: activityIdOf('I1'), runId: 'W1' };
  rerender(<Flow state={{ ...state([task('1', 'dev', { approval: { since, until: '2026-09-25T10:10:00.000Z' }, workerId: 's1' })], [holding]), activityRecords: ran }} />);
  expect(tile()).toHaveClass('border-approval');
  expect(within(tile()).getByText(/aguardando aprovação/)).toBeInTheDocument();
  expect(within(tile()).getByRole('button', { name: 'aprovar' })).toBeInTheDocument();
  rerender(<Flow state={{ ...state([task('1', 'dev')], [worker('s1')]), activityRecords: ran }} />);
  expect(tile()).not.toHaveClass('border-approval');
});

test('a task running its worktree setup says so from task.setup: iniciando with no worker, then its step; with its stage worker, the status; nothing without it (#299, #351, #542)', () => {
  const opening = task('1', 'dev', { setup: { consoleId: 'setup:I1' } });
  const { rerender } = render(<Flow state={state([opening], [worker('s1')])} />);
  expect(screen.getByText('iniciando')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: t('task.start') })).not.toBeInTheDocument();
  rerender(<Flow state={state([{ ...opening, setup: { consoleId: 'setup:I1', step: 'RUN pnpm install' } }], [worker('s1')])} />);
  expect(screen.getByText('preparando: RUN pnpm install')).toBeInTheDocument();
  rerender(<Flow state={state([task('1', 'dev', { workerId: 's1', setup: { consoleId: 'setup:I1', step: 'COPY .env' } })], [worker('s1', 'I1')])} />);
  expect(screen.getByText('trabalhando')).toBeInTheDocument();
  rerender(<Flow state={state([task('1', 'dev', { workerId: 's1' })], [{ ...worker('s1', 'I1'), lastEvent: { kind: 'prompt' } }])} />);
  expect(screen.queryByText(/preparando|iniciando/)).not.toBeInTheDocument();
});

test('a picked source shows only its tasks and counts them in the stage header; none picked shows every source (redesign 09)', () => {
  const onSource = (id: string, board?: string): Task => { const c = task(id, 'dev'); return { ...c, item: { ...c.item, source: board } }; };
  const tasks = [onSource('1', 'roadmap'), onSource('2', 'notes'), onSource('3')];
  const { rerender } = render(<Flow state={state(tasks, [])} source="roadmap" />);
  expect(titles()).toEqual(['#1 Task 1']);
  expect(within(header('dev')).getByText('1')).toBeInTheDocument();
  rerender(<Flow state={state(tasks, [])} />);
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3']);
});

test('with hive picked, only the tasks with no source show, in every stage and its count; the header reads hive and shows no last poll (#665)', () => {
  const onSource = (id: string, stage: string, board?: string): Task => { const c = task(id, stage); return { ...c, item: { ...c.item, source: board } }; };
  const tasks = [onSource('1', 'dev', 'roadmap'), onSource('2', 'dev'), onSource('3', 'review'), onSource('4', 'review', 'notes')];
  // one workspace other than hive, so its chip never reads as the pick's label
  const picked = { ...state(tasks, []), workspaces: ['site'], syncs: { roadmap: { polledAt: '2026-10-02T09:28:00.000Z' } } };
  render(<Flow state={picked} source="hive" />);
  expect(titles()).toEqual(['#2 Task 2', '#3 Task 3']);
  expect(within(header('dev')).getByText('1')).toBeInTheDocument();
  expect(within(header('review')).getByText('1')).toBeInTheDocument();
  const flowHeader = screen.getByRole('region', { name: 'fluxo' });
  expect(within(flowHeader).getByText('hive')).toBeInTheDocument();
  expect(within(flowHeader).queryByText(/^atualizado/)).not.toBeInTheDocument();
});

test('a capped stage\'s node shows n/cap after its count; over the cap the number reads in foreground and its title says how many were started by hand (#727)', () => {
  const s = state([task('1', 'dev'), task('2', 'dev')], [worker('w1', 'I1'), worker('w2', 'I2')]);
  const { rerender } = render(<Flow state={s} stageCaps={{ dev: 1 }} />);
  const over = within(header('dev')).getByText('2/1');
  expect(over).toHaveClass('text-foreground');
  expect(over).toHaveAttribute('title', t('flow.stageCap.byHand', { k: 1 }));
  expect(within(header('review')).queryByText(/\d\/\d/)).not.toBeInTheDocument();
  rerender(<Flow state={s} stageCaps={{ dev: 2 }} />);
  expect(within(header('dev')).getByText('2/2')).not.toHaveClass('text-foreground');
  expect(within(header('dev')).getByText('2/2')).not.toHaveAttribute('title');
});

// jsdom runs as off macOS: CmdOrCtrl is Ctrl. code carries the key under Shift, as a real keydown does
const ZOOM_IN = { key: '=', code: 'Equal', ctrlKey: true };
const ZOOM_OUT = { key: '-', code: 'Minus', ctrlKey: true };
const ZOOM_RESET = { key: '0', code: 'Digit0', ctrlKey: true };
const ZOOM_FIT = { key: '!', code: 'Digit1', shiftKey: true };

test('Ctrl+=, Ctrl+-, Ctrl+0 and ⇧1 do what +, −, the number and ajustar do, only while the flow shows; ⇧1 in buscar tarefas types (#910)', () => {
  onTestFinished(() => { vi.restoreAllMocks(); });
  viewport(448, 600);
  const flow = (isShown: boolean) => <FlowShownContext.Provider value={isShown}><Flow state={twoStages()} /></FlowShownContext.Provider>;
  const { rerender } = render(flow(true));
  const scale = (): string => scaledOf(screen.getByRole('region', { name: 'fluxograma' })).style.transform;
  expect(fireEvent.keyDown(window, ZOOM_IN)).toBe(false); // prevented: the key is the flow's
  expect(scale()).toBe('scale(1.1)');
  fireEvent.keyDown(window, ZOOM_OUT);
  fireEvent.keyDown(window, ZOOM_OUT);
  expect(scale()).toBe('scale(0.9)');
  fireEvent.keyDown(window, ZOOM_RESET);
  expect(scale()).toBe('scale(1)');
  expect(fireEvent.keyDown(screen.getByRole('textbox', { name: 'buscar tarefas' }), ZOOM_FIT)).toBe(true); // not prevented: it types
  expect(scale()).toBe('scale(1)');
  expect(fireEvent.keyDown(window, ZOOM_FIT)).toBe(false); // prevented: matched by hand, since Shift+1 is no binding
  expect(scale()).toBe('scale(0.8)');
  expect(readView('flowView')).toEqual({ loops: true, zoom: 0.8, pan: { x: 0, y: 0 }, collapsed: [], outline: [] });
  fireEvent.keyDown(window, ZOOM_RESET); // back to 100%, so a fit while hidden would show
  rerender(flow(false)); // under Atividades the flow stays mounted (#596), its keys unbound
  expect(fireEvent.keyDown(window, ZOOM_IN)).toBe(true);
  expect(fireEvent.keyDown(window, ZOOM_FIT)).toBe(true);
  expect(scale()).toBe('scale(1)');
});

// #34: I1 in dev lists I2 (dev) and I3 (review); I4 in dev is in no tree
const linked = (id: string, stage: string, links: Pick<Item, 'parent' | 'children'>): WithWork => {
  const t = task(id, stage);
  return { ...t, item: { ...t.item, ...links } };
};
const forest = (): State => state([linked('1', 'dev', { children: ['I2', 'I3'] }), linked('2', 'dev', { parent: 'I1' }), linked('3', 'review', { parent: 'I1' }), task('4', 'dev')], [worker('s1')]);
const nodeOf = (stage: string): HTMLElement => screen.getByRole('region', { name: 'fluxograma' }).querySelector<HTMLElement>(`[data-stage="${stage}"]`)!;
const treeToggle = (): HTMLElement => screen.getByRole('button', { name: '⑂ árvore' });

test('⑂ árvore starts on with a tree in the list and off without one; a click keeps the choice in flowView and it survives a reload (#34)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState()); // drops the pending post
  const user = userEvent.setup();
  const { unmount } = render(<Flow state={state([task('1', 'dev')], [worker('s1')])} />);
  expect(treeToggle()).toHaveAttribute('aria-pressed', 'false');
  expect(treeToggle()).toHaveAttribute('title', 'agrupar por árvore');
  unmount();
  const { unmount: unmountTree } = render(<Flow state={forest()} />);
  expect(treeToggle()).toHaveAttribute('aria-pressed', 'true');
  expect(within(nodeOf('dev')).getByText('⑂ #1 Task 1')).toBeInTheDocument();
  expect(within(nodeOf('review')).getByText('⑂ #1 Task 1')).toBeInTheDocument(); // the root sits in dev; review's group still names it
  expect(within(nodeOf('dev')).getByText('sem árvore')).toBeInTheDocument();
  await user.click(treeToggle());
  expect(within(nodeOf('dev')).queryByText('⑂ #1 Task 1')).not.toBeInTheDocument();
  expect(readView('flowView')).toEqual({ loops: true, zoom: 1, pan: { x: 0, y: 0 }, tree: false, collapsed: [], outline: [] });
  unmountTree();
  render(<Flow state={forest()} />);
  expect(treeToggle()).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByText('sem árvore')).not.toBeInTheDocument();
});

test('the chevron collapses a tree\'s group in its own node only, and the collapse survives a reload through flowView (#34)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const user = userEvent.setup();
  const { unmount } = render(<Flow state={forest()} />);
  await user.click(within(nodeOf('dev')).getAllByRole('button', { name: /^recolher/ })[0]);
  expect(within(nodeOf('dev')).queryByText('#2 Task 2')).not.toBeInTheDocument();
  expect(within(nodeOf('dev')).getByRole('button', { name: /^expandir/ })).toHaveAttribute('aria-expanded', 'false');
  expect(within(nodeOf('review')).getByText('#3 Task 3')).toBeInTheDocument();
  expect(readView('flowView')).toEqual({ loops: true, zoom: 1, pan: { x: 0, y: 0 }, collapsed: ['dev\u0000I1'], outline: [] });
  unmount();
  render(<Flow state={forest()} />);
  expect(within(nodeOf('dev')).queryByText('#1 Task 1')).not.toBeInTheDocument();
  expect(within(nodeOf('dev')).getByText('#4 Task 4')).toBeInTheDocument();
});

// #35: the handoff's tree over both stages: #870 lists #871…#874, #872 lists #875 and #876; #9 in dev is in no tree
const handoff = (): State => state([
  linked('870', 'dev', { children: ['I871', 'I872', 'I873', 'I874'] }), linked('871', 'dev', { parent: 'I870' }),
  linked('872', 'dev', { parent: 'I870', children: ['I875', 'I876'] }), linked('873', 'review', { parent: 'I870' }), linked('874', 'review', { parent: 'I870' }),
  linked('875', 'dev', { parent: 'I872' }), linked('876', 'review', { parent: 'I872' }), task('9', 'dev'),
], [worker('s1')]);
const HANDOFF_IDS = ['870', '871', '872', '873', '874', '875', '876', '9'];
const cardOf = (id: string): HTMLElement => screen.getByText(`#${id} Task ${id}`).closest('li')!;
const faded = (): string[] => HANDOFF_IDS.filter((id) => cardOf(id).classList.contains('opacity-30'));
const trail = (): HTMLElement | null => screen.queryByRole('navigation', { name: 'árvore em foco' });
const focusOn = (id: string): HTMLElement => within(cardOf(id)).getByRole('button', { name: 'focar ›' });

test('focar › on #872 fades every card but #872, #875 and #876, keeps the node counts, and shows the trail #870 › #872 with 3 tarefas · o resto esmaecido (#35)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const user = userEvent.setup();
  render(<Flow state={handoff()} />);
  expect(faded()).toEqual([]);
  expect(trail()).not.toBeInTheDocument();
  await user.click(focusOn('872'));
  expect(faded()).toEqual(['870', '871', '873', '874', '9']);
  expect(within(header('dev')).getByText('5')).toBeInTheDocument();
  expect(within(header('review')).getByText('3')).toBeInTheDocument();
  const nav = trail()!;
  expect(within(nav).getByText('⑂ árvore')).toHaveClass('text-muted-foreground');
  expect(within(nav).getByRole('button', { name: 'focar #870' })).toHaveTextContent('#870');
  expect(within(nav).getByText('#872').tagName).toBe('SPAN');
  expect(within(nav).queryByRole('button', { name: 'focar #872' })).not.toBeInTheDocument();
  expect(screen.getByText('3 tarefas · o resto esmaecido')).toHaveClass('text-muted-foreground');
});

test('#870 in the trail widens the focus to the whole tree; × leaves it; a new source drops it for good; a focused task that leaves the list takes the trail with it (#35)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const user = userEvent.setup();
  const s = handoff();
  const { rerender } = render(<Flow state={s} />);
  await user.click(focusOn('872'));
  await user.click(within(trail()!).getByRole('button', { name: 'focar #870' }));
  expect(faded()).toEqual(['9']);
  expect(screen.getByText('7 tarefas · o resto esmaecido')).toBeInTheDocument();
  await user.click(within(trail()!).getByRole('button', { name: 'sair do foco' }));
  expect(trail()).not.toBeInTheDocument();
  expect(faded()).toEqual([]);
  await user.click(focusOn('872'));
  rerender(<Flow state={s} source="hive" />);
  expect(trail()).not.toBeInTheDocument();
  rerender(<Flow state={s} />);
  expect(trail()).not.toBeInTheDocument(); // back on the first source the focus stays dropped
  expect(faded()).toEqual([]);
  await user.click(focusOn('872'));
  rerender(<Flow state={{ ...s, tasks: s.tasks.filter((c) => c.item.itemId !== 'I872') }} />);
  expect(trail()).not.toBeInTheDocument();
  expect(document.querySelector('[data-flow-stages] .opacity-30')).toBeNull(); // the chart's, not the zoom controls' idle fade (#81)
});

test('Esc leaves the focus, prevented so the details panel\'s Escape never sees it, and the next Esc is the panel\'s; Esc in buscar tarefas only clears the search (#35)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const panel = vi.fn();
  // useClosePanelKey's rule (#426): on the document, bubbling, and it skips a prevented key
  const panelKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) panel(); };
  document.addEventListener('keydown', panelKey);
  onTestFinished(() => document.removeEventListener('keydown', panelKey));
  const user = userEvent.setup();
  render(<Flow state={handoff()} />);
  await user.click(focusOn('872'));
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'buscar tarefas' }), { key: 'Escape' });
  expect(trail()).toBeInTheDocument();
  expect(panel).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false);
  expect(trail()).not.toBeInTheDocument();
  expect(faded()).toEqual([]);
  expect(panel).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
  expect(panel).toHaveBeenCalledOnce();
});

test('Esc keeps the focus while the flow is hidden under Atividades and from inside an open dialog (#35)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const user = userEvent.setup();
  const s = handoff();
  const flow = (isShown: boolean) => <FlowShownContext.Provider value={isShown}><Flow state={s} /></FlowShownContext.Provider>;
  const { rerender } = render(flow(true));
  await user.click(focusOn('872'));
  rerender(flow(false));
  expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
  rerender(flow(true));
  expect(trail()).toBeInTheDocument();
  const dialog = document.body.appendChild(document.createElement('div'));
  dialog.setAttribute('role', 'dialog');
  onTestFinished(() => dialog.remove());
  expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(true);
  expect(trail()).toBeInTheDocument();
});

test('Esc keeps the focus while Settings, the console drawer or a node\'s list panel is open over the flow: the key is theirs (#35)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const user = userEvent.setup();
  render(<Flow state={handoff()} />);
  await user.click(focusOn('872'));
  for (const marker of ['data-settings-page', 'data-console-drawer', 'data-flow-list-panel']) {
    const layer = document.body.appendChild(document.createElement('div'));
    layer.setAttribute(marker, '');
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    expect(trail()).toBeInTheDocument();
    layer.remove();
  }
});
