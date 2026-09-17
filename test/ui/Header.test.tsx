import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { Header } from '@/components/Header';
import { setLanguage } from '@/i18n';
import type { State } from '../../src/types';

const now = Date.now();
const base: State = { signal: 'green', maxConcurrent: 2, slots: [{ id: 's1', status: 'working' }, { id: 's2', status: 'empty' }], columns: [], cards: [], usage: [], budget: {}, usageRules: [] };
const noop = () => {};

beforeEach(() => setLanguage('en'));

test('one meter per configured budget with its percent; none without a budget', () => {
  const usage = [{ at: new Date(now - 60_000).toISOString(), tokens: 2_500 }, { at: new Date(now - 3 * 3_600_000).toISOString(), tokens: 5_000 }];
  render(<Header state={{ ...base, usage, budget: { maxTokensPerHour: 5_000, maxTokensPerDay: 30_000 } }} locale="en-US" onConfigure={noop} />);
  expect(screen.getByText('1/2 active workers')).toBeInTheDocument();
  expect(screen.getByText('hour 50%')).toBeInTheDocument();
  expect(screen.getByText('day 25%')).toBeInTheDocument();
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.queryByText('over budget')).not.toBeInTheDocument();
});

test('past a limit the over-budget line appears', () => {
  const usage = [{ at: new Date(now - 60_000).toISOString(), tokens: 6_000 }];
  render(<Header state={{ ...base, usage, budget: { maxTokensPerHour: 5_000 } }} locale="en-US" onConfigure={noop} />);
  expect(screen.getByText('hour 120%')).toBeInTheDocument();
  expect(screen.getByText('over budget')).toBeInTheDocument();
});

test('rate-limit windows get a meter with the label, the percent and the reset time; nothing without a reading', () => {
  const { rerender } = render(<Header state={base} locale="en-US" onConfigure={noop} />);
  expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  const rateLimits = { at: '2026-09-17T12:00:00.000Z', windows: { five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' }, seven_day_opus: { usedPercent: 7.5, resetsAt: '2026-09-21T00:00:00.000Z' } } };
  rerender(<Header state={{ ...base, rateLimits }} locale="en-US" onConfigure={noop} />);
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.getByText(/^session 23%/)).toBeInTheDocument();
  expect(screen.getByText(/^week opus 8%/)).toBeInTheDocument();
  expect(screen.getAllByText(/^resets \d{2}:\d{2}/)).toHaveLength(2);
});
