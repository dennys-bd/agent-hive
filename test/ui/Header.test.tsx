import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Header } from '@/components/Header';
import { setLanguage, t } from '@/i18n';
import type { State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const base: State = { signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 2, workers: [], stages: [], tasks: [], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] };
const claude = {
  at: '2026-09-17T12:00:00.000Z',
  windows: {
    five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' },
    seven_day: { usedPercent: 92, resetsAt: '2026-09-21T00:00:00.000Z' },
    seven_day_opus: { usedPercent: 7.5, resetsAt: '2026-09-21T00:00:00.000Z' },
  },
};
const noop = () => {};
const NOW = new Date('2026-09-17T12:00:00.000Z');
const indicator = (bar: HTMLElement): string => bar.querySelector('[data-slot="progress-indicator"]')?.className ?? '';

beforeEach(() => setLanguage('en'));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('the brand and the view switcher: atividades first, then fluxo; the center\'s view is pressed, each item shows its shortcut, a click switches (#533, #746)', async () => {
  const onView = vi.fn();
  render(<Header state={base} signal="green" center="activities" onView={onView} />);
  expect(screen.getByText(t('header.brand'))).toBeInTheDocument();
  // jsdom runs as off macOS: ⌘1 and ⌘2 there
  expect(screen.getAllByRole('radio').map((item) => item.textContent)).toEqual([`${t('header.activities')}Ctrl+1`, `${t('header.flow')}Ctrl+2`]);
  const flow = screen.getByRole('radio', { name: new RegExp(t('header.flow')) });
  const activities = screen.getByRole('radio', { name: new RegExp(t('header.activities')) });
  expect(activities).toHaveAttribute('aria-checked', 'true');
  expect(flow).toHaveAttribute('aria-checked', 'false');

  await userEvent.setup().click(flow);

  expect(onView).toHaveBeenCalledWith('automation');
});

test('one usage group per agent: its symbol, a meter per 5h and week limit, and a tooltip with the agent and each reset (#533)', () => {
  vi.useFakeTimers({ now: new Date('2026-09-17T12:00:00.000Z') });
  render(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  const bars = screen.getAllByRole('progressbar');
  expect(bars).toHaveLength(2); // seven_day_opus is not a limit the header shows
  expect(screen.getByText('5h')).toBeInTheDocument();
  expect(screen.getByText('wk')).toBeInTheDocument();
  const group = screen.getByTitle('claude · 5h resets in 3h · week resets in 3d12h');
  expect(group.querySelector('[data-icon="claude"]')).not.toBeNull();
  expect(group).not.toHaveTextContent(/claude/i); // the symbol names the agent, no text
  vi.useRealTimers();
});

test('at 90% a limit\'s fill and percent turn destructive; below it they stay neutral (#533)', () => {
  render(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  const [fiveHour, week] = screen.getAllByRole('progressbar');
  expect(indicator(fiveHour)).not.toMatch(/bg-destructive/);
  expect(screen.getByText('23%').className).not.toMatch(/text-destructive/);
  expect(indicator(week)).toMatch(/bg-destructive/);
  expect(screen.getByText('92%').className).toMatch(/text-destructive/);
});

test('without a reading there is no usage group', () => {
  render(<Header state={base} signal="green" center="activities" onView={noop} />);
  expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  expect(screen.queryByTitle(/^claude/)).not.toBeInTheDocument();
});

test('the header has no Settings button: Settings opens from the app menu, its shortcut or the menu bar icon (#499, #533)', () => {
  render(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([t('header.refreshUsage')]); // the usage refresh only
});

test('the hexagon takes the signal\'s colour (#533)', () => {
  const { container, rerender } = render(<Header state={base} signal="green" center="automation" onView={noop} />);
  const mark = (): Element => container.querySelector('[data-signal]')!;
  expect(mark().getAttribute('class')).toMatch(/text-signal-green/);
  rerender(<Header state={base} signal="red" center="automation" onView={noop} />);
  expect(mark().getAttribute('class')).toMatch(/text-signal-red/);
});

test('the agent\'s symbol in its usage group takes the agent\'s own colour, the design system\'s agent-colour exception (#669)', () => {
  render(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  const group = screen.getByTitle(/^claude/);
  expect(group.querySelector('[data-icon="claude"]')).toHaveClass('size-3.5', 'text-agent-claude');
});

test('the full form: the header is a container; past 56rem each bar widens and its reset countdown shows after the percent (#669)', () => {
  vi.useFakeTimers({ now: NOW });
  const { container } = render(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  expect(container.querySelector('header')).toHaveClass('@container');
  const bars = screen.getAllByRole('progressbar');
  expect(bars).toHaveLength(2);
  for (const bar of bars) expect(bar).toHaveClass('w-7', '@4xl:w-16');
  // jsdom evaluates no container query: the classes are the contract, the threshold is checked by hand in pnpm start
  expect(screen.getByText('3h')).toHaveClass('hidden', '@4xl:inline');
  expect(screen.getByText('3d12h')).toHaveClass('hidden', '@4xl:inline');
  // seven_day_opus resets with seven_day: one 3d12h means it renders no countdown
  expect(screen.getAllByText('3d12h')).toHaveLength(1);
});

test('a countdown takes its percent\'s band: destructive at 90% and above, muted below (#669)', () => {
  vi.useFakeTimers({ now: NOW });
  render(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  expect(screen.getByText('3d12h')).toHaveClass('text-destructive');
  expect(screen.getByText('3h')).toHaveClass('text-muted-foreground');
  expect(screen.getByText('3h')).not.toHaveClass('text-destructive');
});

test('the group\'s refresh button posts /plan-limits/refresh and stays disabled until it answers', async () => {
  let answer: (res: Response) => void = () => undefined;
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  render(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  const refresh = screen.getByRole('button', { name: t('header.refreshUsage') });
  await userEvent.setup().click(refresh);
  expect(fetchMock).toHaveBeenLastCalledWith('/plan-limits/refresh', expect.objectContaining({ method: 'POST' }));
  expect(refresh).toBeDisabled();
  answer(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  await waitFor(() => expect(refresh).toBeEnabled());
});

test('each agent with a reading has its group: Codex\'s free plan shows a 30d meter; no Codex reading, no Codex group (#929)', () => {
  vi.useFakeTimers({ now: NOW });
  const codex = { at: NOW.toISOString(), windows: { thirty_day: { usedPercent: 40, resetsAt: '2026-10-07T12:00:00.000Z' } } };
  const { rerender } = render(<Header state={{ ...base, rateLimits: { claude, codex } }} signal="green" center="automation" onView={noop} />);
  expect(screen.getByText('30d')).toBeInTheDocument();
  const group = screen.getByTitle(/^codex · 30 days resets in /);
  expect(group.querySelector('[data-icon="codex"]')).not.toBeNull();
  expect(screen.getAllByRole('progressbar')).toHaveLength(3);
  expect(screen.getAllByRole('button', { name: t('header.refreshUsage') })).toHaveLength(2); // #929: Codex's group refreshes too
  rerender(<Header state={{ ...base, rateLimits: { claude } }} signal="green" center="automation" onView={noop} />);
  expect(screen.queryByTitle(/^codex/)).not.toBeInTheDocument();
});
