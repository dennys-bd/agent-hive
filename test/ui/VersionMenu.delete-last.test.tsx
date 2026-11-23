import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, type ItemsServer, OWN, OWN_TEXT, readOf, stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { open, selector } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test("a user-created item's only version offers excluir <item>, says so in the footer, names the callers in its dialog, and confirming opens the skills list without it (#983)", async () => {
  const user = userEvent.setup();
  const server: ItemsServer = { catalogue: [...CATALOGUE, OWN], reads: { 'hive:release-check@mine': readOf('hive:release-check', 'mine', { 'SKILL.md': OWN_TEXT }) } };
  server.revert = (id) => {
    server.catalogue = server.catalogue.filter((i) => i.id !== id);
    return new Response(null, { status: 204 });
  };
  const mock = stubItems(server);
  render(<PluginsWindow />);
  await open('release-check');
  await user.click(selector('mine'));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['nova versão a partir de mine…', 'usar em…', 'renomear', 'excluir release-check…']);
  expect(menu.lastElementChild).toHaveTextContent('mine é a única versão: excluí-la exclui a skill.');
  await user.click(within(menu).getByRole('menuitem', { name: 'excluir release-check…' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Excluir release-check' });
  expect(dialog).toHaveTextContent('mine é a última versão, então a skill sai junto, de todos os workspaces. new-spec ainda chama /release-check e o revisor vai acusar isso. não dá para desfazer.');
  await user.click(within(dialog).getByRole('button', { name: 'excluir' }));
  const list = await screen.findByRole('region', { name: 'skills' });
  await waitFor(() => expect(within(list).queryByRole('button', { name: /^release-check/ })).not.toBeInTheDocument());
  expect(mock.mock.calls.some(([path, init]) => path === '/api/items/hive%3Arelease-check/versions/mine' && init?.method === 'DELETE')).toBe(true);
  expect(mock.mock.calls.some(([path]) => path === '/api/items/hive%3Arelease-check')).toBe(false);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
