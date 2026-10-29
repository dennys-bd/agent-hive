import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, seed, SESSION, STAGE, strips } from './center-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// Its own file (#458): Radix's ContextMenu opens once per file under jsdom. #533: an iframe moved in the DOM reloads, so the layer's panes keep
// one order whatever the tabs' order
beforeEach(() => {
  resetCenterTest();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/design-frame') ? jsonResponse({ url: '/design-frame/tok/x.hv.html' }) : jsonResponse({ version: 'v1' }))));
});
afterEach(() => vi.unstubAllGlobals());

const isLayerPane = (node: Node): boolean => node instanceof Element && node.matches('[data-design-layer]');

test('a design tab moved to another group keeps its frame, now in that group, and no pane is moved in the DOM when the tabs\' order changes (#533)', async () => {
  seed({
    root: {
      kind: 'split', axis: 'row', sizes: [50, 50], children: [
        { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'design', path: 'design/A.hv.html' }, { kind: 'design', path: 'design/B.hv.html' }], active: 1 },
        { kind: 'group', id: 'g2', tabs: [{ kind: 'run', ptyId: 'W2' }], active: 0 },
      ],
    },
    focused: 'g1',
  });
  render(<Center runs={[STAGE, SESSION]} />);
  const frame = await screen.findByTitle('A.hv.html');
  await screen.findByTitle('B.hv.html');
  const moves = new MutationObserver(() => undefined);
  moves.observe(document.body, { childList: true, subtree: true });
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'A.hv.html' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Mover para o grupo · Claude · abcdef12' }));
  const removed = moves.takeRecords().flatMap((record) => [...record.removedNodes]).filter(isLayerPane);
  moves.disconnect();
  expect(strips()).toEqual([['Claude', 'B.hv.html'], ['Claude · abcdef12', 'A.hv.html']]);
  expect(screen.getByTitle('A.hv.html')).toBe(frame);
  expect(frame.closest('[data-design-layer]')).toHaveAttribute('data-center-group', 'g2');
  expect(removed).toEqual([]);
});
