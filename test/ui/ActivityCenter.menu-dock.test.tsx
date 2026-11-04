import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Center, resetCenterTest, seed, SESSION, STAGE } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// Its own file: Radix's ContextMenu opens once per file under jsdom
beforeEach(resetCenterTest);
afterEach(() => vi.unstubAllGlobals());

test('with onDock the tab menu offers Voltar para a janela principal above Fechar, which hands the tab\'s ref to onDock (#553)', async () => {
  seed({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W2' }], active: 1 }, focused: 'g1' });
  const onDock = vi.fn();
  render(<Center runs={[STAGE, SESSION]} onDock={onDock} />);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Claude · abcdef12' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent))
    .toEqual(['Dividir à direita', 'Dividir abaixo', 'Voltar para a janela principal', 'Fechar']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Voltar para a janela principal' }));
  expect(onDock).toHaveBeenCalledWith({ kind: 'run', ptyId: 'W2' });
});
