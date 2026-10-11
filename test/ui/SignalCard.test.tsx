import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { RulesTab } from '@/components/settings/RulesTab';
import { SignalCard } from '@/components/settings/SignalCard';
import { setLanguage, t } from '@/i18n';
import { draftFrom } from '@/lib/settings-form';
import { SIGNALS_DEFAULTS } from '../../src/types';

beforeEach(() => setLanguage('en'));

const label = (row: 'started' | 'workerless', signal: 'yellow' | 'red'): string =>
  t('settings.signal.control', { row: t(`settings.signal.${row}`), signal });
const newTasks = (signal: 'green' | 'yellow' | 'red'): HTMLElement => screen.getByRole('combobox', { name: t('settings.signal.newTasks.control', { signal }) });
const option = (value: 'always' | 'tree' | 'never'): Promise<HTMLElement> => screen.findByRole('option', { name: t(`settings.signal.newTasks.${value}`) });

test('the card renders the defaults: a new tasks select per colour, green\'s other rows fixed, yellow and red as set, the opening signal and the footnote (#727, #32)', () => {
  render(<SignalCard signals={SIGNALS_DEFAULTS} onChange={() => {}} />);
  expect(screen.getByRole('heading', { level: 2, name: t('settings.signal.title') })).toBeInTheDocument();
  expect(newTasks('green')).toHaveTextContent(t('settings.signal.newTasks.always'));
  expect(newTasks('yellow')).toHaveTextContent(t('settings.signal.newTasks.tree'));
  expect(newTasks('red')).toHaveTextContent(t('settings.signal.newTasks.never'));
  expect(screen.getByText(t('settings.signal.newTasks.treeHint'))).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: label('workerless', 'red') })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('combobox', { name: label('started', 'yellow') })).toHaveTextContent(t('settings.signal.started.resumeAndContinue'));
  expect(screen.getByRole('combobox', { name: label('started', 'red') })).toHaveTextContent(t('settings.signal.started.stay'));
  expect(screen.getByRole('combobox', { name: t('settings.signal.onOpen') })).toHaveTextContent('yellow');
  expect(screen.getByText(t('settings.signal.footnote'))).toBeInTheDocument();
  for (const signal of ['green', 'yellow', 'red']) expect(screen.getByText(signal, { selector: '[data-signal]' })).toHaveClass('signal-pill');
});

test('an option the order would refuse is disabled: red is not offered more than yellow (#727, #32)', async () => {
  render(<SignalCard signals={SIGNALS_DEFAULTS} onChange={() => {}} />);
  fireEvent.click(newTasks('red'));
  expect(await option('always')).toHaveAttribute('aria-disabled', 'true');
  expect(await option('tree')).not.toHaveAttribute('aria-disabled');
});

test('with green on tree, yellow is not offered always (#32)', async () => {
  render(<SignalCard signals={{ ...SIGNALS_DEFAULTS, green: { newTasks: 'tree' } }} onChange={() => {}} />);
  fireEvent.click(newTasks('yellow'));
  expect(await option('always')).toHaveAttribute('aria-disabled', 'true');
  expect(await option('tree')).not.toHaveAttribute('aria-disabled');
});

test('a looser edit clamps the stricter rows: green to never pulls yellow down; a yellow switch pulls red down (#727, #32)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SignalCard signals={SIGNALS_DEFAULTS} onChange={onChange} />);
  fireEvent.click(newTasks('green'));
  fireEvent.click(await option('never'));
  expect(onChange).toHaveBeenLastCalledWith({ ...SIGNALS_DEFAULTS, green: { newTasks: 'never' }, yellow: { ...SIGNALS_DEFAULTS.yellow, newTasks: 'never' } });
  expect(screen.getByRole('switch', { name: label('workerless', 'red') })).toBeEnabled();
  await user.click(screen.getByRole('switch', { name: label('workerless', 'yellow') }));
  expect(onChange).toHaveBeenLastCalledWith({
    ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, workerless: false }, red: { ...SIGNALS_DEFAULTS.red, workerless: false },
  });
});

test('Settings › rules shows the card above the usage rules and an edit lands in the draft the save sends (#727, #32)', async () => {
  const onChange = vi.fn();
  render(<RulesTab draft={draftFrom(undefined)} locale="en-US" onChange={onChange} />);
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings.indexOf(t('settings.signal.title'))).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf(t('settings.signal.title'))).toBeLessThan(headings.indexOf(t('settings.group.rules')));
  fireEvent.click(newTasks('yellow'));
  fireEvent.click(await option('always'));
  expect(onChange).toHaveBeenLastCalledWith({ signals: { ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, newTasks: 'always' } } });
});
