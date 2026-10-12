import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkerCap } from '@/components/WorkerCap';
import { setLanguage } from '@/i18n';
import type { EffectiveLimits, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, MAX_CONCURRENT_MAX, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const base: State = { signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 2, workers: [{ id: 's1', status: 'working' }, { id: 's2', status: 'empty' }], stages: [], tasks: [], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] };
// manual 5 under a `week ≥ 70 → max 4` rule
const capped: EffectiveLimits = { signal: 'green', maxWorkers: 4, floor: { signal: 'green', maxWorkers: 4 }, signalRules: [], capRules: [{ source: 'week', percent: 70, maxWorkers: 4 }], disabledRules: [], stageCaps: {}, stageCapRules: {} };
const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => { setLanguage('en'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the counter reads "workers {active}/{max}"', () => {
  render(<WorkerCap state={base} />);
  expect(screen.getByText('workers 1/2')).toBeInTheDocument();
});

test('under a cap the workers field carries max and the rule and still shows the stored value; a blur without edits posts nothing, a value above the cap posts the cap, one below posts as typed', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<WorkerCap state={{ ...base, maxConcurrent: 5 }} effective={capped} />);
  const input = screen.getByLabelText('max.');
  expect(input).toHaveAttribute('max', '4');
  expect(input).toHaveAttribute('title', 'capped by rule: week ≥ 70%');
  expect(input).toHaveValue(5);
  await user.click(input);
  await user.tab();
  expect(fetchMock).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, '7');
  await user.tab();
  expect(fetchMock).toHaveBeenLastCalledWith('/config', expect.objectContaining({ method: 'POST', body: JSON.stringify({ maxConcurrent: 4 }) }));
  await user.clear(input);
  await user.type(input, '3');
  await user.tab();
  expect(fetchMock).toHaveBeenLastCalledWith('/config', expect.objectContaining({ body: JSON.stringify({ maxConcurrent: 3 }) }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  rerender(<WorkerCap state={{ ...base, maxConcurrent: 5 }} />);
  expect(input).toHaveAttribute('max', String(MAX_CONCURRENT_MAX)); // no rule: the server's own bound (#727)
  expect(input).not.toHaveAttribute('title');
});

test('under a fired cap the counter reads the effective cap while the field keeps the configured value (#178)', () => {
  const workers = ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ id, status: 'working' as const }));
  const cap3: EffectiveLimits = { ...capped, maxWorkers: 3, floor: { signal: 'green', maxWorkers: 3 }, capRules: [{ source: 'week', percent: 70, maxWorkers: 3 }] };
  render(<WorkerCap state={{ ...base, maxConcurrent: 5, workers }} effective={cap3} />);
  expect(screen.getByText('workers 5/3')).toBeInTheDocument();
  expect(screen.getByLabelText('max.')).toHaveValue(5);
});

test('a value above MAX_CONCURRENT_MAX posts nothing: the server would refuse it (#727)', async () => {
  const user = userEvent.setup();
  render(<WorkerCap state={base} />);
  const input = screen.getByLabelText('max.');
  await user.clear(input);
  await user.type(input, String(MAX_CONCURRENT_MAX + 1));
  await user.tab();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a rule cap above the configured max leaves the counter at the configured max (#178)', () => {
  const loose: EffectiveLimits = { ...capped, maxWorkers: 2, floor: { signal: 'green', maxWorkers: 6 }, capRules: [{ source: 'week', percent: 70, maxWorkers: 6 }] };
  render(<WorkerCap state={base} effective={loose} />);
  expect(screen.getByText('workers 1/2')).toBeInTheDocument();
});

test('the counter counts only workers: the user\'s own session is not one (#459)', () => {
  const workers = [...base.workers, { id: 's3', status: 'waiting' as const, freeSession: true as const }];
  render(<WorkerCap state={{ ...base, workers }} />);
  expect(screen.getByText('workers 1/2')).toBeInTheDocument();
});
