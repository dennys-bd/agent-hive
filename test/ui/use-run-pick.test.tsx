import { expect, test } from 'vitest';
import { initialPicks, NEW_SESSION, nextPicks, openBody, PREVIOUS_SESSION, startBody } from '@/hooks/use-run-pick';
import type { Session, Stage, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { withWork } from '../fixtures/work';

const AT = '2026-10-13T10:00:00.000Z';
const CLAUDE = 'aaaaaaaa-0000-4000-8000-000000000001';
const CODEX = 'bbbbbbbb-0000-4000-8000-000000000002';
const session = (id: string, agent: Session['agent']): Session => ({ id, startedAt: AT, stages: ['spec'], agent, lastUsedAt: AT });
const stages: Stage[] = [{ name: 'spec', from: {}, prompt: 'x' }, { name: 'build', from: {}, prompt: 'x', session: 'continue', model: 'opus' }];
const TASK: Task = { item: { itemId: 'I1', id: 'SITE-1', title: 'one', body: '', url: '' }, stage: 'build', boardColumn: '', auto: true, workspace: 'site' };
const stateWith = (sessions: Session[]): State => withWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks: [TASK], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [],
  workspaces: ['site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
}, 'I1', {}, { sessions });

test('the initial picks are the stage\'s: its agent, the model left to the chain, and the previous stage\'s session when the stage continues and its agent recorded it (#290)', () => {
  expect(initialPicks(TASK, stateWith([session(CLAUDE, 'claude')]), 'claude')).toEqual({ agent: 'claude', model: '', session: PREVIOUS_SESSION, specializedAgent: '', args: '' });
  expect(initialPicks(TASK, stateWith([session(CODEX, 'codex')]), 'claude').session).toBe(NEW_SESSION);
  expect(initialPicks(undefined, stateWith([]), 'codex')).toEqual({ agent: 'codex', model: '', session: NEW_SESSION, specializedAgent: '', args: '' });
});

test('another agent drops an explicit model and a session it cannot resume; any other change is just that (#290)', () => {
  const state = stateWith([session(CLAUDE, 'claude')]);
  const picks = { ...initialPicks(TASK, state, 'claude'), model: 'sonnet' };
  expect(nextPicks(picks, { agent: 'codex' }, TASK, state)).toEqual({ ...picks, agent: 'codex', model: '', session: NEW_SESSION });
  expect(nextPicks(picks, { args: '--verbose' }, TASK, state)).toEqual({ ...picks, args: '--verbose' });
});

test('a start posts only what differs from the stage: absent stays the stage\'s; a free open posts a resume\'s id alone (#290)', () => {
  const state = stateWith([session(CLAUDE, 'claude')]);
  const initial = initialPicks(TASK, state, 'claude');
  expect(startBody(initial, initial)).toEqual({});
  expect(startBody({ ...initial, model: 'sonnet' }, initial)).toEqual({ model: 'sonnet' });
  expect(startBody({ ...initial, args: '--verbose' }, initial)).toEqual({ args: ['--verbose'] });
  expect(startBody(nextPicks(initial, { agent: 'codex' }, TASK, state), initial)).toEqual({ agent: 'codex', session: NEW_SESSION });
  expect(openBody(initial, TASK, state)).toEqual({ kind: 'claude', continueId: CLAUDE });
  expect(openBody({ ...initial, session: NEW_SESSION }, TASK, state)).toEqual({ kind: 'claude' });
});
