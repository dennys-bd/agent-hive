import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceColorPicker } from '@/components/settings/WorkspaceColorPicker';
import { setLanguage, t } from '@/i18n';
import { WORKSPACE_PRESET_COLORS as PRESETS } from '../../src/types';

beforeEach(() => setLanguage('en'));

// The picker as a card holds it: the value is the parent's, and each pick is applied
function Harness({ initial, onChange }: { initial: string; onChange(color: string): void }) {
  const [value, setValue] = useState(initial);
  return <WorkspaceColorPicker value={value} onChange={(color) => { onChange(color); setValue(color); }} />;
}
const trigger = (): HTMLElement => screen.getByRole('button', { name: t('settings.workspaces.colorLabel') });
const options = (): HTMLElement[] => within(screen.getByRole('listbox', { name: t('settings.workspaces.colors') })).getAllByRole('option');
const systemPicker = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[type="color"]')!;

test('opening shows the 7 presets and custom color with the current one selected; a preset click applies it and closes (#78)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness initial={PRESETS[2]} onChange={onChange} />);
  expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger());
  expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  expect(options()).toHaveLength(8);
  expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false', 'false', 'false', 'false', 'false']);
  expect(options()[0]).toHaveAccessibleName(t('settings.workspaces.presetColor', { n: 1 }));
  expect(options()[7]).toHaveAccessibleName(t('settings.workspaces.customColor'));
  expect(options()[7]).toHaveAttribute('title', t('settings.workspaces.customColor'));
  await user.click(options()[4]);
  expect(onChange).toHaveBeenCalledWith(PRESETS[4]);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('custom color opens the system picker; each input applies its colour and keeps the popover open, the custom circle then selected (#78)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness initial={PRESETS[0]} onChange={onChange} />);
  await user.click(trigger());
  expect(systemPicker()).toHaveValue('#000000'); // the current colour is a preset, not a hex
  await user.click(options()[7]);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.input(systemPicker(), { target: { value: '#a1b2c3' } });
  fireEvent.input(systemPicker(), { target: { value: '#a1b2c4' } });
  expect(onChange.mock.calls).toEqual([['#a1b2c3'], ['#a1b2c4']]);
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  expect(options()[7]).toHaveAttribute('aria-selected', 'true');
  expect(systemPicker()).toHaveValue('#a1b2c4');
});

test('Esc closes the popover and changes nothing (#78)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness initial={PRESETS[0]} onChange={onChange} />);
  await user.click(trigger());
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

test('the focus starts on the selected circle, the arrows move it around the 8 and wrap, and Enter picks (#78)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness initial={PRESETS[6]} onChange={onChange} />);
  await user.click(trigger());
  expect(options()[6]).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(options()[7]).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(options()[0]).toHaveFocus();
  await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
  expect(options()[5]).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(onChange).toHaveBeenCalledWith(PRESETS[5]);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
