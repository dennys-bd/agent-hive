import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { BUILD_TEXT, json, stubItems, type ItemsServer } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { fileTab, MINE, open, selector, serverOf, TDD, view, withBuild } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('rename renames the open version: the selector takes the new name and the unsaved edit comes with it (#320, decision 13)', async () => {
  const user = userEvent.setup();
  const renames: [string, string][] = [];
  const server: ItemsServer = serverOf({ rename: (_id, version, body) => {
    renames.push([version, body.name]);
    server.catalogue = withBuild([{ ...MINE, name: body.name }, TDD]);
    return json(server.catalogue[1]);
  } });
  stubItems(server);
  render(<PluginsWindow />);
  await open('new-build');
  act(() => view().model.type(`${BUILD_TEXT}unsaved\n`));
  await user.click(selector('mine'));
  await user.click(await screen.findByRole('menuitem', { name: 'renomear' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Renomear mine' });
  const field = within(dialog).getByRole('textbox', { name: 'nome da versão' });
  expect(field).toHaveValue('mine');
  await user.clear(field);
  await user.type(field, 'daily');
  await user.click(within(dialog).getByRole('button', { name: 'renomear' }));
  await waitFor(() => expect(selector('daily')).toBeInTheDocument());
  expect(renames).toEqual([['mine', 'daily']]);
  await waitFor(() => expect(view().model.getValue()).toBe(`${BUILD_TEXT}unsaved\n`));
  expect(fileTab('SKILL.md.liquid')).toHaveAttribute('data-dirty', 'true');
});
