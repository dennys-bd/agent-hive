import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Center, resetCenterTest, seed, SESSION, STAGE } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// Its own file: Radix's ContextMenu opens once per file under jsdom
beforeEach(resetCenterTest);
afterEach(() => vi.unstubAllGlobals());

test('without window.hive the main window\'s tab menu has no Mover para uma janela (#554)', async () => {
  seed({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W2' }], active: 1 }, focused: 'g1' });
  render(<Center runs={[STAGE, SESSION]} isMain />);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Claude · abcdef12' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).not.toContain('Mover para uma janela');
});
