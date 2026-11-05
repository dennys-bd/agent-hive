// #572: two flows (dev in build, review in ship), two sources, and five tasks. #1 waits for an approval (build). #2's session waits for the
// user (ship). #3 works (ship). #4 sits in a stage of no flow and waits for an approval (outside). #5 is a hive task with no stage (outside).
import { flatten } from '../../src/flows';
import type { Flow, SourceConfig, Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { activityIdOf, type WithWork, withPointedWork, withTasks } from '../fixtures/work';

const stage = (name: string, column: string): Stage => ({ name, from: { roadmap: [column] }, prompt: 'x' });
export const FLOWS: Flow[] = [{ name: 'build', stages: [stage('dev', 'Ready')], transitions: [] }, { name: 'ship', stages: [stage('review', 'Review')], transitions: [] }];
const source = (name: string, number: number): SourceConfig => ({ name, qualifyId: false, type: 'github', owner: 'acme', number, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flow: 'main' } }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' });
export const ROADMAP = source('roadmap', 6);
export const NOTES = source('notes', 8);

const SINCE = '2026-11-04T09:00:00.000Z';
const task = (n: string, at: string | undefined, from: string | undefined, work: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `${from ?? 'local'}:${n}`, id: n, title: `Task ${n}`, body: '', url: '', source: from }, ...(at === undefined ? {} : { stage: at }), boardColumn: 'Ready', auto: true, ...work,
});
const TASKS: WithWork[] = [
  task('1', 'dev', 'roadmap', { approval: { since: SINCE } }), task('2', 'review', 'roadmap'), task('3', 'review', 'notes'),
  task('4', 'gone', 'roadmap', { approval: { since: SINCE } }), task('5', undefined, undefined),
];
const WORKERS: Worker[] = [
  { id: 'w2', status: 'waiting', activityId: activityIdOf('roadmap:2'), runId: 'R2' },
  { id: 'w3', status: 'working', activityId: activityIdOf('notes:3'), runId: 'R3' },
];
const BASE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 5, workers: WORKERS, terminals: [], flows: FLOWS, ...flatten(FLOWS),
  tasks: [], sourceOrder: [], localCount: 0, benchmark: { experiments: [] },
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
export const SIDEBAR_STATE: State = withPointedWork(withTasks(BASE, TASKS));
