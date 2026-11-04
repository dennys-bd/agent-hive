import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CenterLayout, CenterTabRef } from '@/lib/center-layout';
import * as models from '@/lib/editor-models';
import type { MovedTab } from '../../src/tab-carry';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, seed, STAGE, strips } from './center-harness';
import { FakeEditor, FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's ContextMenu opens once per file under jsdom. The stage's run and src/a.ts, a.ts shown
const FILE: CenterTabRef = { kind: 'file', path: 'src/a.ts' };
const LAYOUT: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, FILE], active: 1 }, focused: 'g1' };

beforeEach(() => {
  resetCenterTest();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ path: 'src/a.ts', text: 'one\n', version: 'v1' })));
  seed(LAYOUT);
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

test('Mover para uma janela, above Fechar, on a dirty file tab sends the activity\'s key, the ref and a carry holding its text; the tab leaves the center once main took it (#554)', async () => {
  const moveToWindow = vi.fn(async (_tab: MovedTab) => undefined);
  vi.stubGlobal('hive', { moveToWindow, onCloseKey: () => () => undefined });
  render(<Center runs={[STAGE]} isMain />);
  await waitFor(() => expect(FakeEditor.all).toHaveLength(1));
  act(() => FakeModel.all[0].type('mine'));
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'a.ts' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent))
    .toEqual(['Dividir à direita', 'Dividir abaixo', 'Mover para uma janela', 'Fechar']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para uma janela' }));
  await waitFor(() => expect(strips()).toEqual([['Claude']]));
  expect(moveToWindow).toHaveBeenCalledWith({ activity: 'I1', ref: FILE, carry: expect.objectContaining({ base: 'v1', text: expect.stringContaining('mine') }) });
  expect(models.isDirty('a-I1', 'src/a.ts')).toBe(false);
});
