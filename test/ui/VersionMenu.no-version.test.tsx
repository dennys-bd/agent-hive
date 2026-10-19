import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { open, rowsOf, selector, serverOf, view } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('an item with no version opens its original editable; the menu holds the original alone and offers no rename (#320, decision 8)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-spec');
  expect(view().readOnly).toBe(false);
  expect(screen.getByRole('button', { name: 'novo arquivo' })).toBeInTheDocument();
  await user.click(selector('original da hive'));
  const menu = await screen.findByRole('menu');
  expect(rowsOf(menu).map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([['original da hive', 'true']]);
  expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['nova versão a partir de original da hive…', 'usar em…']);
});
