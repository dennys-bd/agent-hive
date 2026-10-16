import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ShortcutMapDialog } from '@/components/ShortcutMapDialog';
import { setLanguage, t } from '@/i18n';
import { setShortcuts } from '@/lib/shortcut-bindings';

// jsdom runs as off macOS: CmdOrCtrl reads as Ctrl
beforeEach(() => setLanguage('pt'));
afterEach(() => setShortcuts({}));

const rowOf = (scope: HTMLElement, name: string): HTMLElement | null => within(scope).getByText(name).closest('div');

test('one section per scope under its title; each row its name and keys, a saved change applied and a shortcut turned off left out (#639)', () => {
  setShortcuts({ toggleConsole: 'CmdOrCtrl+Shift+Y', clear: null });
  render(<ShortcutMapDialog open onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'atalhos' });
  expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['global', 'atividades', 'árvore de arquivos', 'fluxo', 'plugins', 'diálogos e feedback', 'configurações']);
  const global = within(dialog).getByRole('region', { name: 'global' });
  expect(rowOf(global, t('shortcuts.toggleConsole'))).toHaveTextContent('Ctrl+Shift+Y');
  expect(rowOf(global, t('shortcuts.shortcutMap'))).toHaveTextContent('Ctrl+/');
  expect(rowOf(global, t('shortcuts.fixed.signal'))).toHaveTextContent('Ctrl+Shift+1–3');
  for (const absent of [t('shortcuts.clear'), t('shortcuts.nextTab'), t('shortcuts.fixed.goToTab')]) expect(within(dialog).queryByText(absent)).not.toBeInTheDocument();
});

test('the footer link calls onEditShortcuts; without it, or closed, there is no link (#639)', async () => {
  const user = userEvent.setup();
  const onEditShortcuts = vi.fn();
  const { rerender } = render(<ShortcutMapDialog open onClose={vi.fn()} onEditShortcuts={onEditShortcuts} />);
  await user.click(screen.getByRole('button', { name: 'editar em configurações › atalhos' }));
  expect(onEditShortcuts).toHaveBeenCalledOnce();
  rerender(<ShortcutMapDialog open onClose={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'editar em configurações › atalhos' })).not.toBeInTheDocument();
  rerender(<ShortcutMapDialog open={false} onClose={vi.fn()} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('Escape asks to close (#639)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<ShortcutMapDialog open onClose={onClose} />);
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
});
