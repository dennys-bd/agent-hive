import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type ConsoleSelection, ConsolePanel } from '@/components/ConsolePanel';
import { setLanguage } from '@/i18n';
import type { ChannelEntry, ChannelStatus, ChannelView } from '../../src/console';
import { FakeTerminal, FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

const TEST: ChannelEntry = { id: 'command:hive:test', kind: 'command', label: 'hive · test', status: 'done' };
const DEV: ChannelEntry = { id: 'command:site:dev', kind: 'command', label: 'site · dev', status: 'done' };
const H12 = '── #12 · 14:03:07 ──\r\n';
const H15 = '── #15 · 14:05:59 ──\r\n';

// What the daemon answers per channel id; a missing one is a 404, as GET /console/:id answers an unknown channel
let views: Record<string, Omit<ChannelView, 'status'> & { status?: ChannelStatus }> = {};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const view = views[decodeURIComponent(String(input).replace('/console/', '').replace(/\?.*$/, ''))];
  return view ? reply({ status: 'done', ...view }) : reply({ error: 'canal desconhecido' }, 404);
});
const written = (): string[] | undefined => FakeTerminal.all.at(-1)?.written;
const sockets = (): string[] => FakeWebSocket.all.map((s) => s.path);

// The panel as MainDock drives it: the selection lives outside, and a select's pick sets it
function Panel({ onStale = vi.fn() }: { onStale?: () => void }) {
  const [selection, setSelection] = useState<ConsoleSelection>();
  return <ConsolePanel channels={[TEST, DEV]} selection={selection} stamp="" fontFamily="ui-monospace, monospace" onSelect={setSelection} onStale={onStale} drawer={{ onClose: vi.fn() }} />;
}

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  views = {};
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('a read-only xterm gets the channel\'s finished runs, then the shown live run\'s header, then that run over its pty socket; the socket\'s close reads the channel again (#353)', async () => {
  views = { [TEST.id]: { history: `${H12}ok\r\n`, live: [{ ptyId: 'W15', header: H15 }] } };
  render(<Panel />);
  await waitFor(() => expect(sockets()).toEqual(['/ptys/W15/pty']));
  expect(FakeTerminal.all.at(-1)?.options.disableStdin).toBe(true);
  const [socket] = FakeWebSocket.all;
  socket.open();
  socket.receive('running\r\n');
  expect(written()).toEqual([`${H12}ok\r\n`, H15, 'running\r\n']);
  views = { [TEST.id]: { history: `${H12}ok\r\n${H15}running\r\n`, live: [] } };
  socket.end(); // the pty exited: the run is now in the history
  await waitFor(() => expect(written()).toEqual([`${H12}ok\r\n${H15}running\r\n`]));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/console/command%3Ahive%3Atest', '/console/command%3Ahive%3Atest']);
});

// fireEvent.click (not userEvent.click) opens and picks in every Select test below: Radix Select's trigger only opens on pointerdown when
// the pointer type is "mouse", and under jsdom that path leaves the next render's trigger stuck closed once any earlier test has opened one
// in the same file; a plain click (no pointerType) takes the trigger's onClick fallback instead, which has none of that carry-over.
test('the run select shows only with two or more live runs, labelled #<task> · HH:MM, the newest shown; picking the other attaches it (#353)', async () => {
  views = { [TEST.id]: { history: '', live: [{ ptyId: 'W12', header: H12 }] } };
  const one = render(<Panel />);
  await waitFor(() => expect(sockets()).toEqual(['/ptys/W12/pty']));
  expect(screen.queryByRole('combobox', { name: 'execução' })).not.toBeInTheDocument();
  one.unmount();
  resetFakes();
  views = { [TEST.id]: { history: '', live: [{ ptyId: 'W12', header: H12 }, { ptyId: 'W15', header: H15 }] } };
  render(<Panel />);
  const runs = await screen.findByRole('combobox', { name: 'execução' });
  expect(runs).toHaveTextContent('#15 · 14:05');
  await waitFor(() => expect(sockets()).toEqual(['/ptys/W15/pty']));
  fireEvent.click(runs);
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['#12 · 14:03', '#15 · 14:05']);
  fireEvent.click(screen.getByRole('option', { name: '#12 · 14:03' }));
  await waitFor(() => expect(sockets().at(-1)).toBe('/ptys/W12/pty'));
  expect(written()).toEqual([H12]);
});

test('the channel select lists every channel, the first shown; a channel the daemon no longer knows calls onStale (#353)', async () => {
  const onStale = vi.fn();
  views = { [TEST.id]: { history: `${H12}ok\r\n`, live: [] } }; // DEV is unknown: a 404
  render(<Panel onStale={onStale} />);
  const channel = screen.getByRole('combobox', { name: 'canal' });
  expect(channel).toHaveTextContent('hive · test');
  await waitFor(() => expect(written()).toEqual([`${H12}ok\r\n`]));
  expect(sockets()).toEqual([]); // no live run: nothing attached
  fireEvent.click(channel);
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['hive · test', 'site · dev']);
  fireEvent.click(screen.getByRole('option', { name: 'site · dev' }));
  await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenLastCalledWith('/console/command%3Asite%3Adev');
});

// jsdom lays nothing out and has no observer of its own: the test sizes the host and fires the observers by hand, with no entries
const observers: ResizeObserverCallback[] = [];
class ResizeObserverSpy {
  constructor(callback: ResizeObserverCallback) {
    observers.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

test('the console\'s first fit that finds it shown posts the live run\'s grid, even one the fit left as it was; a collapsed fit posts nothing (#808)', async () => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', ResizeObserverSpy);
  let width = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 300);
  views = { [TEST.id]: { history: '', live: [{ ptyId: 'W15', header: H15 }] } };
  render(<Panel />);
  await waitFor(() => expect(sockets()).toEqual(['/ptys/W15/pty']));
  const [socket] = FakeWebSocket.all;
  socket.open();
  const fire = (): void => { for (const callback of observers) callback([], {} as ResizeObserver); };
  fire(); // the drawer still closed: 0 wide
  expect(socket.sent).toEqual([]);
  width = 600;
  fire();
  fire();
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([{ type: 'resize', cols: 120, rows: 30 }]);
});

const STAGE: ChannelEntry = { id: 'stage:checks', kind: 'stage', label: 'stage · checks', status: 'running' };
const tabPanel = (props: Partial<ComponentProps<typeof ConsolePanel>> = {}) => (
  <ConsolePanel channels={[TEST, STAGE]} selection={{ channel: STAGE.id }} stamp="" fontFamily="ui-monospace, monospace" onSelect={vi.fn()} onStale={vi.fn()} {...props} />
);

test('a locked tab is one 26px line, log, its channel label, and the status of its own execution; no channel select, run select or limpar, and it reads only its run (#755)', async () => {
  views = { [STAGE.id]: { history: '', status: 'failed', live: [{ ptyId: 'W12', header: H12 }, { ptyId: 'W15', header: H15 }] } };
  const { container, rerender } = render(tabPanel({ locked: true, run: 'R1' }));
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  const line = container.firstElementChild?.firstElementChild;
  expect(line).toHaveClass('h-[26px]', 'shrink-0', 'items-center', 'gap-2', 'px-3', 'text-muted-foreground', 'text-xs');
  expect(line).toHaveTextContent(/^logstage · checks/);
  expect(await screen.findByRole('status')).toHaveTextContent('falhou'); // the view's status, not the channel's running
  expect(fetchMock).toHaveBeenCalledWith('/console/stage%3Achecks?run=R1');
  await waitFor(() => expect(sockets()).toEqual(['/ptys/W15/pty']));
  rerender(tabPanel({ locked: true, run: 'R1', channels: [TEST] })); // its channel not listed yet (no command began), or gone after a restart
  expect(screen.queryByText('hive · test')).not.toBeInTheDocument();
  expect(screen.getByText('Nenhum comando executado ainda.')).toBeInTheDocument();
});

test('a plain console tab is one 26px line, console, the channel select and the channel status; no run select and no limpar, the newest live run shown (#755)', async () => {
  views = { [TEST.id]: { history: '', live: [{ ptyId: 'W12', header: H12 }, { ptyId: 'W15', header: H15 }] } };
  const { container } = render(tabPanel({ selection: { channel: TEST.id } }));
  expect(container.firstElementChild?.firstElementChild).toHaveClass('h-[26px]');
  expect(screen.getByRole('combobox', { name: 'canal' })).toHaveTextContent('hive · test');
  expect(screen.getByRole('status')).toHaveTextContent('concluído');
  await waitFor(() => expect(sockets()).toEqual(['/ptys/W15/pty']));
  expect(screen.queryByRole('combobox', { name: 'execução' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'limpar' })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/console/command%3Ahive%3Atest');
});

test('the drawer keeps its 34px bar, the run select, abrir como aba, limpar and esc (#537)', async () => {
  views = { [TEST.id]: { history: '', live: [{ ptyId: 'W12', header: H12 }, { ptyId: 'W15', header: H15 }] } };
  const { container } = render(tabPanel({ selection: { channel: TEST.id }, drawer: { onClose: vi.fn(), onOpenTab: vi.fn() } }));
  expect(container.firstElementChild?.firstElementChild).toHaveClass('h-[34px]');
  expect(await screen.findByRole('combobox', { name: 'execução' })).toBeInTheDocument();
  for (const name of ['abrir como aba', 'limpar', 'fechar o console']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
});
