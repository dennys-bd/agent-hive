import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CenterLayout } from '@/lib/center-layout';
import * as models from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, seed, STAGE } from './center-harness';
import { resetMonacoFakes } from './monaco-fake';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's ContextMenu opens once per file under jsdom. The editor tab beside its changes tab: one buffer, two renderers (#554)
const SHARED: CenterLayout = {
  root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'file', path: 'src/a.ts' }, { kind: 'changes', path: 'src/a.ts' }], active: 1 },
  focused: 'g1',
};
const fetchMock = vi.fn(async (url: string) => (url.includes('/file-base')
  ? jsonResponse({ against: 'head', label: 'HEAD', oid: 'o1', text: 'one\n' })
  : jsonResponse({ path: 'src/a.ts', text: 'two\n', version: 'v1' })));

beforeEach(() => {
  resetCenterTest();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  models.closeExcept(new Set());
  fileBase.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

test('Mover para uma janela is disabled on a file tab while its changes tab is open: one buffer, two renderers (#554)', async () => {
  vi.stubGlobal('hive', { moveToWindow: vi.fn(async () => undefined), onCloseKey: () => () => undefined });
  seed(SHARED);
  render(<Center runs={[STAGE]} isMain />);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'a.ts' }));
  expect(await screen.findByRole('menuitem', { name: 'Mover para uma janela' })).toHaveAttribute('aria-disabled', 'true');
});
