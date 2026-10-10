import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CloseTabContext, type CloseTabNoticeInput, type CloseTabSettings, showCloseTabNotice } from '@/components/close-tab-notice';
import { type SleepNoticeInput, showSleepNotice } from '@/components/sleep-notice';
import { RunOpenerContext } from '@/components/terminal-tabs';
import type { TabRequest } from '@/hooks/use-activity';
import { resetViewState } from '@/lib/view-state';
import { Center, openShell, resetCenterTest, SESSION, SHELL, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
// The notices' own behaviour is close-tab-notice.test.tsx's and sleep-notice.test.tsx's; here only whether the close asks for one, and with what
vi.mock('@/components/close-tab-notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/close-tab-notice')>()), showCloseTabNotice: vi.fn(),
}));
vi.mock('@/components/sleep-notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/sleep-notice')>()), showSleepNotice: vi.fn(),
}));

const KEEP: CloseTabSettings = { closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true };
const openSession: TabRequest = { tab: { kind: 'run', ptyId: 'W2' } };
const openRun = vi.fn();
const sent = (method: string): string[] => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === method).map(([url]) => String(url));
const stops = (): string[] => sent('POST').filter((url) => url.endsWith('/stop'));
const lastNotice = (): CloseTabNoticeInput | undefined => vi.mocked(showCloseTabNotice).mock.calls.at(-1)?.[0];
const lastSleep = (): SleepNoticeInput | undefined => vi.mocked(showSleepNotice).mock.calls.at(-1)?.[0];
const renderCenter = (settings: CloseTabSettings, request?: TabRequest, local?: string) =>
  render(
    <RunOpenerContext.Provider value={openRun}>
      <CloseTabContext.Provider value={settings}>
        <Center runs={local === undefined ? [STAGE, SESSION, SHELL] : [SESSION, SHELL]} request={request} local={local} />
      </CloseTabContext.Provider>
    </RunOpenerContext.Provider>,
  );
// A second render in the same test: the saved layout lost the closed tab, so start over from the first pick
const again = (): void => {
  resetViewState();
  vi.mocked(showCloseTabNotice).mockClear();
  vi.mocked(showSleepNotice).mockClear();
};

beforeEach(() => {
  resetCenterTest();
  resetViewState();
  vi.mocked(showCloseTabNotice).mockClear();
  vi.mocked(showSleepNotice).mockClear();
  openRun.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test('keep with the notice on: closing a free session\'s tab stops nothing and shows the keep notice; with the notice off, nothing shows (#614)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderCenter(KEEP, openSession);
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(stops()).toEqual([]);
  expect(lastNotice()).toMatchObject({ run: SESSION, where: '#1 Task 1' });
  unmount();
  again();
  renderCenter({ ...KEEP, closeSessionTabNotice: false }, openSession);
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(stops()).toEqual([]);
  expect(showCloseTabNotice).not.toHaveBeenCalled();
});

test('sleep: closing stops the run once, forgets its transcript and shows the sleep notice, never the close-tab one (#614, #672)', async () => {
  const user = userEvent.setup();
  renderCenter({ ...KEEP, closeSessionTab: 'sleep' }, openSession);
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(stops()).toEqual(['/ptys/W2/stop']);
  await waitFor(() => expect(sent('DELETE')).toEqual(['/ptys/W2/scrollback']));
  expect(lastSleep()).toMatchObject({ cause: 'manual', where: '#1 Task 1', sessions: [{ ptyId: 'W2' }] });
  expect(showCloseTabNotice).not.toHaveBeenCalled();
});

test('a stage run reads the stage settings, never the session ones (#614)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderCenter({ closeSessionTab: 'sleep', closeStageTab: 'keep', closeSessionTabNotice: false, closeStageTabNotice: true });
  await user.click(screen.getByRole('button', { name: 'Fechar Claude' }));
  expect(stops()).toEqual([]);
  expect(lastNotice()).toMatchObject({ run: STAGE, stage: 'dev' });
  unmount();
  again();
  renderCenter({ closeSessionTab: 'keep', closeStageTab: 'sleep', closeSessionTabNotice: true, closeStageTabNotice: false });
  await user.click(screen.getByRole('button', { name: 'Fechar Claude' }));
  expect(stops()).toEqual(['/ptys/W1/stop']);
  expect(showCloseTabNotice).not.toHaveBeenCalled();
});

test('a terminal\'s tab follows closeTerminalTab, a task\'s and a local one\'s alike: keep stops nothing and shows the keep notice, sleep stops it once and shows none (#696)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderCenter({ ...KEEP, closeTerminalTab: 'keep' }, openShell);
  await user.click(screen.getByRole('button', { name: 'Fechar Terminal' }));
  expect(stops()).toEqual([]);
  expect(lastNotice()).toMatchObject({ run: SHELL, where: '#1 Task 1' });
  unmount();
  again();
  renderCenter({ ...KEEP, closeTerminalTab: 'sleep' }, openShell, 'hive');
  await user.click(screen.getByRole('button', { name: 'Fechar Terminal' }));
  await waitFor(() => expect(stops()).toEqual(['/ptys/W3/stop']));
  expect(showCloseTabNotice).not.toHaveBeenCalled();
  expect(showSleepNotice).not.toHaveBeenCalled();
});

test('an agent the shim missed in the terminal asks first: nothing sleeps until dormir (#696)', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith('/agents') ? { agents: ['claude'] } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
  renderCenter(KEEP, openShell);
  await user.click(screen.getByRole('button', { name: 'Fechar Terminal' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('um agente que o Hive não capturou executa num terminal: a conversa dele se perde quando o terminal dorme.');
  expect(stops()).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'dormir' }));
  await waitFor(() => expect(stops()).toEqual(['/ptys/W3/stop']));
});

test('a local session\'s tab follows the session settings: sleep stops it, and the sleep notice names local (#590, #614, #672)', async () => {
  const user = userEvent.setup();
  renderCenter({ ...KEEP, closeSessionTab: 'sleep' }, openSession, 'hive');
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(stops()).toEqual(['/ptys/W2/stop']);
  await waitFor(() => expect(lastSleep()).toMatchObject({ cause: 'manual', where: 'local' }));
});

test('the keep notice\'s dormir sleeps the run with the sleep notice, and reabrir opens the run\'s tab again in its activity (#614, #672)', async () => {
  const user = userEvent.setup();
  renderCenter(KEEP, openSession);
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  const notice = lastNotice();
  notice?.onSleep();
  expect(stops()).toEqual(['/ptys/W2/stop']);
  await waitFor(() => expect(lastSleep()).toMatchObject({ cause: 'manual' }));
  notice?.onReopen?.();
  expect(openRun).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 'W2', kind: 'session', task: 'I1' }));
});

test('a middle-click on a tab closes it as its X does, its mousedown default prevented; a right-click does not close it (#612)', () => {
  renderCenter(KEEP, openSession);
  const auxClick = (button: number): boolean => fireEvent(tab(), new MouseEvent('auxclick', { button, bubbles: true, cancelable: true })); // fireEvent has no auxClick helper
  const tab = (): HTMLElement => screen.getByRole('tab', { name: 'Claude · abcdef12' });
  auxClick(2);
  expect(strips().flat()).toContain('Claude · abcdef12');
  expect(fireEvent.mouseDown(tab(), { button: 1 })).toBe(false); // no autoscroll, no primary-selection paste
  auxClick(1);
  expect(strips().flat()).not.toContain('Claude · abcdef12');
  expect(lastNotice()).toMatchObject({ run: SESSION });
});
