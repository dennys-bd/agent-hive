import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { type BackLink, FlowHeader, lastPolled } from '@/components/FlowHeader';
import { Flow } from '@/components/Flow';
import { HeaderSlotProvider, useHeaderSlotRef } from '@/components/HeaderSlot';
import { FlowShownContext } from '@/components/MainDock';
import { setLanguage } from '@/i18n';
import { setShortcuts } from '@/lib/shortcut-bindings';
import type { Task, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { type WithWork, movedWork } from '../fixtures/work';

const stages: Stage[] = [{ name: 'dev', from: { roadmap: ['Ready'], notes: ['todo'] }, prompt: '/hive-build {url}' }];
const task = (id: string, source: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', source }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const at = (hours: number, minutes: number): string => new Date(2026, 8, 29, hours, minutes).toISOString(); // local time, whatever the TZ
const state = (tasks: Task[], extra: Partial<State> = {}): State => movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['hive', 'site', 'docs'], sourceWorkspaces: { roadmap: 'hive', notes: 'site' }, workspaceColors: {}, commands: {},
  syncs: { roadmap: { polledAt: at(9, 28) }, notes: { polledAt: at(9, 5) } },
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, ...extra,
});
const tasks = [task('1', 'roadmap', { branch: 'hive/1-pager' }), task('2', 'notes'), task('3', 'roadmap', { branch: 'hive/3-pager' })];
const titles = () => screen.getAllByText(/^#\d Task/).map((el) => el.textContent);
const header = (): HTMLElement => screen.getByRole('region', { name: 'fluxo' });
const chips = (): string[] => within(header()).queryAllByText(/^(hive|site|docs)$/).map((el) => el.textContent ?? '');
const dataTransfer = () => {
  const data = new Map<string, string>();
  return { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: 'move', dropEffect: 'move' };
};
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the header names todas as sources or the picked one, one chip per workspace a shown task resolves to in the Comb\'s order, and the latest poll of the shown sources (#542)', () => {
  const { rerender } = render(<Flow state={state(tasks)} />);
  expect(within(header()).getByText('todas as sources')).toBeInTheDocument();
  expect(chips()).toEqual(['hive', 'site']); // docs has no task
  expect(within(header()).queryByRole('button', { name: /^(hive|site)$/ })).not.toBeInTheDocument(); // a legend, not a filter
  expect(within(header()).getByText('atualizado 09:28')).toBeInTheDocument();
  rerender(<Flow state={state(tasks)} source="notes" />);
  expect(within(header()).getByText('notes')).toBeInTheDocument();
  expect(chips()).toEqual(['site']);
  expect(within(header()).getByText('atualizado 09:05')).toBeInTheDocument();
  rerender(<Flow state={state(tasks, { syncs: {} })} />);
  expect(within(header()).queryByText(/^atualizado/)).not.toBeInTheDocument();
});

test('buscar tarefas hides the tasks that match neither title, number nor branch, and a drop still reads the full order; ⌘F focuses it and Esc clears and leaves it (#542)', async () => {
  const user = userEvent.setup();
  render(<Flow state={state(tasks)} />);
  const field = screen.getByRole('textbox', { name: 'buscar tarefas' });
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true }); // jsdom is not macOS: CmdOrCtrl is Ctrl
  expect(field).toHaveFocus();
  await user.keyboard('PAGER');
  expect(titles()).toEqual(['#1 Task 1', '#3 Task 3']);
  // #1 before #3 moves it past the hidden #2: with the search's order it would already be there and post nothing
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 40, height: 40, left: 0, right: 0, width: 100, x: 0, y: 0, toJSON: () => undefined } as DOMRect);
  const [one, three] = ['#1 Task 1', '#3 Task 3'].map((text) => screen.getByText(text).closest('li')!);
  const dt = dataTransfer();
  fireEvent.dragStart(one, { dataTransfer: dt });
  fireEvent(three, Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer: dt, clientY: 10 }));
  fireEvent(three, Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt, clientY: 10 }));
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I1/move', expect.objectContaining({ method: 'POST', body: JSON.stringify({ before: 'I3' }) }));
  fireEvent.dragEnd(one, { dataTransfer: dt });
  rect.mockRestore();
  await user.clear(field);
  await user.type(field, '#2');
  expect(titles()).toEqual(['#2 Task 2']);
  await user.keyboard('{Escape}');
  expect(field).toHaveValue('');
  expect(field).not.toHaveFocus();
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3']);
});

test('atualizar posts /sources/refresh and stays disabled until it answers (#542)', async () => {
  const user = userEvent.setup();
  let answer: (res: Response) => void = () => undefined;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  render(<Flow state={state(tasks)} />);
  const refresh = within(header()).getByRole('button', { name: 'atualizar' });
  await user.click(refresh);
  expect(fetchMock).toHaveBeenLastCalledWith('/sources/refresh', expect.objectContaining({ method: 'POST' }));
  expect(refresh).toBeDisabled();
  answer(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  await waitFor(() => expect(refresh).toBeEnabled());
});

test('lastPolled is the latest poll of the shown sources in local HH:MM, undefined before any poll (#542)', () => {
  const syncs = { a: { polledAt: at(9, 5) }, b: { polledAt: at(14, 7) }, c: {} };
  expect(lastPolled(syncs)).toBe('14:07');
  expect(lastPolled(syncs, 'a')).toBe('09:05');
  expect(lastPolled(syncs, 'c')).toBeUndefined();
  expect(lastPolled({})).toBeUndefined();
});

test('F5 refreshes the flow as atualizar does while the flow shows; hidden under Atividades the key is not bound (#585)', async () => {
  const f5 = (): boolean => fireEvent.keyDown(window, { key: 'F5', code: 'F5' }); // refreshFlow off macOS
  const { unmount } = render(<Flow state={state(tasks)} />);
  expect(f5()).toBe(false);
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/sources/refresh', expect.objectContaining({ method: 'POST' })));
  unmount();
  fetchMock.mockClear();
  render(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} isShown={false} />);
  expect(f5()).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('atualizar shows its refreshFlow keys beside its text, out of its name, and none while the shortcut is off (#670)', () => {
  const { unmount } = render(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} />);
  const refresh = within(header()).getByRole('button', { name: 'atualizar' }); // the hint is aria-hidden, so the name stays the text
  expect(refresh).toHaveTextContent('F5'); // jsdom is not macOS
  unmount();
  setShortcuts({ refreshFlow: null });
  onTestFinished(() => setShortcuts({}));
  render(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} />);
  expect(within(header()).getByRole('button', { name: 'atualizar' })).toHaveTextContent(/^atualizar$/);
});

test('with tabs the header names the source, drops the workspace chips and the last poll, and its tabs pick fluxo or the native view (#756)', async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<FlowHeader state={state(tasks)} source="roadmap" tasks={tasks} search="" onSearch={vi.fn()} tabs={{ label: 'GitHub Project', active: 'flow', onPick }} />);
  expect(within(header()).getByText('roadmap')).toBeInTheDocument();
  expect(chips()).toEqual([]);
  expect(within(header()).queryByText(/^atualizado/)).not.toBeInTheDocument();
  expect(within(header()).getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
  expect(within(header()).getByRole('tab', { name: 'GitHub Project' })).toHaveAttribute('aria-selected', 'false');
  await user.click(within(header()).getByRole('tab', { name: 'GitHub Project' }));
  expect(onPick).toHaveBeenCalledWith('native');
});

test('with onRefresh, atualizar runs it instead of polling every source (#756)', async () => {
  const user = userEvent.setup();
  const onRefresh = vi.fn(async () => undefined);
  render(<FlowHeader state={state(tasks)} source="roadmap" tasks={[]} search="" onSearch={vi.fn()} tabs={{ label: 'GitHub Project', active: 'native', onPick: vi.fn() }} onRefresh={onRefresh} />);
  await user.click(within(header()).getByRole('button', { name: 'atualizar' }));
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('with a repository the header shows its workspace square, its name, its workspace, the PRs and issues tabs with GitHub\'s open counts, and its own search (#757, #758)', async () => {
  const user = userEvent.setup();
  const onTab = vi.fn();
  const summary = { repository: 'acme/web', url: 'https://github.com/acme/web', workspace: 'site', openPrs: 2, openIssues: 23, closedIssues: 4, canPush: true, issuesEnabled: true, syncedAt: null };
  render(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} repository={{ summary, tab: 'prs', onTab }} />);
  expect(within(header()).getByText('web')).toHaveAttribute('title', 'acme/web');
  expect(within(header()).getByText('workspace site')).toBeInTheDocument();
  expect(chips()).toEqual([]);
  expect(within(header()).queryByText(/^atualizado/)).not.toBeInTheDocument();
  expect(within(header()).getByRole('textbox', { name: 'buscar no repositório' })).toBeInTheDocument();
  expect(within(header()).getByRole('tab', { name: 'PRs 2' })).toHaveAttribute('aria-selected', 'true');
  const issues = within(header()).getByRole('tab', { name: 'issues 23' });
  expect(issues).toHaveAttribute('aria-selected', 'false');
  await user.click(issues);
  expect(onTab).toHaveBeenCalledWith('issues');
});

test('↺ voltas shows only with onLoops, after the spacer and before the search: pressed with its hide title while on, its show title while off; a click calls onLoops (#909)', async () => {
  const user = userEvent.setup();
  const onLoops = vi.fn();
  const { rerender } = render(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} />);
  expect(within(header()).queryByRole('button', { name: '↺ voltas' })).not.toBeInTheDocument();
  rerender(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} loops onLoops={onLoops} />);
  const loops = within(header()).getByRole('button', { name: '↺ voltas' });
  expect(loops.nextElementSibling).toBe(screen.getByRole('textbox', { name: 'buscar tarefas' }).closest('label'));
  expect(loops).toHaveAttribute('aria-pressed', 'true');
  expect(loops).toHaveAttribute('title', 'esconder as voltas · ficam só as setas entre as etapas');
  expect(loops).toHaveClass('bg-muted', 'text-foreground');
  await user.click(loops);
  expect(onLoops).toHaveBeenCalledOnce();
  rerender(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} loops={false} onLoops={onLoops} />);
  expect(loops).toHaveAttribute('aria-pressed', 'false');
  expect(loops).toHaveAttribute('title', 'mostrar as voltas');
  expect(loops).toHaveClass('bg-transparent', 'text-muted-foreground');
  setLanguage('en');
  rerender(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} loops={false} onLoops={onLoops} />);
  expect(screen.getByRole('button', { name: '↺ loops' })).toHaveAttribute('title', 'show the loops');
  rerender(<FlowHeader state={state(tasks)} tasks={tasks} search="" onSearch={vi.fn()} loops onLoops={onLoops} />);
  expect(screen.getByRole('button', { name: '↺ loops' })).toHaveAttribute('title', 'hide the loops · only the arrows between stages stay');
});

const BACK_KEY = { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }; // goBack off macOS: jsdom is not macOS

test('a back entry starts the header with ‹ and its label, then a 1×14px divider, before the source\'s name; its title names the key as bound, and a click goes back (#911)', async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  const tabs = { label: 'GitHub Project', active: 'native' as const, onPick: vi.fn() };
  const page = (back?: BackLink) => <FlowHeader state={state(tasks)} source="roadmap" tasks={[]} tabs={tabs} back={back} />;
  const { rerender } = render(page());
  expect(within(header()).queryByRole('button', { name: 'issue #458' })).not.toBeInTheDocument();
  rerender(page({ label: 'issue #458', onBack }));
  const back = within(header()).getByRole('button', { name: 'issue #458' }); // ‹ is aria-hidden: the name is the label
  expect(header().firstElementChild).toBe(back);
  expect(back).toHaveTextContent('‹issue #458');
  expect(back).toHaveClass('max-w-[220px]', 'rounded-[6px]', 'text-xs', 'font-medium');
  expect(back).toHaveAttribute('title', 'voltar · Alt+←');
  expect(back.nextElementSibling).toHaveClass('h-3.5', 'w-px', 'bg-border');
  expect(back.nextElementSibling?.nextElementSibling).toHaveTextContent('roadmap');
  await user.click(back);
  expect(onBack).toHaveBeenCalledOnce();
  setShortcuts({ goBack: 'Alt+[' });
  onTestFinished(() => setShortcuts({}));
  rerender(page({ label: 'issue #458', onBack }));
  expect(back).toHaveAttribute('title', 'voltar · Alt+['); // a rebound key shows
});

test('Alt+Left and the mouse\'s back button go back only while a back button shows on a shown flow; another mouse button does nothing (#911)', () => {
  const onBack = vi.fn();
  const page = (isShown: boolean, back?: BackLink) => (
    <FlowShownContext.Provider value={isShown}><FlowHeader state={state(tasks)} tasks={[]} back={back} /></FlowShownContext.Provider>
  );
  const { rerender } = render(page(true));
  expect(fireEvent.keyDown(window, BACK_KEY)).toBe(true); // no button: not bound
  expect(fireEvent.mouseUp(window, { button: 3 })).toBe(true);
  rerender(page(true, { label: 'issue #458', onBack }));
  expect(fireEvent.keyDown(window, BACK_KEY)).toBe(false);
  expect(fireEvent.mouseUp(window, { button: 3 })).toBe(false);
  expect(fireEvent.mouseUp(window, { button: 0 })).toBe(true);
  expect(onBack).toHaveBeenCalledTimes(2);
  rerender(page(false, { label: 'issue #458', onBack })); // hidden under Atividades (#596)
  expect(fireEvent.keyDown(window, BACK_KEY)).toBe(true);
  expect(fireEvent.mouseUp(window, { button: 3 })).toBe(true);
  expect(onBack).toHaveBeenCalledTimes(2);
});

test('⑂ árvore shows only with onTree, right before ↺ voltas, pressed with its ungroup title when on and its group title when off; a click calls onTree (#34)', async () => {
  const user = userEvent.setup();
  const onTree = vi.fn();
  const { rerender } = render(<FlowHeader state={state(tasks)} tasks={tasks} onLoops={() => {}} />);
  expect(screen.queryByRole('button', { name: '⑂ árvore' })).not.toBeInTheDocument();
  rerender(<FlowHeader state={state(tasks)} tasks={tasks} tree onTree={onTree} onLoops={() => {}} />);
  const tree = screen.getByRole('button', { name: '⑂ árvore' });
  expect(tree).toHaveAttribute('aria-pressed', 'true');
  expect(tree).toHaveAttribute('title', 'agrupado por árvore · clique para desagrupar');
  expect(tree).toHaveClass('bg-muted', 'text-foreground');
  expect(tree.nextElementSibling).toBe(screen.getByRole('button', { name: '↺ voltas' }));
  rerender(<FlowHeader state={state(tasks)} tasks={tasks} tree={false} onTree={onTree} onLoops={() => {}} />);
  expect(tree).toHaveAttribute('aria-pressed', 'false');
  expect(tree).toHaveAttribute('title', 'agrupar por árvore');
  expect(tree).toHaveClass('bg-transparent', 'text-muted-foreground');
  await user.click(tree);
  expect(onTree).toHaveBeenCalledOnce();
});

test('⌘F leaves buscar tarefas alone while the Settings page is open, and the key goes on unprevented (#689)', () => {
  render(<><Flow state={state(tasks)} /><div data-settings-page="" /></>);
  const field = screen.getByRole('textbox', { name: 'buscar tarefas' });
  expect(fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true);
  expect(field).not.toHaveFocus();
});

// A header's center column as Header registers it (#295)
function Slot() {
  return <div data-testid="slot" ref={useHeaderSlotRef()} />;
}
const inSlot = (hasSlot: boolean, isShown = true) => (
  <HeaderSlotProvider>
    {hasSlot && <Slot />}
    <FlowShownContext.Provider value={isShown}><div data-testid="page"><FlowHeader state={state([])} tasks={[]} /></div></FlowShownContext.Provider>
  </HeaderSlotProvider>
);

test('under a header slot provider the bar renders in the registered slot, not in its page; nothing while no slot is registered or the flow is hidden; alone it stays in place (#295, #596)', () => {
  const { rerender } = render(inSlot(true));
  expect(screen.getByTestId('slot')).toContainElement(header());
  expect(screen.getByTestId('page')).toBeEmptyDOMElement();
  expect(header()).not.toHaveClass('h-10');
  expect(header()).not.toHaveClass('border-b');
  expect(header().className).toContain('[-webkit-app-region:no-drag]'); // its controls keep their clicks in the dragging header
  rerender(inSlot(true, false));
  expect(screen.queryByRole('region', { name: 'fluxo' })).not.toBeInTheDocument();
  rerender(inSlot(false));
  expect(screen.queryByRole('region', { name: 'fluxo' })).not.toBeInTheDocument();
});
