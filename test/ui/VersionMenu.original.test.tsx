import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { head, nextEditor, open, selector, serverOf } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('choosing the original opens it read-only: no "+", no revert, and ⌘S writes nothing (#320, decision 8)', async () => {
  const user = userEvent.setup();
  const mock = stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect(screen.getByRole('button', { name: 'novo arquivo' })).toBeInTheDocument();
  expect(within(head()).getByRole('button', { name: 'voltar para a original da hive' })).toBeInTheDocument();
  const before = FakeEditor.all.length;
  await user.click(selector('mine'));
  await user.click(within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: /^original da hive/ }));
  const original = await nextEditor(before);
  await waitFor(() => expect(original.readOnly).toBe(true));
  expect(selector('original da hive 0.15')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'novo arquivo' })).not.toBeInTheDocument();
  expect(within(head()).queryByRole('button', { name: 'voltar para a original da hive' })).not.toBeInTheDocument();
  act(() => original.model.type('typed\n')); // the fake takes typing; Monaco's readOnly refuses it, and the hook's save refuses it too
  act(() => original.onSave());
  expect(mock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});
