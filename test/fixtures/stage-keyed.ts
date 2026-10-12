import { initialState } from '../../src/orchestrator.js';
import { transitionKey } from '../../src/transitions.js';
import type { Activity, ActivityRecord, State, Task } from '../../src/types.js';

// #861: one State naming stages A and B in every field the audit (plan Task 1) found to hold a stage name or a transitionKey. renameStages'
// tests rename RENAMES and read each field through STAGE_KEYED_FIELDS, so a field the audit adds gets its own assertion.

export const RENAMES: Record<string, string> = { A: 'Z', B: 'Y' };
const AT = '2026-10-11T00:00:00.000Z';
/** The done transition leaving `from`, as the reducer keys it. */
export const keyOf = (from: string): string => transitionKey({ from, when: 'done' });

const TASK: Task = {
  item: { itemId: 'board:I1', id: '1', title: 'T', body: '', url: '', source: 'board', epic: { follows: 'ahead', switchAt: 'A' } },
  stage: 'A', boardColumn: 'Ready', auto: true,
};
const ACTIVITY: Activity = {
  id: 'a1', kind: 'task', workspace: 'hive', slug: 'hive-1-t',
  stageStart: { stage: 'A', commit: 'c0ffee', after: 'B' },
  tries: { [keyOf('A')]: 1 }, via: keyOf('A'), handoffPending: keyOf('B'),
  tryLog: [{ transition: keyOf('A'), n: 1, max: 3, cause: 'done', error: '', at: AT, stage: 'B' }],
  freeSessionStage: 'A',
  commands: { stage: 'A', at: 0, ptyId: 'p1', runId: 'p1', failed: [], workerId: 'w1', started: [] },
  ci: { stage: 'A', since: AT, reran: [] },
  checkpoints: [{ n: 1, stage: 'A', start: 'c0ffee', head: 'c0ffee', commit: 'c0ffee', branch: 'hive/1-t', at: AT, ended: 'done' }],
  stageGone: 'A',
};
const RECORD: ActivityRecord = { id: 'a1', taskIds: ['board:I1'], sessions: [{ id: 's1', startedAt: AT, stages: ['A', 'B'], lastUsedAt: AT, agent: 'claude' }], stageRuns: { A: 2, B: 1 } };

/** The audited State: every stage-keyed field filled. */
export const stageKeyedState = (): State => ({
  ...initialState(0),
  stages: [{ name: 'A', from: {} }, { name: 'B', from: {} }],
  transitions: [{ from: 'A', to: 'B', when: 'done' }],
  tasks: [TASK], activities: [ACTIVITY], activityRecords: [RECORD],
  usageRules: [{ source: 'hour', percent: 80, maxWorkers: 1, stage: 'A' }],
  slept: [{ ptyId: 'p2', sessionId: 's1', agent: 'claude', kind: 'stage', stage: 'A', taskId: 'board:I1', at: 0 }],
});

/** One audited field: where it is read, and its value before and after RENAMES. */
export interface StageKeyedField { field: string; read(state: State): unknown; before: unknown; after: unknown }

const activity = (state: State): Activity | undefined => state.activities[0];

export const STAGE_KEYED_FIELDS: StageKeyedField[] = [
  { field: 'State.stages[].name', read: (s) => s.stages.map((c) => c.name), before: ['A', 'B'], after: ['Z', 'Y'] },
  { field: 'Transition.from / .to', read: (s) => s.transitions.map((t) => [t.from, t.to]), before: [['A', 'B']], after: [['Z', 'Y']] },
  { field: 'Task.stage', read: (s) => s.tasks[0]?.stage, before: 'A', after: 'Z' },
  { field: 'Item.epic.switchAt', read: (s) => s.tasks[0]?.item.epic?.switchAt, before: 'A', after: 'Z' },
  { field: 'Activity.stageStart.stage', read: (s) => activity(s)?.stageStart?.stage, before: 'A', after: 'Z' },
  { field: 'Activity.stageStart.after', read: (s) => activity(s)?.stageStart?.after, before: 'B', after: 'Y' },
  { field: 'Activity.tries (transitionKey)', read: (s) => Object.keys(activity(s)?.tries ?? {}), before: [keyOf('A')], after: [keyOf('Z')] },
  { field: 'Activity.via (transitionKey)', read: (s) => activity(s)?.via, before: keyOf('A'), after: keyOf('Z') },
  { field: 'Activity.handoffPending (transitionKey)', read: (s) => activity(s)?.handoffPending, before: keyOf('B'), after: keyOf('Y') },
  { field: 'TryRecord.transition', read: (s) => activity(s)?.tryLog?.[0]?.transition, before: keyOf('A'), after: keyOf('Z') },
  { field: 'TryRecord.stage', read: (s) => activity(s)?.tryLog?.[0]?.stage, before: 'B', after: 'Y' },
  { field: 'Activity.freeSessionStage', read: (s) => activity(s)?.freeSessionStage, before: 'A', after: 'Z' },
  { field: 'StageCommands.stage', read: (s) => activity(s)?.commands?.stage, before: 'A', after: 'Z' },
  { field: 'StageCi.stage', read: (s) => activity(s)?.ci?.stage, before: 'A', after: 'Z' },
  { field: 'Checkpoint.stage', read: (s) => activity(s)?.checkpoints?.[0]?.stage, before: 'A', after: 'Z' },
  { field: 'Activity.stageGone', read: (s) => activity(s)?.stageGone, before: 'A', after: 'Z' },
  { field: 'ActivityRecord.stageRuns (keys)', read: (s) => Object.keys(s.activityRecords[0]?.stageRuns ?? {}), before: ['A', 'B'], after: ['Z', 'Y'] },
  { field: 'Session.stages', read: (s) => s.activityRecords[0]?.sessions[0]?.stages, before: ['A', 'B'], after: ['Z', 'Y'] },
  { field: 'UsageRule.stage', read: (s) => s.usageRules[0]?.stage, before: 'A', after: 'Z' },
  { field: 'SleptRun.stage', read: (s) => s.slept?.[0]?.stage, before: 'A', after: 'Z' },
];
