import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LiveRun } from '../../src/task-runs';
import { CloseTabContext, type CloseTabSettings, showCloseTabNotice } from '@/components/close-tab-notice';
import { RunOpenerContext } from '@/components/terminal-tabs';
import type { TabRequest } from '@/hooks/use-activity';
import type { CenterLayout } from '@/lib/center-layout';
import { resetViewState } from '@/lib/view-state';
import { Center, resetCenterTest, saved, seed, SESSION, SHELL, STAGE, strips } from './center-harness';
import { FakeTerminal, FakeWebSocket } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
// The notice's own behaviour is close-tab-notice.test.tsx's; here only whether a close asks for it
vi.mock('@/components/close-tab-notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/close-tab-notice')>()), showCloseTabNotice: vi.fn(),
}));

const KEEP: CloseTabSettings = { closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true };
let closeKey: (() => void) | undefined;
// What ⌘W does through the preload (#585): the page's callback
const pressClose = (): void => {
  act(() => {
    closeKey?.();
  });
};

beforeEach(() => {
  resetCenterTest();
  resetViewState();
  closeKey = undefined;
  vi.mocked(showCloseTabNotice).mockClear();
  // focusDetached: a run's open asks the bridge for its detached window first, and answers none
  vi.stubGlobal('hive', { onCloseKey: (callback: () => void) => { closeKey = callback; return () => undefined; }, focusDetached: async () => false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// One tab: `anchor` with `other` on its right, half and half, `focused` the pane the keys act on (#641)
const paned = (anchor: string, other: string, focused = other): CenterLayout => ({
  root: {
    kind: 'group', id: 'g1', active: 0,
    tabs: [{ kind: 'run', ptyId: anchor, panes: { focused, root: { kind: 'split', axis: 'row', sizes: [50, 50], children: [{ kind: 'pane', ptyId: anchor }, { kind: 'pane', ptyId: other }] } } }],
  },
  focused: 'g1',
});
function pane(ptyId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-pane="${ptyId}"]`);
  if (element === null) throw new Error(`no pane for ${ptyId}`);
  return element;
}
const header = (): string => document.querySelector('[data-pane-header]')?.textContent ?? '';
const stops = (): string[] => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith('/stop'));
// The center with that layout stored for the task's activity, or for workspace `local`'s (#590)
function renderSplit(layout: CenterLayout, runs: LiveRun[], { local, settings = KEEP }: { local?: string; settings?: CloseTabSettings } = {}) {
  resetViewState({ centerLayouts: { [local === undefined ? 'I1' : `local/${local}`]: layout } });
  return render(<CloseTabContext.Provider value={settings}><Center runs={runs} local={local} /></CloseTabContext.Provider>);
}

test('a split tab shows its runs side by side under one tab named after its anchor, the unfocused pane dimmed; its divider resizes the panes (#641)', () => {
  renderSplit(paned('W1', 'W3'), [STAGE, SHELL]);
  expect(strips()).toEqual([['Claude']]);
  expect(FakeWebSocket.all.map((socket) => socket.path)).toEqual(['/ptys/W1/pty', '/ptys/W3/pty']);
  expect([pane('W1').style.opacity, pane('W3').style.opacity]).toEqual(['0.6', '1']);
  fireEvent.keyDown(screen.getByRole('separator', { name: 'redimensionar os terminais' }), { key: 'ArrowRight' });
  expect(saved().I1.root).toMatchObject({ tabs: [{ panes: { root: { sizes: [55, 45] } } }] });
});

test('a pointer down in a pane focuses it: the header and the keyboard follow, and the focus is stored (#641)', () => {
  const focus = vi.spyOn(FakeTerminal.prototype, 'focus');
  renderSplit(paned('W1', 'W3'), [STAGE, SHELL]);
  expect(header()).toMatch(/^terminal/);
  fireEvent.pointerDown(pane('W1'));
  expect(header()).toMatch(/^claude/);
  expect([pane('W1').style.opacity, pane('W3').style.opacity]).toEqual(['1', '0.6']);
  expect(focus.mock.contexts.at(-1)).toBe(FakeTerminal.all[0]); // W1's xterm, the first one opened
  expect(saved().I1.root).toMatchObject({ tabs: [{ panes: { focused: 'W1' } }] });
});

test('⌘W closes the focused pane, its run by the rule a tab\'s close follows, then the tab with its last pane (#641)', () => {
  renderSplit(paned('W1', 'W3'), [STAGE, SHELL]);
  pressClose();
  expect(saved().I1).toEqual({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }], active: 0 }, focused: 'g1' });
  expect(stops()).toEqual([]); // a task's terminal goes on behind its pane
  expect(showCloseTabNotice).not.toHaveBeenCalled();
  pressClose();
  expect(strips()).toEqual([]);
  expect(vi.mocked(showCloseTabNotice).mock.calls.at(-1)?.[0]).toMatchObject({ run: STAGE });
});

test('closing the focused anchor pane hands the tab to the pane left (#641)', () => {
  renderSplit(paned('W1', 'W3', 'W1'), [STAGE, SHELL]);
  pressClose();
  expect(saved().I1).toEqual({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W3' }], active: 0 }, focused: 'g1' });
  expect(strips()).toEqual([['Terminal']]);
});

test('a pane whose stream ends leaves the split; the tab stays with the other run (#641)', () => {
  renderSplit(paned('W1', 'W3'), [STAGE, SHELL]);
  act(() => FakeWebSocket.all.find((socket) => socket.path === '/ptys/W3/pty')?.end());
  expect(saved().I1).toEqual({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }], active: 0 }, focused: 'g1' });
  expect(strips()).toEqual([['Claude']]);
});

test('the tab\'s × closes every run it holds, each by its rule: a session sleeps by its setting, a local terminal ends with it (#641, #614)', async () => {
  const user = userEvent.setup();
  renderSplit(paned('W2', 'W3'), [SESSION, SHELL], { local: 'hive', settings: { ...KEEP, closeSessionTab: 'sleep', closeSessionTabNotice: false } });
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(stops()).toEqual(['/ptys/W2/stop', '/ptys/W3/stop']);
  expect(strips()).toEqual([]);
});

const SHELL_2: LiveRun = { ptyId: 'W5', label: 'Terminal 2', kind: 'terminal' };
// MainDock's run opener in small (#457), as SplitMenu.test.tsx's: an answered run becomes a request for its tab, opened once it is live
function Opened({ runs }: { runs: LiveRun[] }) {
  const [request, setRequest] = useState<TabRequest>();
  return (
    <RunOpenerContext.Provider value={(tab) => setRequest({ tab: { kind: 'run', ptyId: tab.ptyId } })}>
      <Center runs={runs} request={request} />
    </RunOpenerContext.Provider>
  );
}
// POST /open answers this run; anything else (a PtyTab's own calls) answers ok
function answerOpen(ptyId: string): void {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const body = String(input).endsWith('/open') ? { ok: true, ptyId } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}
const posted = (kind: string) => expect(fetch).toHaveBeenCalledWith('/activities/a-I1/open', expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind }) }));
// Off macOS, as jsdom is: Ctrl+Shift+D splits vertically, Ctrl+Alt+Shift+D horizontally (#585)
const splitKey = (horizontal = false): void => {
  fireEvent.keyDown(document.body, { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true, altKey: horizontal });
};
// The group a fold leaves: `anchor`'s tab split with `other` after it on `axis`, `other` focused
const twoPanes = (anchor: string, other: string, axis: 'row' | 'column') => ({
  kind: 'group', id: 'g1', active: 0,
  tabs: [{ kind: 'run', ptyId: anchor, panes: { focused: other, root: { kind: 'split', axis, sizes: [50, 50], children: [{ kind: 'pane', ptyId: anchor }, { kind: 'pane', ptyId: other }] } } }],
});

test('Ctrl+Shift+D on an agent\'s tab opens a terminal and shows both in that one tab, side by side, the terminal focused (#641)', async () => {
  answerOpen('W3');
  render(<Opened runs={[STAGE, SHELL]} />);
  splitKey();
  posted('terminal');
  await waitFor(() => expect(saved().I1?.root).toEqual(twoPanes('W1', 'W3', 'row')));
  expect(strips()).toEqual([['Claude']]);
  expect(header()).toMatch(/^terminal/);
});

test('Ctrl+Alt+Shift+D on a terminal\'s tab stacks a new terminal below it (#641)', async () => {
  answerOpen('W5');
  seed({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W3' }], active: 0 }, focused: 'g1' });
  render(<Opened runs={[STAGE, SHELL, SHELL_2]} />);
  splitKey(true);
  posted('terminal');
  await waitFor(() => expect(saved().I1?.root).toEqual(twoPanes('W3', 'W5', 'column')));
  expect(strips()).toEqual([['Terminal']]);
});

test('the keys open nothing while the focused group shows a tab that is no run (#641)', () => {
  seed({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'console' }], active: 0 }, focused: 'g1' });
  render(<Opened runs={[STAGE, SHELL]} />);
  splitKey();
  splitKey(true);
  expect(fetch).not.toHaveBeenCalledWith('/activities/a-I1/open', expect.anything());
});

test('splitSame on a split tab repeats the focused pane\'s kind, not the anchor\'s (#641, #536)', () => {
  renderSplit(paned('W1', 'W3'), [STAGE, SHELL]); // W3, a terminal, focused beside the stage run
  fireEvent.keyDown(document.body, { key: '\\', code: 'Backslash', ctrlKey: true, shiftKey: true });
  posted('terminal');
});
