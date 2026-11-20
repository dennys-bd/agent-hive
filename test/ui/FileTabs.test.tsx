import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { FileTabs } from '@/components/plugins/FileTabs';
import { setLanguage } from '@/i18n';

const FILES = ['SKILL.md.liquid', 'slicing.md'];
beforeEach(() => setLanguage('pt'));

test('one tab per file, the open one selected, a dirty one marked; a click opens; the toggle sets the mode (#319, decisions 6, 14)', () => {
  const onOpen = vi.fn();
  const onMode = vi.fn();
  render(<FileTabs files={FILES} open="SKILL.md.liquid" isDirty={(path) => path === 'slicing.md'} onOpen={onOpen} mode="visual" onMode={onMode} />);
  expect(screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected'), tab.dataset.dirty])).toEqual([['SKILL.md.liquid', 'true', 'false'], ['slicing.md', 'false', 'true']]);
  fireEvent.click(screen.getByRole('tab', { name: 'slicing.md' }));
  expect(onOpen).toHaveBeenCalledWith('slicing.md');
  const modes = within(screen.getByRole('group', { name: 'modo' }));
  expect(modes.getByRole('button', { name: 'visual' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(modes.getByRole('button', { name: 'texto' }));
  expect(onMode).toHaveBeenCalledWith('text');
});

test('+ opens a name field: Enter creates and closes, a refusal shows its copy, Esc cancels; no + and no toggle when not given (#319, decision 13)', async () => {
  const user = userEvent.setup();
  const onAdd = vi.fn(async (path: string) => (path === 'SKILL.md.liquid' ? 'plugins.file.taken' as const : undefined));
  const { rerender } = render(<FileTabs files={FILES} open="SKILL.md.liquid" isDirty={() => false} onOpen={vi.fn()} onAdd={onAdd} />);
  await user.click(screen.getByRole('button', { name: 'novo arquivo' }));
  await user.type(screen.getByRole('textbox', { name: 'nome do novo arquivo' }), 'SKILL.md.liquid{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('esse arquivo já existe');
  await user.clear(screen.getByRole('textbox', { name: 'nome do novo arquivo' }));
  await user.type(screen.getByRole('textbox', { name: 'nome do novo arquivo' }), 'notes.md{Enter}');
  expect(onAdd).toHaveBeenLastCalledWith('notes.md');
  expect(screen.queryByRole('textbox', { name: 'nome do novo arquivo' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'novo arquivo' }));
  await user.type(screen.getByRole('textbox', { name: 'nome do novo arquivo' }), 'gone{Escape}');
  expect(onAdd).toHaveBeenCalledTimes(2);
  rerender(<FileTabs files={FILES} open="SKILL.md.liquid" isDirty={() => false} onOpen={vi.fn()} previewOf="hive-site" />);
  expect(screen.queryByRole('button', { name: 'novo arquivo' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'modo' })).not.toBeInTheDocument();
});

test('in the preview the tabs read the delivered names and the bar the preview line in place of the toggle (#319, decision 26, #492)', () => {
  render(<FileTabs files={FILES} open="SKILL.md.liquid" isDirty={() => false} onOpen={vi.fn()} previewOf="hive-site" />);
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['SKILL.md', 'slicing.md']);
  expect(screen.queryByRole('group', { name: 'modo' })).not.toBeInTheDocument();
  expect(screen.getByText('preview · hive-site · só leitura')).toBeInTheDocument();
});

test('a tab reads its basename with the full path as its title; the open one is filled (#492)', () => {
  render(<FileTabs files={['SKILL.md.liquid', 'scripts/run.sh']} open="scripts/run.sh" isDirty={() => false} onOpen={vi.fn()} mode="text" onMode={vi.fn()} />);
  const tab = screen.getByRole('tab', { name: 'run.sh' });
  expect(tab).toHaveAttribute('title', 'scripts/run.sh');
  expect(tab).toHaveClass('aria-selected:bg-card');
});
