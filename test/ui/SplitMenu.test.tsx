import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LiveRun } from '../../src/task-runs';
import { RunOpenerContext } from '@/components/terminal-tabs';
import type { TabRequest } from '@/hooks/use-activity';
import type { CenterLayout } from '@/lib/center-layout';
import { readView } from '@/lib/view-state';
import { Center, resetCenterTest, saved, seed, SESSION, SHELL, SIDE_BY_SIDE, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

beforeEach(resetCenterTest);
afterEach(() => vi.unstubAllGlobals());

// MainDock's run opener in small (#457): an answered run becomes a request for its tab, which useCenterLayouts opens once the run is live
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
const same = (): HTMLElement => screen.getByRole('menuitem', { name: /^dividir com o mesmo tipo/ });

// Radix's DropdownMenu opens from the keyboard under jsdom, as the + test does (#292)
async function openSplit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  screen.getAllByRole('button', { name: 'dividir' })[0].focus();
  await user.keyboard('{Enter}');
  await screen.findAllByRole('menuitem');
}

test('dividir lists terminal, each agent and arquivo… em breve; terminal posts a terminal, and its answered run lands on this group\'s right, 56/44 (#536)', async () => {
  const user = userEvent.setup();
  answerOpen('W3');
  render(<Opened runs={[STAGE, SHELL]} />);
  await openSplit(user);
  expect(screen.getByText('novo pane ao lado com')).toBeInTheDocument();
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['terminal', 'claude', 'codex', 'arquivo…em breve', 'dividir com o mesmo tipoCtrl+Shift+\\']);
  expect(screen.getByRole('menuitem', { name: /^arquivo…/ })).toHaveAttribute('data-disabled');
  await user.click(screen.getByRole('menuitem', { name: 'terminal' }));
  posted('terminal');
  await waitFor(() => expect(strips()).toEqual([['Claude'], ['Terminal']]));
  expect(saved().I1.root).toMatchObject({ kind: 'split', axis: 'row', sizes: [56, 44] });
});

test('posição remembers the viewer\'s edge in the view state, à direita by default; embaixo lands the next split below (#536, #484)', async () => {
  const user = userEvent.setup();
  answerOpen('W2');
  render(<Opened runs={[STAGE, SESSION]} />);
  await openSplit(user);
  expect(screen.getByText('posição')).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: 'à direita' })).toBeChecked();
  await user.click(screen.getByRole('menuitemradio', { name: 'embaixo' }));
  expect(readView('splitEdge')).toBe('bottom');
  expect(screen.getByRole('menuitemradio', { name: 'embaixo' })).toBeChecked();
  await user.click(screen.getByRole('menuitem', { name: 'claude' }));
  posted('claude');
  await waitFor(() => expect(saved().I1.root).toMatchObject({ kind: 'split', axis: 'column', sizes: [56, 44] }));
  expect(strips()).toEqual([['Claude'], ['Claude · abcdef12']]);
});

test('dividir com o mesmo tipo repeats the shown run\'s kind, and is disabled while the group shows the console (#536)', async () => {
  const user = userEvent.setup();
  const withConsole = (active: number): CenterLayout => ({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W3' }, { kind: 'console' }], active }, focused: 'g1' });
  seed(withConsole(0));
  const { unmount } = render(<Opened runs={[STAGE, SHELL]} />);
  await openSplit(user);
  await user.click(same());
  posted('terminal');
  unmount();
  seed(withConsole(1));
  render(<Opened runs={[STAGE, SHELL]} />);
  await openSplit(user);
  expect(same()).toHaveAttribute('data-disabled');
});

test('Ctrl+Shift+\\ splits the focused group with its shown run\'s kind, the new pane on that group\'s edge (#536, #585)', async () => {
  answerOpen('W3');
  seed(SIDE_BY_SIDE); // g1 [W1] focused beside g2 [W2]
  render(<Opened runs={[STAGE, SESSION, SHELL]} />);
  fireEvent.keyDown(document.body, { key: '\\', code: 'Backslash', ctrlKey: true, shiftKey: true });
  posted('claude'); // W1 is the stage run: an agent's
  await waitFor(() => expect(strips()).toEqual([['Claude'], ['Terminal'], ['Claude · abcdef12']]));
  expect(saved().I1.root).toMatchObject({ kind: 'split', axis: 'row', sizes: [28, 22, 50] }); // g1's half, 56/44
});
