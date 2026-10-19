import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { json, stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { open, selector, serverOf } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx)
beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('a taken name shows its copy in the dialog, which stays open (#320, decision 11)', async () => {
  const user = userEvent.setup();
  stubItems(serverOf({ createVersion: () => json({ error: 'exists', code: 'exists' }, 409) }));
  render(<PluginsWindow />);
  await open('new-build');
  await user.click(selector('mine'));
  await user.click(await screen.findByRole('menuitem', { name: 'nova versão a partir de mine…' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Nova versão a partir de mine' });
  await user.type(within(dialog).getByRole('textbox', { name: 'nome da versão' }), 'tdd-first{Enter}');
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('esse nome já está em uso');
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
});
