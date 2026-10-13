import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import { setLanguage } from '@/i18n';
import { DEFAULT_DOCK_LAYOUT, inEveryView, type Side } from '@/lib/dock-layout';
import { readView, resetViewState } from '@/lib/view-state';
import type { SidebarsPerView, Worker, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

// One running task (#251): its terminal button opens its activity, the run a tab of the center (#457).
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const workerA: Worker = { id: 's1', status: 'working', activityId: activityIdOf('A'), runId: 'W1' };
const state: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [workerA], stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }],
  tasks: [taskA], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [],
});

const saved = (): unknown => readView('dockLayout') ?? null;
const group = (side: Side): HTMLElement | null => document.querySelector<HTMLElement>(`[data-dock="${side}"]`);

// The selection as App holds it: a new object on every pick
function Home({ initial, terminals = [], sidebarsPerView }: { initial?: Selection; terminals?: State['terminals']; sidebarsPerView?: SidebarsPerView }) {
  const [selected, setSelected] = useState<Selection | undefined>(initial);
  return <Dashboard state={{ ...state, terminals }} locale="pt-BR" tick={0} selected={selected} onSelect={setSelected} sidebarsPerView={sidebarsPerView} />;
}

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

// Ctrl+Shift+B and Ctrl+Alt+Shift+B under jsdom's platform, which is not macOS (#452, #585)
const panelKey = (side: Side): void => { fireEvent.keyDown(document.body, { key: 'B', ctrlKey: true, shiftKey: true, altKey: side === 'right' }); };
const ALL_OPEN: Record<Side, boolean> = { left: true, right: true };
const seed = (detail: Side, open: Record<Side, boolean> = ALL_OPEN): void =>
  resetViewState({ dockLayout: { docks: { automation: 'left', activities: 'left', detail }, sizes: inEveryView({ left: 30, right: 30 }), open: inEveryView(open) } });
// The board's own task, not the detail's title
const boardTask = (label: string): Element => screen.getAllByText(label).find((el) => el.closest('li'))!;
// The window opens on Atividades (#746): a test about the board or Detalhes beside it shows the flow first. Switching views never opens a side (#821)
const showFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); };

// Radix's ContextMenu opens once per file under jsdom (#377): this is the only test here that right-clicks a tab, kept first.
test('Detalhes sits alone in the right panel beside the center; its tab\'s menu moves it to the left panel, and the move persists (#342, #452)', async () => {
  render(<Home initial={{ taskId: 'A' }} />);
  showFlow();
  const right = group('right')!;
  expect(right.parentElement).toBe(screen.getByRole('main').parentElement!.parentElement!.parentElement); // beside the center column, in the frame
  expect(within(right).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Detalhes', 'true']]);
  expect(saved()).toMatchObject({ docks: { detail: 'right' }, open: { automation: { right: true } } });
  fireEvent.contextMenu(within(right).getByRole('tab', { name: 'Detalhes' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Mover para a esquerda']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para a esquerda' }));
  expect(within(group('left')!).getByRole('tab', { name: 'Detalhes' })).toBeInTheDocument();
  expect(group('right')).toBeNull();
  expect(saved()).toMatchObject({ docks: { detail: 'left' } });
});

test('the right group\'s divider resizes the detail by 5 per arrow, ArrowLeft wider, clamped to 15..70, saved in the view state and read back on the next mount (#342, #484)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Home initial={{ taskId: 'A' }} />);
  showFlow();
  const separator = () => screen.getByRole('separator', { name: 'redimensionar o painel da direita' });
  expect(['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map((a) => separator().getAttribute(a))).toEqual(['30', '15', '70']);
  expect(group('right')).toHaveStyle({ flexBasis: '30%' });
  separator().focus();
  await user.keyboard('{ArrowLeft}');
  expect(separator()).toHaveAttribute('aria-valuenow', '35');
  expect(saved()).toMatchObject({ sizes: { automation: { right: 35 } } });
  await user.keyboard('{ArrowRight}'.repeat(5));
  expect(separator()).toHaveAttribute('aria-valuenow', '15'); // floored
  await user.keyboard('{ArrowLeft}'.repeat(12));
  expect(separator()).toHaveAttribute('aria-valuenow', '70'); // ceiled
  unmount();
  render(<Home initial={{ taskId: 'A' }} />);
  showFlow();
  expect(separator()).toHaveAttribute('aria-valuenow', '70');
  expect(group('right')).toHaveStyle({ flexBasis: '70%' });
});

test('the first run opens the center on Home and the left panel on the Atividades tab, with Automação mounted beside it holding the signal toggle, the worker cap, the shut-down toggle and the sources; the right stays closed, the footer holds no signal and the header brand\'s mark does (#452, #456, #457, #746)', () => {
  render(<Home />);
  const left = group('left')!;
  expect(screen.getByRole('heading', { name: 'Nenhuma atividade aberta' })).toBeInTheDocument();
  expect(screen.queryAllByRole('tab')).toEqual([]); // each sidebar draws its own header; the window header's views switch them (redesign 03, 09)
  expect(left).toContainElement(screen.getByRole('region', { name: 'Atividades' }));
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
  const automation = screen.getByRole('region', { name: 'Automação' });
  expect(left).toContainElement(automation); // mounted beside Atividades (#456), not shown
  expect(automation).not.toBeVisible();
  expect(within(automation).getAllByRole('radio').map((item) => item.textContent)).toEqual(['green', 'yellow', 'red']);
  expect(within(automation).getByLabelText('máx.')).toBeInTheDocument();
  expect(within(automation).getByRole('button', { name: /^todas/ })).toBeInTheDocument(); // the sources (redesign 09)
  const footer = screen.getByRole('contentinfo');
  expect(within(footer).queryByRole('status')).not.toBeInTheDocument(); // #227: the signal is the brand's mark
  expect(document.querySelector('header [data-signal]')).toHaveAttribute('data-signal', 'green'); // by the manual signal before an effective one
  expect(within(footer).queryAllByRole('radio')).toEqual([]);
  expect(within(footer).getAllByRole('button').filter((b) => b.closest('[data-usage-group]') === null).map((b) => b.textContent)).toEqual(['regras nenhuma ativa', '', 'console', '', '']); // the rules button (#224); the usage group (#223) aside, the problems button (#225, icon only), the console's chip (redesign 05) and the power buttons
  expect(within(footer).queryByLabelText('máx.')).not.toBeInTheDocument();
  expect(within(document.querySelector('header')!).queryByRole('radio', { name: 'green' })).not.toBeInTheDocument(); // the signal choice opens from the brand, closed here (#221)
  expect(within(document.querySelector('header')!).queryByRole('status')).not.toBeInTheDocument();
  expect(saved()).toEqual(DEFAULT_DOCK_LAYOUT);
});

test('Cmd+Shift+B hides the right panel, its body still mounted, and brings it back with Detalhes shown (#452)', () => {
  seed('right', { left: false, right: true }); // the left, closed, holds Automação (#456)
  render(<Home initial={{ taskId: 'A' }} />);
  showFlow();
  expect(screen.getByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
  panelKey('right');
  expect(within(group('right')!).queryAllByRole('tab', { hidden: true })).toEqual([]);
  expect(screen.getByRole('complementary', { name: 'detalhe', hidden: true })).not.toBeVisible();
  expect(saved()).toMatchObject({ open: { automation: { right: false } } });
  panelKey('right');
  expect(within(group('right')!).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Detalhes', 'true']]);
  expect(screen.getByRole('complementary', { name: 'detalhe' })).toBeVisible();
});

test('Cmd+B closes the left panel, open on Atividades, and opens it again on the same tab, its body mounted all along (#452, #746)', () => {
  render(<Home />);
  panelKey('left');
  expect(saved()).toMatchObject({ open: { activities: { left: false } } });
  expect(screen.queryAllByRole('tab', { hidden: true })).toEqual([]);
  expect(screen.getByRole('region', { name: 'Atividades', hidden: true })).not.toBeVisible();
  panelKey('left');
  expect(saved()).toMatchObject({ open: { activities: { left: true } } });
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
});

test('selecting a task opens its closed panel with Detalhes as the shown tab, the same task again included; a task\'s terminal button leaves the closed left panel closed, Atividades shown once reopened, its run in the center (#342, #452, #457, #612)', async () => {
  const user = userEvent.setup();
  seed('right', { left: false, right: false }); // every side closed, Automação's (#456) included
  render(<Home />);
  showFlow();
  expect(within(group('right')!).queryAllByRole('tab', { hidden: true })).toEqual([]);
  await user.click(boardTask('#1 Task A'));
  expect(screen.getByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('complementary', { name: 'detalhe' })).toBeVisible();
  panelKey('right');
  await user.click(boardTask('#1 Task A')); // the same task again
  expect(screen.getByRole('complementary', { name: 'detalhe' })).toBeVisible();
  panelKey('right');
  await user.click(screen.getAllByRole('button', { name: 'abrir' })[0]); // the board's task A, before the collapsed detail's footer
  expect(screen.getByRole('region', { name: 'Atividades', hidden: true })).not.toBeVisible(); // the left side stays closed (#612)
  panelKey('left');
  expect(screen.getByRole('region', { name: 'Atividades' })).toBeVisible();
  expect(screen.getByRole('region', { name: '#1 Task A · etapa' })).toBeVisible();
  expect(FakeWebSocket.all.map((s) => s.path)).toEqual(['/ptys/W1/pty']);
});

test('a closed right panel leaves no strip: no tab and no divider, the detail\'s body still mounted; Cmd+Shift+B brings both back (#342, #452)', () => {
  render(<Home />);
  showFlow();
  const right = group('right')!;
  expect(within(right).queryByRole('tablist', { hidden: true })).not.toBeInTheDocument();
  expect(within(right).queryAllByRole('separator', { name: /^redimensionar o painel/, hidden: true })).toEqual([]);
  expect(screen.getByText('Nenhuma tarefa selecionada')).not.toBeVisible();
  panelKey('right');
  expect(screen.getByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('separator', { name: 'redimensionar o painel da direita' })).toHaveAttribute('aria-orientation', 'vertical');
});


// Ctrl+1 / Ctrl+2 under jsdom's platform, which is not macOS (#533, #585)
const viewKey = (digit: '1' | '2'): void => { fireEvent.keyDown(document.body, { key: digit, code: `Digit${digit}`, ctrlKey: true }); };

test('⌘1 / ⌘2 never open a closed left side: with no setting given the side is shared, so it stays closed in both views (#821)', () => {
  render(<Home />);
  panelKey('left');
  viewKey('2');
  expect(screen.getByRole('region', { name: 'Automação', hidden: true })).not.toBeVisible();
  viewKey('1');
  expect(screen.getByRole('region', { name: 'Atividades', hidden: true })).not.toBeVisible();
  expect(saved()).toMatchObject({ open: { activities: { left: false }, automation: { left: false } } });
});

test('with the left kept per view, ⌘1 / ⌘2 restore each view\'s own left side: closed in the activities, open in the flow (#821)', () => {
  render(<Home sidebarsPerView={{ left: true, right: true, rightTab: true }} />);
  panelKey('left');
  viewKey('2');
  expect(screen.getByRole('region', { name: 'Automação' })).toBeVisible();
  viewKey('1');
  expect(screen.getByRole('region', { name: 'Atividades', hidden: true })).not.toBeVisible();
  expect(saved()).toMatchObject({ open: { activities: { left: false }, automation: { left: true } } });
});
