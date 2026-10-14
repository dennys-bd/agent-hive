import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DesignTweaks } from '@/components/DesignTweaks';
import { setLanguage } from '@/i18n';
import { parseTweaks, settle, type TweakSchema } from '../../src/design-tweaks';
import type { DesignTweakValue } from '../../src/types';

const schemaOf = (raw: unknown): TweakSchema => {
  const parsed = parseTweaks(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.schema;
};
const SCHEMA = schemaOf({
  layout: { options: ['board', 'list'], default: 'board' },
  density: { options: ['compact', 'cozy', 'roomy', 'huge'], default: 'cozy', group: 'look' },
  auto: { type: 'boolean', default: true },
  title: { type: 'text', default: 'Flow' },
  gap: { type: 'number', default: 8, min: 0, max: 24, step: 4, group: 'look' },
});
const labels = (root: HTMLElement): (string | null)[] => Array.from(root.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label'));

// The pane's part: the values held and given back, every change recorded
function Harness({ onChange }: { onChange(name: string, value: DesignTweakValue): void }) {
  const [values, setValues] = useState(() => settle(SCHEMA, {}));
  return <DesignTweaks block={{ status: 'ok', schema: SCHEMA, viewports: [] }} values={values} onChange={(name, value) => { onChange(name, value); setValues((now) => ({ ...now, [name]: value })); }} />;
}

beforeEach(() => setLanguage('en'));

test('the row shows one control per tweak in declared order, then more…: a select per enum, a switch per boolean, an input per text and number (#241)', () => {
  render(<Harness onChange={vi.fn()} />);
  const row = screen.getByRole('toolbar', { name: 'tweaks' });
  expect(labels(row)).toEqual(['layout', 'density', 'auto', 'title', 'gap']);
  expect(within(row).getByRole('combobox', { name: 'layout' })).toHaveTextContent('board');
  expect(within(row).getByRole('combobox', { name: 'density' })).toHaveTextContent('cozy');
  expect(within(row).getByRole('switch', { name: 'auto' })).toBeChecked();
  expect(within(row).getByRole('textbox', { name: 'title' })).toHaveValue('Flow');
  expect(within(row).getByRole('spinbutton', { name: 'gap' })).toHaveValue(8);
  expect(within(row).getAllByRole('button').at(-1)).toHaveTextContent('more…');
});

test('a change gives its fitting value; text and number commit on Enter or blur, and a misfit number goes back to the last good one (#241)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const row = screen.getByRole('toolbar', { name: 'tweaks' });
  await user.click(within(row).getByRole('combobox', { name: 'layout' }));
  await user.click(screen.getByRole('option', { name: 'list' }));
  await user.click(within(row).getByRole('switch', { name: 'auto' }));
  const title = within(row).getByRole('textbox', { name: 'title' });
  await user.clear(title);
  await user.type(title, 'Board{Enter}');
  const gap = within(row).getByRole('spinbutton', { name: 'gap' });
  await user.clear(gap);
  await user.type(gap, '99{Enter}');
  expect(gap).toHaveValue(8);
  await user.clear(gap);
  await user.type(gap, '12');
  await user.tab();
  expect(onChange.mock.calls).toEqual([['layout', 'list'], ['auto', false], ['title', 'Board'], ['gap', 12]]);
});

test('more… opens the tweaks panel: the ungrouped first, then each group under its name, an enum of up to 3 options as a segmented control and more as a select; × closes it (#241)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  await user.click(screen.getByRole('button', { name: 'more…' }));
  const panel = screen.getByRole('dialog', { name: 'tweaks' });
  expect(within(panel).getAllByRole('heading').map((h) => h.textContent)).toEqual(['tweaks', 'look']);
  expect(labels(panel)).toEqual(['close', 'layout', 'auto', 'title', 'density', 'gap']);
  expect(within(panel).getByRole('radiogroup', { name: 'layout' })).toBeInTheDocument();
  expect(within(panel).getByRole('combobox', { name: 'density' })).toBeInTheDocument();
  await user.click(within(panel).getByRole('radio', { name: 'list' }));
  expect(onChange).toHaveBeenLastCalledWith('layout', 'list');
  await user.click(within(panel).getByRole('button', { name: 'close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
