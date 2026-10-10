import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Center, resetCenterTest, seed, SESSION, SHELL, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// Its own file (#458): Radix's ContextMenu opens once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(resetCenterTest);
afterEach(() => vi.unstubAllGlobals());

test('with two groups the menu offers Mover para o grupo, named by the other group\'s shown tab, which moves the tab there, shown (#458)', async () => {
  seed({
    root: {
      kind: 'split', axis: 'row', sizes: [50, 50], children: [
        { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W3' }], active: 1 },
        { kind: 'group', id: 'g2', tabs: [{ kind: 'run', ptyId: 'W2' }], active: 0 },
      ],
    },
    focused: 'g1',
  });
  render(<Center runs={[STAGE, SESSION, SHELL]} />);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Terminal' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent))
    .toEqual(['Dividir à direita', 'Dividir abaixo', 'Mover para o grupo · Claude · abcdef12', 'Fechar']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para o grupo · Claude · abcdef12' }));
  expect(strips()).toEqual([['Claude'], ['Claude · abcdef12', 'Terminal']]);
  expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
});
