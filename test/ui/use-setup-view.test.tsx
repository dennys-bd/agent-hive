import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { type Answer, sessionStatus, useSetupView, verdictOf } from '@/hooks/use-setup-view';
import type { Activity, SetupRow } from '../../src/types';

const RUNNING: SetupRow[] = [{ kind: 'worktree', status: 'done', durationMs: 900 }, { kind: 'step', status: 'running', label: 'x', header: 'RUN x', startedAt: '2026-10-19T10:00:00.000Z' }];
const DONE: SetupRow[] = [{ kind: 'worktree', status: 'done', durationMs: 900 }, { kind: 'step', status: 'done', label: 'x', header: 'RUN x', durationMs: 5 }];
const FAILED: SetupRow[] = [{ kind: 'worktree', status: 'done', durationMs: 900 }, { kind: 'step', status: 'failed', label: 'x', header: 'RUN x', durationMs: 5, code: '1' }];
const activity = (fields: Partial<Activity> = {}): Activity => ({ id: 'a-I9', kind: 'task', workspace: 'site', ...fields });

test('verdictOf: with no preparing view the answer decides, as before; with it a refusal fails at once and an ok waits for the setup to leave the state, whose lastSetup then says it failed (#390)', () => {
  const ok = { ok: true } as const;
  const refused = { ok: false, error: new Error('setup failed') } as const;
  const setting = activity({ setup: { consoleId: 'setup:I9', rows: RUNNING } });
  const failed = activity({ lastSetup: { consoleId: 'setup:I9', rows: FAILED } });
  expect(verdictOf(true, undefined, setting)).toBeUndefined();
  expect([verdictOf(false, ok, setting), verdictOf(false, refused, activity())]).toEqual(['end', 'end']);
  expect([verdictOf(true, refused, setting), verdictOf(true, ok, setting), verdictOf(true, ok, failed), verdictOf(true, ok, activity())]).toEqual(['failed', undefined, 'failed', 'end']);
});

test('sessionStatus: queued while a server row is not done, running once they all are, done once the request answered (#390)', () => {
  expect([sessionStatus(RUNNING, false), sessionStatus(FAILED, true), sessionStatus(DONE, false), sessionStatus(DONE, true)]).toEqual(['queued', 'queued', 'running', 'done']);
});

const REFUSED: Answer = { ok: false, error: new Error('spawn failed') };
// The view on: a request begun while the activity holds its setup
function viewOn(initial: Activity) {
  const onEnd = vi.fn();
  const onFailed = vi.fn();
  const hook = renderHook(({ live }) => useSetupView(live), { initialProps: { live: initial } });
  let settle = (_answer: Answer): void => undefined;
  act(() => { settle = hook.result.current.begin(onEnd, onFailed); });
  return { ...hook, onEnd, onFailed, settle: (answer: Answer) => act(() => settle(answer)), retry: () => act(() => { settle = hook.result.current.begin(onEnd, onFailed); }) };
}

test('a refusal while the setup is still in the state fails only once it leaves: tentar de novo never shows while a submit would be blocked (#390)', () => {
  const view = viewOn(activity({ setup: { consoleId: 'setup:I9', rows: RUNNING } }));
  view.settle(REFUSED);
  expect(view.onFailed).toHaveBeenCalledWith(REFUSED);
  expect(view.result.current.isFailed).toBe(false);
  view.rerender({ live: activity() });
  expect(view.result.current.isFailed).toBe(true);
});

test('a failure with no lastSetup shows the last seen rows with their running row failed (#390)', () => {
  const view = viewOn(activity({ setup: { consoleId: 'setup:I9', rows: RUNNING } }));
  view.settle(REFUSED);
  view.rerender({ live: activity() });
  expect(view.result.current.progress?.rows.map((row) => row.status)).toEqual(['done', 'failed']);
});

test('a retry\'s ok answer before its setupStarted reads the last failure\'s lastSetup as stale: the dialog ends (#390)', () => {
  const view = viewOn(activity({ setup: { consoleId: 'setup:I9', rows: RUNNING } }));
  view.rerender({ live: activity({ lastSetup: { consoleId: 'setup:I9', rows: FAILED } }) });
  view.settle({ ok: true });
  expect(view.onFailed).toHaveBeenCalledTimes(1);
  view.retry();
  view.rerender({ live: activity({ lastSetup: { consoleId: 'setup:I9', rows: FAILED.map((row) => ({ ...row })) } }) }); // a new broadcast, the same failure
  view.settle({ ok: true });
  expect(view.onEnd).toHaveBeenCalledWith({ ok: true });
  expect(view.onFailed).toHaveBeenCalledTimes(1);
});
