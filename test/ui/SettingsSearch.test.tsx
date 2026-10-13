import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { setLanguage, t } from '@/i18n';
import { settingEntry } from '@/lib/settings-search';

const BASE = settingEntry('settings.baseBranch', 'execution', 'settings.group.branches');
const BRANCH = settingEntry('settings.branch', 'execution', 'settings.group.branches');
const THEME = settingEntry('settings.theme', 'app');
const ENTRIES = [BASE, BRANCH, THEME];
const field = () => screen.getByRole('combobox', { name: t('settings.search') });
const options = () => within(screen.getByRole('listbox', { name: t('settings.search') })).getAllByRole('option');

beforeEach(() => setLanguage('pt'));

test('a combobox with its key hint; the list opens on the first character, under it, and the hint hides with text (#689)', async () => {
  const user = userEvent.setup();
  render(<SettingsSearch entries={ENTRIES} onPick={vi.fn()} />);
  expect(field()).toHaveAttribute('aria-expanded', 'false');
  expect(field()).toHaveAttribute('aria-autocomplete', 'list');
  expect(screen.getByText('Ctrl+F')).toBeInTheDocument();
  await user.type(field(), 'b');
  expect(field()).toHaveAttribute('aria-expanded', 'true');
  expect(field()).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  expect(screen.queryByText('Ctrl+F')).not.toBeInTheDocument();
  expect(screen.getByText(`${t('settings.search.navigate')} · ${t('settings.search.open')} · ${t('settings.search.close')}`)).toBeInTheDocument();
});

test('↓ and ↑ move the active row and stop at the ends; ↵ picks it and clears the field (#689)', async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<SettingsSearch entries={ENTRIES} onPick={onPick} />);
  await user.type(field(), 'branch');
  expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  await user.keyboard('{ArrowUp}');
  expect(options()[0]).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
  expect(options()[1]).toHaveAttribute('aria-selected', 'true');
  expect(field()).toHaveAttribute('aria-activedescendant', options()[1].id);
  await user.keyboard('{Enter}');
  expect(onPick).toHaveBeenCalledWith(BRANCH);
  expect(field()).toHaveValue('');
});

test('a row is picked on mousedown, before the field blurs; hovering makes it active (#689)', async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<SettingsSearch entries={ENTRIES} onPick={onPick} />);
  await user.type(field(), 'branch');
  await user.hover(options()[1]);
  expect(options()[1]).toHaveAttribute('aria-selected', 'true');
  await user.click(options()[1]);
  expect(onPick).toHaveBeenCalledWith(BRANCH);
});

test('the first Esc clears the field, the second leaves it; a click outside closes the list (#689)', async () => {
  const user = userEvent.setup();
  render(<><SettingsSearch entries={ENTRIES} onPick={vi.fn()} /><button type="button">fora</button></>);
  await user.type(field(), 'te');
  await user.keyboard('{Escape}');
  expect(field()).toHaveValue('');
  expect(field()).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(field()).not.toHaveFocus();
  await user.type(field(), 'te');
  await user.click(screen.getByRole('button', { name: 'fora' }));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('in Portuguese the English label also finds a setting, with nothing highlighted; the shown text highlights its run; no match says so (#689)', async () => {
  const user = userEvent.setup();
  render(<SettingsSearch entries={ENTRIES} onPick={vi.fn()} />);
  await user.type(field(), 'base branch');
  expect(options()[0]).toHaveTextContent('branch base');
  expect(within(options()[0]).queryByText(/./, { selector: 'strong' })).not.toBeInTheDocument();
  await user.clear(field());
  await user.type(field(), 'base');
  expect(within(options()[0]).getByText('base', { selector: 'strong' })).toBeInTheDocument();
  await user.clear(field());
  await user.type(field(), 'zzz');
  expect(screen.getByText(t('settings.search.none'))).toBeInTheDocument();
});
