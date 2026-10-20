import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PtyTab } from '@/components/PtyTab';
import { toast } from 'sonner';
import { FileOpenerContext, localRunTab, type OpenFile, type RunTab } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { FakeWebSocket, FakeFitAddon, FakeSearchAddon, FakeTerminal, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@xterm/addon-search', async () => ({ SearchAddon: (await import('./xterm-fakes')).FakeSearchAddon }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// A task's stage run, what each test attaches
const STAGE: RunTab = { ptyId: 'W1', kind: 'stage', task: 'I1', title: '#1 Task 1' };
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));

// Portuguese copy, fresh xterm fakes, a clean fetch and toast; paired with vi.unstubAllGlobals() after each test
function resetPtyTest(): void {
  setLanguage('pt');
  resetFakes();
  fetchMock.mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

// jsdom lays nothing out: every element measures 0x0 unless a test gives the host a size, and the observer fires only by hand
let size = { width: 0, height: 0 };
const observers: ResizeObserverCallback[] = [];
class ResizeObserverSpy {
  constructor(callback: ResizeObserverCallback) {
    observers.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const resized = (width: number, height: number): void => {
  size = { width, height };
  for (const callback of observers) callback([], {} as ResizeObserver);
};

beforeEach(() => {
  resetPtyTest();
  observers.length = 0;
  size = { width: 800, height: 600 };
  vi.stubGlobal('ResizeObserver', ResizeObserverSpy);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.height);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tab = (fontFamily: string, onExit: (ptyId: string) => void) =>
  <PtyTab tab={STAGE} label="#1 Task 1 · etapa" active fileLinks={false} fontFamily={fontFamily} onExit={onExit} />;

test('a new fontFamily reaches the open terminal and refits it, keeping the same terminal and its stream (#376)', () => {
  const onExit = vi.fn(); // one function across renders: only the font changes
  const { rerender } = render(tab('ui-monospace, monospace', onExit));
  expect(FakeTerminal.all.map((x) => x.options.fontFamily)).toEqual(['ui-monospace, monospace']);
  const fit = vi.spyOn(FakeFitAddon.prototype, 'fit');
  rerender(tab('"MesloLGS NF", ui-monospace, monospace', onExit));
  expect(FakeTerminal.all.map((x) => x.options.fontFamily)).toEqual(['"MesloLGS NF", ui-monospace, monospace']);
  expect(fit).toHaveBeenCalledTimes(1);
  expect([FakeTerminal.all[0].disposed, FakeWebSocket.all.length, FakeWebSocket.all[0].closed]).toEqual([false, 1, false]);
});

test('a collapsed terminal (0 wide or 0 tall) never fits, so its pty keeps its last real size; shown again it fits (#390)', () => {
  render(tab('ui-monospace, monospace', vi.fn()));
  const fit = vi.spyOn(FakeFitAddon.prototype, 'fit');
  resized(0, 600); // a tab behind another, or the panel closed while docked left
  resized(800, 0); // a group collapsed to no height
  expect(fit).not.toHaveBeenCalled();
  resized(800, 600);
  expect(fit).toHaveBeenCalledTimes(1);
});

test('a font saved while the terminal is collapsed is applied, and its refit waits for the terminal to show (#390)', () => {
  const onExit = vi.fn();
  const { rerender } = render(tab('ui-monospace, monospace', onExit));
  const fit = vi.spyOn(FakeFitAddon.prototype, 'fit');
  resized(0, 600);
  rerender(tab('"MesloLGS NF", ui-monospace, monospace', onExit));
  expect(FakeTerminal.all[0].options.fontFamily).toBe('"MesloLGS NF", ui-monospace, monospace');
  expect(fit).not.toHaveBeenCalled();
  resized(800, 600);
  expect(fit).toHaveBeenCalledTimes(1);
});

test('with file links a clicked path opens in its run\'s activity, a workspace\'s local one or a task\'s, at its line and column; nothing is posted (#400, #717)', () => {
  const openFile = vi.fn<OpenFile>(() => true);
  render(
    <FileOpenerContext.Provider value={openFile}>
      <PtyTab tab={localRunTab('P1', 'my site')} activityId="local:my site" label="my site · shell" active fileLinks fontFamily="ui-monospace, monospace" onExit={vi.fn()} />
      <PtyTab tab={STAGE} activityId="a-I1" label="#1 Task 1 · etapa" active={false} fileLinks fontFamily="ui-monospace, monospace" onExit={vi.fn()} />
    </FileOpenerContext.Provider>,
  );
  for (const term of FakeTerminal.all) {
    term.lines = ['edited src/app.ts:12:3'];
    term.providers[0].provideLinks(1, (links) => links?.[0].activate());
  }
  expect(openFile.mock.calls).toEqual([['local/my site', 'src/app.ts', { line: 12, col: 3 }], ['I1', 'src/app.ts', { line: 12, col: 3 }]]);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/open-file'))).toEqual([]);
});

const sentSizes = (socket: FakeWebSocket): unknown[] => socket.sent.map((text) => JSON.parse(text));

test('a hidden tab turned active and focused fits and posts its grid at once, past the resize debounce (#808)', () => {
  size = { width: 0, height: 0 }; // behind another tab
  const onExit = vi.fn(); // one function across renders: only `active` changes
  const view = (active: boolean) => <PtyTab tab={STAGE} label="#1 Task 1 · etapa" active={active} fileLinks={false} fontFamily="ui-monospace, monospace" onExit={onExit} />;
  const { rerender } = render(view(false));
  const [socket] = FakeWebSocket.all;
  socket.open();
  expect(socket.sent).toEqual([]);
  size = { width: 800, height: 600 };
  rerender(view(true));
  expect(sentSizes(socket)).toEqual([{ type: 'resize', cols: 120, rows: 30, redraw: true }]); // #389: a tab mounted hidden redraws when first shown
});

test('the first fit that finds the tab shown posts its grid even when the fit left xterm at 80x24; a later fit that changes nothing posts nothing (#808)', () => {
  render(<PtyTab tab={STAGE} label="#1 Task 1 · etapa" active focused={false} fileLinks={false} fontFamily="ui-monospace, monospace" onExit={vi.fn()} />);
  const [socket] = FakeWebSocket.all;
  socket.open();
  FakeTerminal.all[0].cols = 80; // xterm's own first grid; the fake fit changes nothing, as a pane that fits 80x24 would
  FakeTerminal.all[0].rows = 24;
  resized(800, 600);
  resized(800, 600);
  expect(sentSizes(socket)).toEqual([{ type: 'resize', cols: 80, rows: 24, redraw: true }]);
});

test('the find binding opens the bar over its own tab only, on an xterm with the proposed API on; a tab turned away and back keeps its bar and its query (#12)', async () => {
  const user = userEvent.setup();
  const onExit = vi.fn(); // one function across renders: only `active` changes
  const view = (isFirstShown: boolean) => (
    <>
      <PtyTab tab={STAGE} label="primeira" active={isFirstShown} fileLinks={false} fontFamily="ui-monospace, monospace" onExit={onExit} />
      <PtyTab tab={{ ...STAGE, ptyId: 'W2' }} label="segunda" active={!isFirstShown} fileLinks={false} fontFamily="ui-monospace, monospace" onExit={onExit} />
    </>
  );
  const { rerender } = render(view(true));
  expect(FakeTerminal.all.map((term) => term.options.allowProposedApi)).toEqual([true, true]);
  expect(FakeSearchAddon.all.map((search) => search.options)).toEqual([{ highlightLimit: 1000 }, { highlightLimit: 1000 }]);
  expect(screen.queryByRole('textbox', { name: 'buscar' })).not.toBeInTheDocument();
  let isPassed = true;
  act(() => { isPassed = FakeTerminal.all[0].press({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }); }); // jsdom runs as off macOS
  expect(isPassed).toBe(false);
  const first = within(screen.getByRole('region', { name: 'primeira' }));
  await user.type(first.getByRole('textbox', { name: 'buscar' }), 'erro');
  expect(screen.getAllByRole('textbox', { name: 'buscar' })).toHaveLength(1);
  expect(FakeSearchAddon.all[0].calls.at(-1)).toEqual(['next', 'erro', true]);
  expect(FakeSearchAddon.all[1].calls).toEqual([]);
  rerender(view(false));
  rerender(view(true));
  expect(first.getByRole('textbox', { name: 'buscar' })).toHaveValue('erro');
});
