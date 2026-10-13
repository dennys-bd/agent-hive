import { act, render, screen } from '@testing-library/react';
import type { ILinkHandler } from '@xterm/xterm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PtyTab, TaskRefContext } from '@/components/PtyTab';
import { setTrustedDomains } from '@/lib/trusted-links';
import { toast } from 'sonner';
import type { RunTab } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { FakeTerminal, FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
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

const RANGE = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };

beforeEach(() => {
  resetPtyTest();
  setTrustedDomains(['github.com']);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the tab\'s xterm is created with the shared link handler: a trusted link opens at once, an untrusted one opens LinkConfirm (#404)', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<PtyTab tab={STAGE} label="#1 Task 1 · etapa" active fileLinks={false} fontFamily="ui-monospace, monospace" onExit={vi.fn()} />);
  const handler = FakeTerminal.all[0].options.linkHandler as ILinkHandler;
  expect(handler.allowNonHttpProtocols).toBe(false);
  act(() => handler.activate(new MouseEvent('click'), 'https://github.com/acme/r/pull/9', RANGE));
  expect(open).toHaveBeenCalledWith('https://github.com/acme/r/pull/9');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  act(() => handler.activate(new MouseEvent('click'), 'https://example.com/a', RANGE));
  expect(screen.getByRole('alertdialog', { name: 'Abrir link' })).toHaveTextContent('https://example.com/a');
  expect(open).toHaveBeenCalledTimes(1);
});

test('a task reference in the tab\'s output posts its activity\'s open-ref (#629): a task opens through the board\'s opener, an issue through the link handler (#588)', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const openTask = vi.fn();
  const refFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { ref } = JSON.parse(String(init?.body)) as { ref: string };
    const body = ref === '#7' ? { taskId: 'board:I7' } : { url: 'https://github.com/acme/r/issues/8' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', refFetch);
  render(
    <TaskRefContext.Provider value={{ prefixes: ['HIVE'], openTask }}>
      <PtyTab tab={STAGE} activityId="a-I1" label="#1 Task 1 · estágio" active fileLinks={false} fontFamily="ui-monospace, monospace" onExit={vi.fn()} />
    </TaskRefContext.Provider>,
  );
  const [term] = FakeTerminal.all;
  term.lines = ['see #7 and #8'];
  term.providers[0].provideLinks(1, (links) => { for (const link of links ?? []) link.activate(); });
  await vi.waitFor(() => expect(openTask).toHaveBeenCalledWith('board:I7'));
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://github.com/acme/r/issues/8')); // github.com is trusted here
  expect(refFetch.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([['/activities/a-I1/open-ref', '{"ref":"#7"}'], ['/activities/a-I1/open-ref', '{"ref":"#8"}']]);
});
