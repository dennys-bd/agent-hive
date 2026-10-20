import { expect, test } from 'vitest';
import { sessionStatus, verdictOf } from '@/hooks/use-setup-view';
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
