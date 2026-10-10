import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ConventionsEditor } from '@/components/settings/ConventionsEditor';
import { setLanguage, t } from '@/i18n';
import { type ConventionRowDraft, rowFor } from '@/lib/settings-conventions';
import { CONVENTION_KEYS } from '../../src/conventions';
import { DELIVERIES } from '../../src/types';

beforeEach(() => setLanguage('pt'));

// The card over its own rows, as the workspace's card holds the draft: every onChange is seen and applied
function Harness({ initial, onChange }: { initial: ConventionRowDraft[]; onChange(rows: ConventionRowDraft[]): void }) {
  const [rows, setRows] = useState(initial);
  return <ConventionsEditor label="convenções do workspace hive" rows={rows} onChange={(next) => { onChange(next); setRows(next); }} />;
}
const setup = (initial: ConventionRowDraft[]) => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness initial={initial} onChange={onChange} />);
  return { user, last: (): ConventionRowDraft[] => onChange.mock.lastCall?.[0] as ConventionRowDraft[] };
};
// A pointerdown + click sequence: jsdom has no layout, and a Radix Select trigger needs the pointer events to open (as StageEditor.test does)
function openSelect(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
}
const options = async (): Promise<string[]> => within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent ?? '');

test('the key select offers the row\'s own key and the unused ones only; + adds the next unused key; a new key resets the value (#692)', async () => {
  const { user, last } = setup([{ ...rowFor('specsDir'), value: 'docs/specs' }]);
  await user.click(screen.getByRole('button', { name: t('settings.conventions.add') }));
  expect(last().map((r) => r.key)).toEqual(['specsDir', 'docsRepo']);
  openSelect(screen.getByRole('combobox', { name: t('settings.conventions.key', { n: 2 }) }));
  expect(await options()).toEqual(CONVENTION_KEYS.filter((k) => k !== 'specsDir').map((k) => t(`settings.conventions.label.${k}`)));
  fireEvent.click(screen.getByRole('option', { name: t('settings.conventions.label.sliceSize') }));
  expect(last()[1]).toEqual({ id: last()[1].id, key: 'sliceSize', value: '', min: '', max: '' });
});

test('each key gets its control: a select for delivery and feature flags, two numbers for the slice size, a text area for the UI check, suggestions on the languages (#692)', async () => {
  const { last } = setup([rowFor('delivery'), rowFor('featureFlags'), rowFor('sliceSize'), rowFor('uiCheck'), rowFor('docsLanguage'), rowFor('specsDir')]);
  const delivery = screen.getByRole('combobox', { name: t('settings.conventions.value', { n: 1 }) });
  expect(delivery).toHaveTextContent(t('settings.conventions.delivery.single'));
  openSelect(delivery);
  expect(await options()).toEqual(DELIVERIES.map((v) => t(`settings.conventions.delivery.${v}`)));
  fireEvent.click(screen.getByRole('option', { name: t('settings.conventions.delivery.stacked') }));
  expect(last()[0].value).toBe('stacked');
  expect(screen.getByRole('combobox', { name: t('settings.conventions.value', { n: 2 }) })).toHaveTextContent(t('settings.conventions.featureFlags.none'));
  fireEvent.change(screen.getByLabelText(t('settings.conventions.min', { n: 3 })), { target: { value: '300' } });
  fireEvent.change(screen.getByLabelText(t('settings.conventions.max', { n: 3 })), { target: { value: '550' } });
  expect([last()[2].min, last()[2].max]).toEqual(['300', '550']);
  expect(screen.getByLabelText(t('settings.conventions.value', { n: 4 })).tagName).toBe('TEXTAREA');
  const language = screen.getByLabelText(t('settings.conventions.value', { n: 5 }));
  const list = document.getElementById(language.getAttribute('list') ?? '');
  expect(Array.from(list?.querySelectorAll('option') ?? []).map((o) => o.getAttribute('value'))).toEqual(['English', 'Português', 'Español', 'Français', 'Deutsch', 'Italiano', '日本語', '中文']);
  expect(screen.getByLabelText(t('settings.conventions.value', { n: 6 }))).not.toHaveAttribute('list');
  for (const key of ['delivery', 'sliceSize', 'uiCheck'] as const) expect(screen.getByText(t(`settings.conventions.about.${key}`))).toBeInTheDocument();
});

test('× removes a row; with every key in use there is no + (#692)', async () => {
  const { user, last } = setup(CONVENTION_KEYS.map((key) => rowFor(key)));
  expect(screen.queryByRole('button', { name: t('settings.conventions.add') })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: t('settings.conventions.remove', { n: 1 }) }));
  expect(last().map((r) => r.key)).toEqual(CONVENTION_KEYS.slice(1));
  expect(screen.getByRole('button', { name: t('settings.conventions.add') })).toBeInTheDocument();
});

test('the card renders in English and in Portuguese (#692)', () => {
  for (const [language, label] of [['en', 'slice size'], ['pt', 'tamanho da fatia']] as const) {
    setLanguage(language);
    const { unmount } = render(<ConventionsEditor label="x" rows={[rowFor('sliceSize')]} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: t('settings.conventions.key', { n: 1 }) })).toHaveTextContent(label);
    expect(screen.getByText(t('settings.conventions.about.sliceSize'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('settings.conventions.add') })).toBeInTheDocument();
    unmount();
  }
});
