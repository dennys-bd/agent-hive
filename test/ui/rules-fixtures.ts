// The rules shared by the footer's, the rules button's and the rule-effects tests (#224): a signal, a total cap and a stage cap, all fired.
import type { EffectiveLimits, State, UsageRule } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';

export const WEEK_CAP: UsageRule = { source: 'week', percent: 90, maxWorkers: 2 };
export const SESSION_FORCE: UsageRule = { source: 'session', percent: 60, signal: 'yellow' };
export const DAY_STAGE: UsageRule = { source: 'day', percent: 80, maxWorkers: 1, stage: 'review' };

export const NONE: EffectiveLimits = { signal: 'green', floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} };
export const FIRED: EffectiveLimits = {
  signal: 'yellow', maxWorkers: 2, floor: { signal: 'yellow', maxWorkers: 2 }, signalRules: [SESSION_FORCE], capRules: [WEEK_CAP], disabledRules: [],
  stageCaps: { review: 1 }, stageCapRules: { review: [DAY_STAGE] },
};

export const STATE = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 5, workers: [{ id: 's1', status: 'working' }, { id: 's2', status: 'working', freeSession: true }, { id: 's3', status: 'empty' }],
  tasks: [], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [], stages: [],
  rateLimits: { claude: { at: '2026-09-28T10:00:00Z', windows: { seven_day: { usedPercent: 91, resetsAt: new Date(Date.now() + (4 * 24 + 10) * 3_600_000 + 60_000).toISOString() } } } },
} as unknown as State;
