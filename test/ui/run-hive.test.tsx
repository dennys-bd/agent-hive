import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bootRunHive, readPendingAsk, readRunHive, resetRunHive, RUN_POLL_MS } from '@/components/benchmark/run-mode/run-hive';
import { RunModeHost } from '@/components/benchmark/run-mode/RunModeHost';
import { setLanguage, t } from '@/i18n';
import { postJson } from '@/lib/api';
import { resetViewState } from '@/lib/view-state';
import { jsonResponse } from '../fakes';
import { frozen, RUN, stubRunFetch, writes } from './run-hive-fixtures';

beforeEach(() => { setLanguage('pt'); resetViewState(); });
afterEach(() => { resetRunHive(); vi.unstubAllGlobals(); });

test('one GET /benchmark-run at boot: an answer is run mode, whose write waits on an ask; a 404 and an answer that is not a run are a normal Hive, whose write goes out unasked (#469)', async () => {
  let calls = stubRunFetch(RUN);
  await bootRunHive();
  expect(readRunHive()).toEqual(RUN);
  void postJson('/signal', { signal: 'red' });
  expect([readPendingAsk() !== undefined, writes(calls)]).toEqual([true, []]);
  resetRunHive();
  for (const answer of [undefined, 'not a run'] as const) {
    calls = answer === undefined ? stubRunFetch(undefined) : [];
    const seen = calls;
    if (answer !== undefined) vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => { seen.push({ method: init?.method ?? 'GET', path: input }); return jsonResponse({ ok: true }); })); // every Dashboard test's stub
    await bootRunHive();
    expect(readRunHive()).toBeUndefined();
    await postJson('/signal', { signal: 'red' });
    expect([readPendingAsk(), writes(calls)]).toEqual([undefined, ['POST /signal']]);
  }
});

test('frozen: every write is refused before its fetch with the frozen copy, and nothing is asked (#469)', async () => {
  const calls = stubRunFetch(frozen(RUN));
  await bootRunHive();
  await expect(postJson('/tasks/A/approve')).rejects.toThrow(t('benchmark.run.frozen'));
  expect([readPendingAsk(), writes(calls)]).toEqual([undefined, []]);
});

test('the host re-reads GET /benchmark-run every 15 s, so terminal input the daemon recorded reaches the count (#469)', async () => {
  vi.useFakeTimers();
  try {
    const calls = stubRunFetch(RUN);
    await bootRunHive();
    render(<RunModeHost />);
    const reads = (): number => calls.filter((c) => c.path === '/benchmark-run').length;
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    expect(reads()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
