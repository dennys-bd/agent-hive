import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { SignalToggle } from '@/components/SignalToggle';
import { setLanguage, t } from '@/i18n';
import { signalEffect } from '@/lib/signal-effect';
import type { EffectiveLimits, RuleSignal } from '../../src/types';
import { SIGNALS_DEFAULTS } from '../../src/types';

// Moved from Header.test.tsx (#456): the toggle left the header for the footer, unchanged.
// manual green under a `session ≥ 80 → signal` rule
const floored = (signal: RuleSignal): EffectiveLimits => ({ signal, floor: { signal }, signalRules: [{ source: 'session', percent: 80, signal }], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} });

beforeEach(() => setLanguage('en'));

test('the pressed toggle item carries the signal it is pressed for; every item carries its own data-signal regardless of press state', () => {
  render(<SignalToggle signals={SIGNALS_DEFAULTS} signal="yellow" />);
  const pressed = screen.getByRole('radio', { checked: true });
  expect(pressed).toHaveAttribute('data-signal', 'yellow');
  for (const signal of ['green', 'yellow', 'red']) expect(screen.getByRole('radio', { name: signal })).toHaveAttribute('data-signal', signal);
  expect(screen.getByRole('radio', { name: 'green' })).toHaveAttribute('data-state', 'off');
});

test('under a floor the looser toggle items are disabled and name the rule; the pressed item stays the manual signal; nothing is locked without effective', () => {
  const { rerender } = render(<SignalToggle signals={SIGNALS_DEFAULTS} signal="green" effective={floored('yellow')} />);
  const green = screen.getByRole('radio', { name: 'green' });
  expect(green).toBeDisabled();
  expect(green).toHaveAttribute('title', 'locked by rule: session ≥ 80%');
  expect(green).toHaveAttribute('data-state', 'on'); // the stored signal stays pressed, disabled or not
  expect(screen.getByRole('radio', { name: 'yellow' })).toBeEnabled();
  expect(screen.getByRole('radio', { name: 'red' })).toBeEnabled();
  expect(screen.getByRole('radio', { name: 'red' })).not.toHaveAttribute('title');
  rerender(<SignalToggle signals={SIGNALS_DEFAULTS} signal="green" effective={floored('red')} />);
  expect(screen.getByRole('radio', { name: 'green' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'yellow' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'red' })).toBeEnabled();
  rerender(<SignalToggle signals={SIGNALS_DEFAULTS} signal="green" />);
  for (const signal of ['green', 'yellow', 'red']) expect(screen.getByRole('radio', { name: signal })).toBeEnabled();
});

test('the label names the group; the hint says what the yellow and red rows hold back, and green has none (redesign 09, #727)', () => {
  const { rerender } = render(<SignalToggle signals={SIGNALS_DEFAULTS} signal="yellow" />);
  expect(screen.getByRole('radiogroup', { name: 'signal' })).toBeInTheDocument();
  expect(screen.getByText(t('signal.effect.newTasksFromTree'))).toBeVisible();
  rerender(<SignalToggle signals={SIGNALS_DEFAULTS} signal="red" />);
  expect(screen.getByText(`${t('signal.effect.noNewTasks')} · ${t('signal.effect.noMoveOn')}`)).toBeVisible();
  rerender(<SignalToggle signals={SIGNALS_DEFAULTS} signal="green" />);
  expect(screen.queryByText(/no new|like green/)).not.toBeInTheDocument();
});

test('the toggle items render at the xs size', () => {
  render(<SignalToggle signals={SIGNALS_DEFAULTS} signal="green" />);
  for (const signal of ['green', 'yellow', 'red']) expect(screen.getByRole('radio', { name: signal })).toHaveAttribute('data-size', 'xs');
});

test('names green\'s effect only when green is not always (#32)', () => {
  expect(signalEffect('green', SIGNALS_DEFAULTS)).toBeUndefined();
  expect(signalEffect('green', { ...SIGNALS_DEFAULTS, green: { newTasks: 'tree' } })).toBe(t('signal.effect.newTasksFromTree'));
  expect(signalEffect('green', { ...SIGNALS_DEFAULTS, green: { newTasks: 'never' } })).toBe(t('signal.effect.noNewTasks'));
});
