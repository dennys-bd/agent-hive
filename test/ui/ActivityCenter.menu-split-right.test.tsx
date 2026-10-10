import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Center, openShell, resetCenterTest, saved, SHELL, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// Its own file (#458): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(resetCenterTest);
afterEach(() => vi.unstubAllGlobals());

test('a tab\'s menu with one group holds the two splits and Fechar; Dividir à direita puts the tab in a new group on the right (#458)', async () => {
  render(<Center runs={[STAGE, SHELL]} request={openShell} />);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Terminal' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Dividir à direita', 'Dividir abaixo', 'Fechar']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Dividir à direita' }));
  expect(strips()).toEqual([['Claude'], ['Terminal']]);
  expect(saved().I1.root).toMatchObject({ kind: 'split', axis: 'row', sizes: [50, 50] });
});
