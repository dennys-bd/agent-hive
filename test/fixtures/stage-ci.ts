// The wait-for-CI reducer tests' fixture (#834, #598), shared by stage-ci.test.ts and stage-ci-clock.test.ts.
import { activityOf, resultOf } from '../../src/activities.js';
import { initialState, reduce, type Reduced } from '../../src/orchestrator.js';
import type { LegacyStage } from '../../src/config-migrate.js';
import type { Activity, CiCheck, CiPrRead, Effect, HiveEvent, Item, SourceItem, Stage, State, TaskPr } from '../../src/types.js';
import { chained } from '../fakes.js';

export const ID = 'board:item1';
export const URL = 'https://github.com/o/r/pull/7';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
export const listed = (column: string, extra: Partial<Item> = {}): SourceItem => ({ item: { ...item, ...extra }, column });
export const ci = (extra: Partial<Stage> = {}): LegacyStage => ({ name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: false, ...extra });
export const REVIEW: LegacyStage = { name: 'review', from: { board: ['Review'] } };
export const base = (extra: Partial<Stage> = {}, state: Partial<State> = {}): State =>
  ({ ...initialState(1), signal: 'red', workspaces: ['hive'], syncs: { board: {} }, ...chained([ci(extra), REVIEW]), ...state });
export const polled = (extra: Partial<Stage> = {}, state: Partial<State> = {}): Reduced => reduce(base(extra, state), { type: 'poll', source: 'board', items: [listed('CI')] });
export const live = (s: State): Activity | undefined => activityOf(s, ID);
export const check = (name: string, state: CiCheck['state'], extra: Partial<CiCheck> = {}): CiCheck => ({ name, pr: URL, state, ...extra });
export const pr = (checks: CiCheck[], head = 'h1'): CiPrRead => ({ url: URL, head, checks });
export const readOf = (s: State, prs: CiPrRead[], at = new Date().toISOString()): Extract<HiveEvent, { type: 'ciRead' }> =>
  ({ type: 'ciRead', activityId: live(s)?.id ?? 'none', at, prs });
export const read = (s: State, prs: CiPrRead[], at?: string): Reduced => reduce(s, readOf(s, prs, at));
export const failedOf = (s: State, names: string[], output = 'logs'): Reduced => reduce(s, { type: 'ciFailed', activityId: live(s)?.id ?? 'none', names, output });
export const effectOf = <T extends Effect['type']>(effects: Effect[], type: T): Extract<Effect, { type: T }> | undefined =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);
export const LATER = '2100-01-01T00:00:00Z'; // a failure completed after any re-run the tests ask
export const outputOf = (s: State): unknown => (resultOf(s, ID)?.ci as { output?: unknown } | undefined)?.output;
// The task's records holding `prs` (#304): what the PR poll leaves once it has read their states
export const withPrs = (s: State, prs: TaskPr[]): State => ({ ...s, activityRecords: s.activityRecords.map((r) => (r.taskIds.includes(ID) ? { ...r, prs } : r)) });
// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
