import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CenterLayout } from '@/lib/center-layout';
import * as store from '@/lib/diagnostics-store';
import { problemsOf } from './problem-fake';
import * as models from '@/lib/editor-models';
import { jsonResponse } from '../fakes';
import { Center, resetCenterTest, seed, STAGE, strips } from './center-harness';
import { FakeEditor, FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// The stage's run, then two file tabs, b.ts shown (#717)
const FILES: CenterLayout = {
  root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'file', path: 'src/a.ts' }, { kind: 'file', path: 'src/b.ts' }], active: 2 },
  focused: 'g1',
};
// Each file reads as its own path, so a test tells the models apart
const fileFetch = vi.fn(async (url: string) => {
  const path = new URL(url, 'http://hive').searchParams.get('path') ?? '';
  return jsonResponse({ path, text: path, version: 'v1' });
});
const modelOf = (path: string): FakeModel => FakeModel.all.find((model) => model.getValue() === path) as FakeModel;

beforeEach(() => {
  resetCenterTest();
  fileFetch.mockClear();
  vi.stubGlobal('fetch', fileFetch);
  seed(FILES);
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

test('a stored file tab shows its file\'s name with its path as the tooltip, no pane header since the editor bar names the path (#850), the editor pane, and a dot while it holds unsaved edits (#717)', async () => {
  render(<Center runs={[STAGE]} />);
  expect(strips()).toEqual([['Claude', 'a.ts', 'b.ts']]);
  const tab = screen.getByRole('tab', { name: 'b.ts' });
  expect(tab).toHaveAttribute('title', 'src/b.ts');
  expect(document.querySelector('[data-pane-header]')).toBeNull();
  expect(screen.getByRole('region', { name: '#1 Task 1 · b.ts' })).toBeInTheDocument();
  await waitFor(() => expect(FakeEditor.all).toHaveLength(2));
  expect(tab.querySelector('[data-dirty]')).toBeNull();
  act(() => modelOf('src/b.ts').type('mine'));
  expect(tab.querySelector('[data-dirty]')).not.toBeNull();
});

test('closing a clean file tab closes it at once and drops its model; a dirty one asks: cancelar keeps the tab and its edits, descartar closes it and drops them (#717)', async () => {
  const user = userEvent.setup();
  render(<Center runs={[STAGE]} />);
  await waitFor(() => expect(FakeEditor.all).toHaveLength(2));
  const [a, b] = [modelOf('src/a.ts'), modelOf('src/b.ts')];
  await user.click(screen.getByRole('button', { name: 'Fechar a.ts' }));
  expect(strips()).toEqual([['Claude', 'b.ts']]);
  expect([a.disposed, screen.queryByRole('alertdialog')]).toEqual([true, null]);
  act(() => b.type('mine'));
  await user.click(screen.getByRole('button', { name: 'Fechar b.ts' }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('descartar alterações não salvas?');
  await user.click(within(screen.getByRole('alertdialog')).getByText('cancelar'));
  expect([strips(), b.disposed, models.isDirty('a-I1', 'src/b.ts')]).toEqual([[['Claude', 'b.ts']], false, true]);
  await user.click(screen.getByRole('button', { name: 'Fechar b.ts' }));
  await user.click(screen.getByRole('button', { name: 'descartar' }));
  expect([strips(), b.disposed, models.anyDirty()]).toEqual([[['Claude']], true, false]);
});

test('⌘W asks the same over a dirty file tab, and descartar closes it (#585, #717)', async () => {
  let closeKey: (() => void) | undefined;
  vi.stubGlobal('hive', { onCloseKey: (callback: () => void) => { closeKey = callback; return () => {}; } });
  const user = userEvent.setup();
  render(<Center runs={[STAGE]} />);
  await waitFor(() => expect(FakeEditor.all).toHaveLength(2));
  act(() => modelOf('src/b.ts').type('mine'));
  act(() => closeKey?.());
  expect(screen.getByRole('alertdialog')).toHaveTextContent('descartar alterações não salvas?');
  await user.click(screen.getByRole('button', { name: 'descartar' }));
  expect(strips()).toEqual([['Claude', 'a.ts']]);
});

test('a file tab\'s name turns destructive with an error, waiting with warnings only; infos and a server not ready leave it; the dirty dot stays (#780)', async () => {
  render(<Center runs={[STAGE]} />);
  await waitFor(() => expect(FakeEditor.all).toHaveLength(2));
  const name = (): HTMLElement => within(screen.getByRole('tab', { name: 'b.ts' })).getByText('b.ts');
  act(() => { store.setClient('k', 'a-I1', 'typescript-language-server', { phase: 'ready' }); store.setDiagnostics('k', 'src/b.ts', problemsOf('src/b.ts', { infos: 3 })); });
  expect(name().className).not.toMatch(/text-(destructive|waiting)/);
  act(() => store.setDiagnostics('k', 'src/b.ts', problemsOf('src/b.ts', { warnings: 2 })));
  expect(name()).toHaveClass('text-waiting');
  act(() => store.setDiagnostics('k', 'src/b.ts', problemsOf('src/b.ts', { errors: 1, warnings: 2 })));
  expect(name()).toHaveClass('text-destructive');
  act(() => modelOf('src/b.ts').type('mine'));
  expect(screen.getByRole('tab', { name: 'b.ts' }).querySelector('[data-dirty]')).not.toBeNull();
  act(() => store.setClient('k', 'a-I1', 'typescript-language-server', { phase: 'starting' }));
  expect(name().className).not.toMatch(/text-(destructive|waiting)/);
});

test('a rename the tree answered moves an open file tab to the new path with its buffer, dirty or not (#818)', async () => {
  render(<Center runs={[STAGE]} />);
  await waitFor(() => expect(FakeEditor.all).toHaveLength(2));
  const b = modelOf('src/b.ts');
  act(() => b.type('mine'));
  act(() => models.renamed('a-I1', 'src', 'lib'));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'b.ts' })).toHaveAttribute('title', 'lib/b.ts'));
  expect(strips()).toEqual([['Claude', 'a.ts', 'b.ts']]);
  expect([b.disposed, models.isDirty('a-I1', 'lib/b.ts'), models.textOf('a-I1', 'lib/b.ts')]).toEqual([false, true, 'mine']);
});
