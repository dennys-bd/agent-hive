import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { json, stubItems, type ItemsServer } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { MINE, open, rowsOf, selector, serverOf, TDD, withBuild } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('use in hive-site with mine open assigns mine there; after the catalogue read the menu shows hive-site under mine (#320, decision 12)', async () => {
  const user = userEvent.setup();
  const assigns: unknown[] = [];
  const server: ItemsServer = serverOf({ assign: (_id, body) => {
    assigns.push(body);
    server.catalogue = withBuild([{ ...MINE, workspaces: ['agent-hive', 'hive-site'] }, { ...TDD, workspaces: [] }]);
    return json(server.catalogue[1]);
  } });
  const mock = stubItems(server);
  const catalogueReads = (): number => mock.mock.calls.filter(([path]) => path === '/api/items').length;
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(selector('mine'));
  (await screen.findByRole('menuitem', { name: 'usar em…' })).focus();
  await user.keyboard('{ArrowRight}');
  const sub = await screen.findByRole('menu', { name: 'usar em…' });
  expect(rowsOf(sub).map((i) => [i.textContent, i.getAttribute('aria-checked'), i.getAttribute('aria-disabled')])).toEqual([
    ['agent-hivemine', 'true', 'true'],
    ['hive-sitetdd-first', 'false', null],
  ]);
  const before = catalogueReads();
  await user.click(within(sub).getByRole('menuitemcheckbox', { name: /^hive-site/ }));
  await waitFor(() => expect(catalogueReads()).toBe(before + 1));
  expect(assigns).toEqual([{ workspace: 'hive-site', version: 'mine' }]);
  await user.click(selector('mine'));
  expect(rowsOf(await screen.findByRole('menu')).slice(0, 2).map((row) => row.textContent)).toEqual([
    'minecustomizadaagent-hivehive-siteeditada 14:31 · da original 0.15',
    'tdd-firstcustomizadaeditada 09:00 · a partir de mine',
  ]);
});
