import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FileOpenerContext } from '@/components/terminal-tabs';
import type { CenterLayout } from '@/lib/center-layout';
import * as models from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, seed, STAGE, strips } from './center-harness';
import { FakeDiffEditor, FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// The stage's run, a.ts's editor tab and its changes tab, the changes shown (#668)
const BOTH: CenterLayout = {
  root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'file', path: 'src/a.ts' }, { kind: 'changes', path: 'src/a.ts' }], active: 2 },
  focused: 'g1',
};
// The stage's run and a.ts's editor tab, a.ts shown
const FILE: CenterLayout = { root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'file', path: 'src/a.ts' }], active: 1 }, focused: 'g1' };
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

test('a stored changes tab reads Alterações and the file\'s name, its path as the tooltip, the header Alterações and the path, the diff over the file\'s own model; closing the editor tab keeps the buffer the changes tab shows, closing that one drops it (#668)', async () => {
  const user = userEvent.setup();
  seed(BOTH);
  render(<Center runs={[STAGE]} />);
  expect(strips()).toEqual([['Claude', 'a.ts', 'Alterações a.ts']]);
  expect(screen.getByRole('tab', { name: 'Alterações a.ts' })).toHaveAttribute('title', 'src/a.ts');
  expect(document.querySelector('[data-pane-header]')).toHaveTextContent('Alteraçõessrc/a.ts');
  expect(screen.getByRole('region', { name: '#1 Task 1 · Alterações a.ts' })).toBeInTheDocument();
  await waitFor(() => expect(FakeDiffEditor.all).toHaveLength(1));
  const buffer = FakeModel.all.find((model) => model.getValue() === 'two\n') as FakeModel;
  expect(FakeDiffEditor.all[0].original.getValue()).toBe('one\n');
  expect(FakeDiffEditor.all[0].getModifiedEditor().model).toBe(buffer);
  await user.click(screen.getByRole('button', { name: 'Fechar a.ts' }));
  expect([strips(), buffer.disposed]).toEqual([[['Claude', 'Alterações a.ts']], false]);
  await user.click(screen.getByRole('button', { name: 'Fechar Alterações a.ts' }));
  expect([strips(), buffer.disposed]).toEqual([[['Claude']], true]);
});

test('abrir alterações shows at the strip\'s right end only over a file tab, and opens that file\'s changes in its group (#668)', async () => {
  const user = userEvent.setup();
  const openFile = vi.fn(() => true);
  seed(FILE);
  render(<FileOpenerContext.Provider value={openFile}><Center runs={[STAGE]} /></FileOpenerContext.Provider>);
  const button = screen.getByRole('button', { name: 'abrir alterações' });
  expect(button).toHaveAttribute('title', 'abrir alterações');
  await user.click(button);
  expect(openFile).toHaveBeenCalledWith('I1', 'src/a.ts', undefined, { changes: true });
  await user.click(screen.getByRole('tab', { name: 'Claude' }));
  expect(screen.queryByRole('button', { name: 'abrir alterações' })).not.toBeInTheDocument();
});
