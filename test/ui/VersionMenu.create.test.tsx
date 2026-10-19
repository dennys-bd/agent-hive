import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { FakeEditor, resetMonacoFakes } from './monaco-fake';
import { BUILD_TEXT, json, readOf, stubItems, type ItemsServer, withVersion } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { fileTab, nextEditor, open, selector, serverOf, sidebarItem } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test("new version from mine… creates it from mine and opens it; the sidebar counts it; an edit there is its own buffer (#320, decisions 10, 11)", async () => {
  const user = userEvent.setup();
  const creates: unknown[] = [];
  const server: ItemsServer = serverOf({ createVersion: (id, body) => {
    creates.push(body);
    server.catalogue = withVersion(server.catalogue, id, body.name);
    return json(readOf(id, body.name, { 'SKILL.md.liquid': BUILD_TEXT }));
  } });
  stubItems(server);
  render(<PluginsWindow />);
  await open('new-build');
  expect(sidebarItem('new-build')).toHaveTextContent('new-build2 ↗');
  await user.click(selector('mine'));
  await user.click(await screen.findByRole('menuitem', { name: 'nova versão a partir de mine…' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Nova versão a partir de mine' });
  await user.type(within(dialog).getByRole('textbox', { name: 'nome da versão' }), 'fast');
  const before = FakeEditor.all.length;
  await user.click(within(dialog).getByRole('button', { name: 'criar' }));
  await waitFor(() => expect(selector('fast')).toBeInTheDocument());
  expect(creates).toEqual([{ name: 'fast', from: 'mine' }]);
  expect(sidebarItem('new-build')).toHaveTextContent('new-build3 ↗');
  const fast = await nextEditor(before);
  act(() => fast.model.type(`${BUILD_TEXT}fast only\n`));
  expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'true');
});
