import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { RulesTab } from '@/components/settings/RulesTab';
import { SignalCard } from '@/components/settings/SignalCard';
import { setLanguage, t } from '@/i18n';
import { draftFrom } from '@/lib/settings-form';
import { SIGNALS_DEFAULTS } from '../../src/types';

beforeEach(() => setLanguage('en'));

const label = (row: 'newTasks' | 'started' | 'workerless', signal: 'yellow' | 'red'): string =>
  t('settings.signal.control', { row: t(`settings.signal.${row}`), signal });

test('the card renders the defaults: green fixed, yellow and red as set, the opening signal and the footnote (#727)', () => {
  render(<SignalCard signals={SIGNALS_DEFAULTS} onChange={() => {}} />);
  expect(screen.getByRole('heading', { level: 2, name: t('settings.signal.title') })).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: label('newTasks', 'yellow') })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('switch', { name: label('workerless', 'red') })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('combobox', { name: label('started', 'yellow') })).toHaveTextContent(t('settings.signal.started.resumeAndContinue'));
  expect(screen.getByRole('combobox', { name: label('started', 'red') })).toHaveTextContent(t('settings.signal.started.stay'));
  expect(screen.getAllByText(t('settings.signal.always'))).toHaveLength(2);
  expect(screen.getByRole('combobox', { name: t('settings.signal.onOpen') })).toHaveTextContent('yellow');
  expect(screen.getByText(t('settings.signal.footnote'))).toBeInTheDocument();
  for (const signal of ['green', 'yellow', 'red']) expect(screen.getByText(signal, { selector: '[data-signal]' })).toHaveClass('signal-pill');
});

test('a red control the order would refuse is disabled; a yellow edit pulls red down with it (#727)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SignalCard signals={SIGNALS_DEFAULTS} onChange={onChange} />);
  expect(screen.getByRole('switch', { name: label('newTasks', 'red') })).toBeDisabled();
  expect(screen.getByRole('switch', { name: label('workerless', 'red') })).toBeEnabled();
  await user.click(screen.getByRole('switch', { name: label('workerless', 'yellow') }));
  expect(onChange).toHaveBeenLastCalledWith({
    ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, workerless: false }, red: { ...SIGNALS_DEFAULTS.red, workerless: false },
  });
});

test('Settings › rules shows the card above the usage rules and an edit lands in the draft the save sends (#727)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<RulesTab draft={draftFrom(undefined)} locale="en-US" onChange={onChange} />);
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings.indexOf(t('settings.signal.title'))).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf(t('settings.signal.title'))).toBeLessThan(headings.indexOf(t('settings.group.rules')));
  await user.click(screen.getByRole('switch', { name: label('newTasks', 'yellow') }));
  expect(onChange).toHaveBeenLastCalledWith({ signals: { ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, newTasks: true } } });
});
