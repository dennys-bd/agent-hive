import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { open, rowsOf, selector, serverOf } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('the selector names the open version between the name and the chip; its menu lists each version with its state, workspaces and sub-line, then the original last (#320, decisions 3–7)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf());
  render(<PluginsWindow />);
  await open('new-build');
  expect([selector('mine').previousElementSibling?.textContent, selector('mine').nextElementSibling?.textContent]).toEqual(['new-build', 'customizada']);
  expect(selector('mine')).not.toHaveClass('font-mono');
  await user.click(selector('mine'));
  const menu = await screen.findByRole('menu');
  // #492: the header names the item, the note under the actions says what a version is per workspace
  expect(menu.firstElementChild).toHaveTextContent('versões de new-build');
  expect(menu.lastElementChild).toHaveTextContent('cada workspace usa uma versão. editar aqui muda só a versão aberta.');
  expect(rowsOf(menu).map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([
    ['minecustomizadaagent-hiveeditada 14:31 · da original 0.15', 'true'],
    ['tdd-firstcustomizadahive-siteeditada 09:00 · a partir de mine', 'false'],
    ['original da hive 0.15sempre disponível · não editável', 'false'],
  ]);
  expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['nova versão a partir de mine…', 'usar em…', 'renomear']);
});
