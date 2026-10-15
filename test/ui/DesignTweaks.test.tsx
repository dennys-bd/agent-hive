import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
// The row's controls a reader still reaches: one that left the row is aria-hidden (#342)
const shown = (row: HTMLElement): (string | null)[] =>
  Array.from(row.querySelectorAll('[data-tweak-item]:not([aria-hidden="true"]) [aria-label]')).map((el) => el.getAttribute('aria-label'));
const labels = (root: HTMLElement): (string | null)[] => Array.from(root.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label'));

// The pane's part: the values held and given back, every change recorded
function Harness({ onChange }: { onChange(name: string, value: DesignTweakValue): void }) {
  const [values, setValues] = useState(() => settle(SCHEMA, {}));
  return <DesignTweaks block={{ status: 'ok', schema: SCHEMA, viewports: [] }} values={values} onChange={(name, value) => { onChange(name, value); setValues((now) => ({ ...now, [name]: value })); }} />;
}

// jsdom lays nothing out: every control 80px wide in a 200px row, so only the first fits beside more… (#342)
function overflowing(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
}

beforeEach(() => setLanguage('en'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('the row shows one control per tweak in declared order: a select per enum, a switch per boolean, an input per text and number; all fitting, no more… (#241, #342)', () => {
  render(<Harness onChange={vi.fn()} />);
  const row = screen.getByRole('toolbar', { name: 'tweaks' });
  expect(labels(row)).toEqual(['layout', 'density', 'auto', 'title', 'gap']);
  expect(within(row).getByRole('combobox', { name: 'layout' })).toHaveTextContent('board');
  expect(within(row).getByRole('combobox', { name: 'density' })).toHaveTextContent('cozy');
  expect(within(row).getByRole('switch', { name: 'auto' })).toBeChecked();
  expect(within(row).getByRole('textbox', { name: 'title' })).toHaveValue('Flow');
  expect(within(row).getByRole('spinbutton', { name: 'gap' })).toHaveValue(8);
  expect(within(row).queryByRole('button', { name: 'more…' })).toBeNull();
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
  overflowing();
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

// After the select tests: a Radix popover opened in jsdom leaves a later Select in the same file unable to open
test('a control that no longer fits leaves the row and more… shows; the panel holds every tweak and, while open, the row shows none (#342)', async () => {
  overflowing();
  const user = userEvent.setup();
  render(<Harness onChange={vi.fn()} />);
  const row = screen.getByRole('toolbar', { name: 'tweaks' });
  expect(shown(row)).toEqual(['layout']);
  await user.click(within(row).getByRole('button', { name: 'more…' }));
  expect(labels(screen.getByRole('dialog', { name: 'tweaks' }))).toEqual(['close', 'layout', 'auto', 'title', 'density', 'gap']);
  expect(shown(row)).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'close' }));
});

test('the panel is dragged by its header and keeps its place when closed and opened again (#342)', async () => {
  overflowing();
  const user = userEvent.setup();
  render(<Harness onChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'more…' }));
  const header = within(screen.getByRole('dialog', { name: 'tweaks' })).getByRole('heading', { name: 'tweaks' });
  fireEvent.pointerDown(header, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
  fireEvent.pointerMove(header, { pointerId: 1, clientX: 40, clientY: 25 });
  fireEvent.pointerUp(header, { pointerId: 1, clientX: 40, clientY: 25 });
  expect(screen.getByRole('dialog', { name: 'tweaks' }).style.translate).toBe('30px 15px');
  await user.click(screen.getByRole('button', { name: 'close' }));
  await user.click(screen.getByRole('button', { name: 'more…' }));
  expect(screen.getByRole('dialog', { name: 'tweaks' }).style.translate).toBe('30px 15px');
});

test('widened until every control fits while the panel is open: the panel and more… leave and the row shows them all (#342)', async () => {
  overflowing();
  const user = userEvent.setup();
  const callbacks: ((entries: unknown[]) => void)[] = []; // the row's observer, and Radix's own, which reads its entries
  vi.stubGlobal('ResizeObserver', class { constructor(callback: (entries: unknown[]) => void) { callbacks.push(callback); } observe(): void {} unobserve(): void {} disconnect(): void {} });
  render(<Harness onChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'more…' }));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  act(() => { for (const callback of callbacks) callback([]); });
  const row = screen.getByRole('toolbar', { name: 'tweaks' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(within(row).queryByRole('button', { name: 'more…' })).toBeNull();
  expect(shown(row)).toEqual(['layout', 'density', 'auto', 'title', 'gap']);
});
