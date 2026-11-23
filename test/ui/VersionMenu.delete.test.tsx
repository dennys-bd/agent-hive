import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { type ItemsServer, json, stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { open, selector, serverOf, TDD, withBuild } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test("a Hive item's open version offers excluir after renomear; its dialog says where the workspace goes and which version stays, and confirming deletes it and opens the original (#983)", async () => {
  const user = userEvent.setup();
  const server: ItemsServer = serverOf({ revert: (id) => {
    server.catalogue = withBuild([{ ...TDD, from: 'original' }]);
    return json(server.catalogue.find((i) => i.id === id));
  } });
  const mock = stubItems(server);
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(selector('mine'));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['nova versão a partir de mine…', 'usar em…', 'renomear', 'excluir mine…']);
  await user.click(within(menu).getByRole('menuitem', { name: 'excluir mine…' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Excluir mine' });
  expect(dialog).toHaveTextContent('agent-hive usa mine hoje e passa a usar a original da hive 0.15. tdd-first, criada a partir de mine, fica como está. não dá para desfazer.');
  await user.click(within(dialog).getByRole('button', { name: 'excluir' }));
  await waitFor(() => expect(selector('original da hive')).toBeInTheDocument());
  expect(mock.mock.calls.some(([path, init]) => path === '/api/items/hive%3Anew-build/versions/mine' && init?.method === 'DELETE')).toBe(true);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
