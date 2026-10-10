import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Center, openShell, resetCenterTest, saved, seed, SESSION, SHELL, SIDE_BY_SIDE, STAGE, strips } from './center-harness';
import { FakeWebSocket } from './xterm-fakes';
import { statusText } from '@/i18n';
import type { Session } from '../../src/types';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

beforeEach(resetCenterTest);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the first pick opens the task\'s stage run alone, not every live run; with no stage run, its first live one (#458)', () => {
  const { unmount } = render(<Center runs={[SESSION, STAGE, SHELL]} />);
  expect(strips()).toEqual([['Claude']]);
  expect(FakeWebSocket.all.map((socket) => socket.path)).toEqual(['/ptys/W1/pty']);
  expect(screen.getByRole('region', { name: '#1 Task 1 · etapa' })).toBeVisible();
  unmount();
  render(<Center runs={[SESSION, SHELL]} />);
  expect(strips()).toEqual([['Claude · abcdef12']]);
});

test('a click in a group focuses it: a run opened then lands there, shown; opening it again only shows it (#458)', async () => {
  const user = userEvent.setup();
  seed(SIDE_BY_SIDE);
  const { rerender } = render(<Center runs={[STAGE, SESSION, SHELL]} />);
  expect(strips()).toEqual([['Claude'], ['Claude · abcdef12']]);
  await user.click(screen.getByRole('region', { name: '#1 Task 1 · sessão' })); // the second group's terminal
  rerender(<Center runs={[STAGE, SESSION, SHELL]} request={openShell} />);
  expect(strips()).toEqual([['Claude'], ['Claude · abcdef12', 'Terminal']]);
  expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('tab', { name: 'Claude · abcdef12' }));
  rerender(<Center runs={[STAGE, SESSION, SHELL]} request={{ tab: { kind: 'run', ptyId: 'W3' } }} />); // a new request, the same run
  expect(strips()).toEqual([['Claude'], ['Claude · abcdef12', 'Terminal']]);
  expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
});

test('a request for a run not live yet waits, the layout as it was, and opens once the run shows (#457, #458)', () => {
  const { rerender } = render(<Center runs={[STAGE]} request={openShell} />);
  expect(strips()).toEqual([['Claude']]);
  rerender(<Center runs={[STAGE, SHELL]} request={openShell} />);
  expect(strips()).toEqual([['Claude', 'Terminal']]);
});

test('a tab\'s X closes it and its terminal; the agent\'s run keeps going, the terminal sleeps under the default closeTerminalTab; the last one closed leaves the empty line, stored as absent (#458, #696)', async () => {
  const user = userEvent.setup();
  render(<Center runs={[STAGE, SHELL]} request={openShell} />);
  expect(strips()).toEqual([['Claude', 'Terminal']]);
  await user.click(screen.getByRole('button', { name: 'Fechar Terminal' }));
  expect(strips()).toEqual([['Claude']]);
  expect(FakeWebSocket.all.find((socket) => socket.path === '/ptys/W3/pty')?.closed).toBe(true); // the page's own attach, closed
  const stops = (): string[] => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith('/stop'));
  await waitFor(() => expect(stops()).toEqual(['/ptys/W3/stop'])); // a terminal's tab sleeps it by default (#696)
  await user.click(screen.getByRole('button', { name: 'Fechar Claude' }));
  expect(stops()).toEqual(['/ptys/W3/stop']); // nothing stops the agent's run (#452)
  expect(strips()).toEqual([]);
  expect(screen.getByText('Nenhuma aba aberta')).toBeInTheDocument();
  expect(saved()).toEqual({});
});

test('with no tab, the strip keeps only the + over the activity\'s home, which lists its sessions; nothing to split (#759)', () => {
  const kept: Session = { id: 'abcdef12-0000-4000-8000-000000000001', startedAt: '', stages: ['dev'], lastUsedAt: '' };
  render(<Center runs={[]} keptSessions={[kept]} />);
  expect(strips()).toEqual([]);
  expect(screen.getByRole('button', { name: 'Novo terminal ou sessão' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^dividir/ })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Nenhuma aba aberta' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'sessões · 1' })).getByRole('button')).toHaveTextContent(/^claudeabcdef12 · devdormindocontinuar$/);
});

test('a run whose stream ends drops its tab by itself (#457, #458)', () => {
  render(<Center runs={[STAGE, SHELL]} request={openShell} />);
  act(() => FakeWebSocket.all.find((socket) => socket.path === '/ptys/W3/pty')?.end());
  expect(strips()).toEqual([['Claude']]);
});

test('the layout survives a remount through the view state, a run no longer live dropped on read (#458, #484)', () => {
  const { unmount } = render(<Center runs={[STAGE, SESSION, SHELL]} request={openShell} />);
  expect(strips()).toEqual([['Claude', 'Terminal']]);
  unmount();
  render(<Center runs={[STAGE, SESSION]} />);
  expect(strips()).toEqual([['Claude']]);
  expect(saved().I1).toEqual({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }], active: 0 }, focused: 'g1' });
});

const box = (left: number, top: number, right: number, bottom: number): DOMRect =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
// One group 1000 wide: its strip 30 tall, its body 600 tall under it, each tab 100 wide in strip order
function stubRects(): void {
  vi.spyOn(HTMLElement.prototype, 'hasPointerCapture').mockReturnValue(true); // jsdom's own stub (setup.ts) is always false
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
    if (this.hasAttribute('data-center-strip')) return box(0, 0, 1000, 30);
    if (this.hasAttribute('data-center-body')) return box(0, 30, 1000, 630);
    const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
    return this.dataset.tabKey === undefined ? box(0, 0, 0, 0) : box(index * 100, 0, index * 100 + 100, 30);
  });
}

test('dragging a tab onto the right quarter of its group\'s body shades that half and, let go, splits the group with the tab on the right (#458)', () => {
  stubRects();
  render(<Center runs={[STAGE, SHELL]} request={openShell} />);
  const shell = screen.getByRole('tab', { name: 'Terminal' });
  fireEvent.pointerDown(shell, { pointerId: 1, pointerType: 'mouse' });
  fireEvent.pointerMove(shell, { pointerId: 1, pointerType: 'mouse', clientX: 900, clientY: 300 });
  expect(document.querySelector('[data-drop-edge]')).toHaveAttribute('data-drop-edge', 'right');
  fireEvent.pointerUp(shell, { pointerId: 1, pointerType: 'mouse', clientX: 900, clientY: 300 });
  expect(strips()).toEqual([['Claude'], ['Terminal']]);
  expect(saved().I1.root).toMatchObject({ kind: 'split', axis: 'row' });
  expect(document.querySelector('[data-drop-edge]')).toBeNull();
});

test('the divider between two groups moves their edge by 5 per arrow and never squeezes one below 10% (#458)', async () => {
  const user = userEvent.setup();
  seed(SIDE_BY_SIDE);
  render(<Center runs={[STAGE, SESSION]} />);
  screen.getByRole('separator', { name: 'redimensionar os grupos' }).focus();
  await user.keyboard('{ArrowRight}');
  expect(saved().I1.root).toMatchObject({ sizes: [55, 45] });
  await user.keyboard('{ArrowLeft}'.repeat(10));
  expect(saved().I1.root).toMatchObject({ sizes: [10, 90] });
});

test('the strip is 34px under a bottom border: the tabs, then the + right after them, outside the tablist (#491, #536)', () => {
  seed(SIDE_BY_SIDE);
  render(<Center runs={[STAGE, SESSION, SHELL]} />);
  const tablist = screen.getAllByRole('tablist', { name: 'abas' })[0];
  const plus = screen.getAllByRole('button', { name: 'Novo terminal ou sessão' })[0];
  expect(screen.getAllByRole('button', { name: 'Novo terminal ou sessão' })).toHaveLength(2); // one per group
  expect(tablist).not.toContainElement(plus); // only tabs inside a tablist
  expect(tablist.nextElementSibling).toContainElement(plus);
  expect(tablist.parentElement).toHaveClass('h-[34px]', 'border-b');
  expect(plus).toBeEnabled();
});

test('the bar sits over the whole center, above every group, and stays once no tab is left (#536)', async () => {
  const user = userEvent.setup();
  seed(SIDE_BY_SIDE);
  render(<Center runs={[STAGE, SESSION]} bar={<div data-testid="bar">bar</div>} />);
  const root = document.querySelector('[data-center-root]');
  expect(screen.getByTestId('bar').nextElementSibling).toBe(root);
  expect(root).not.toContainElement(screen.getByTestId('bar'));
  await user.click(screen.getByRole('button', { name: 'Fechar Claude' }));
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(screen.getByText('Nenhuma aba aberta')).toBeInTheDocument();
  expect(screen.getByTestId('bar')).toBeInTheDocument();
});

test('the shown tab reads on task with a foreground line at its foot, each tab has its status dot, and each pane shows its header (#536)', async () => {
  const user = userEvent.setup();
  const sessions = [{ run: STAGE, status: 'waiting' as const }, { run: SESSION, status: 'working' as const }];
  render(<Center runs={[STAGE, SESSION, SHELL]} request={openShell} sessions={sessions} pane={{ model: 'opus', folder: 'hive-1-task-1' }} />);
  const wrapper = (name: string): Element | null => screen.getByRole('tab', { name }).closest('[data-tab-key]');
  const dot = (name: string): Element | null => screen.getByRole('tab', { name }).querySelector('[aria-hidden="true"]');
  expect(wrapper('Terminal')).toHaveClass('bg-card', 'shadow-[inset_0_-2px_0_var(--foreground)]', 'border-r', 'px-3');
  expect(wrapper('Claude')).not.toHaveClass('bg-card');
  expect(dot('Claude')).toHaveClass('size-1.5', 'bg-waiting');
  expect(dot('Terminal')).toHaveClass('bg-empty'); // a shell reports no status (#192)
  const header = (): HTMLElement => document.querySelector<HTMLElement>('[data-pane-header]') as HTMLElement;
  expect(header()).toHaveTextContent(/^terminalhive-1-task-1$/);
  await user.click(screen.getByRole('tab', { name: 'Claude' }));
  expect(within(header()).getByText('claude')).toHaveClass('text-foreground');
  expect(within(header()).getByText('opus · hive-1-task-1')).toBeInTheDocument();
  expect(within(header()).getByText(statusText('waiting'))).toBeInTheDocument();
});

test('a local activity\'s center keeps its layout under local/<workspace>, opens a split in the workspace, and closing a terminal\'s tab stops that terminal (#590)', async () => {
  const user = userEvent.setup();
  render(<Center runs={[SHELL]} local="hive" request={openShell} />);
  expect(strips()).toEqual([['Terminal']]);
  expect(Object.keys(saved())).toEqual(['local/hive']);
  screen.getAllByRole('button', { name: 'dividir' })[0].focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'claude' }));
  expect(fetch).toHaveBeenCalledWith('/activities/local%3Ahive/sessions', expect.objectContaining({ method: 'POST' }));
  await user.click(screen.getByRole('button', { name: 'Fechar Terminal' }));
  expect(fetch).toHaveBeenCalledWith('/ptys/W3/stop', expect.objectContaining({ method: 'POST' }));
  expect(strips()).toEqual([]);
});
