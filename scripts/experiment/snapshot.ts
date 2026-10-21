import { createHash } from 'node:crypto';
import { PR_STATES } from '../../src/pull-requests.js';
import { EXPERIMENT_PREFIX, stateBase, WORKSPACE_NAME } from './harness-config.js';
import { WORKTREE_MARK } from './seed.js';

export interface SnapshotOptions { liveStages: readonly string[]; seedStages: readonly string[]; username: string; home: string }
type Rec = Record<string, unknown>;

const MAX_TASKS = 12; // two screens of the 3×2 grid: enough to fill it and to scroll (4j)
const FAKE_PULLS = 'https://github.com/acme/app/pull';
const PR_NUMBER = /\/pull\/(\d+)$/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const TOKEN = /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\bBearer\s+\S+|\bAIza[0-9A-Za-z_-]{35}|\bnpm_[0-9A-Za-z]{36}|\bglpat-[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g;
const SECRET_HEX = /\b[0-9a-f]{64}\b/gi;
const ABSOLUTE_ROOTS = 'Users|home|Volumes|root|private|var';
const HOME_PATH = new RegExp(`/(?:${ABSOLUTE_ROOTS})/[^/\\s"]*`, 'g');
const HOME_ROOT = new RegExp(`/(?:${ABSOLUTE_ROOTS})/`);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MENTION = /@[A-Za-z0-9][A-Za-z0-9-]*/g;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const iso = (value: unknown): string | undefined => (typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
// A copied field that is not the shape the Monitor View reads is dropped, so free text cannot ride in it
const only = (key: string, value: unknown): Rec => (value === undefined ? {} : { [key]: value });
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordOf = (name: string): RegExp => new RegExp(`\\b${escaped(name)}\\b`, 'gi');

export function sanitizeText(text: string, o: Pick<SnapshotOptions, 'username' | 'home'>): string {
  const homeless = o.home === '' ? text : text.split(o.home).join('~');
  const scrubbed = homeless.replace(EMAIL, '<email>').replace(TOKEN, '<token>').replace(SECRET_HEX, '<secret>').replace(HOME_PATH, '~');
  return (o.username === '' ? scrubbed : scrubbed.replace(wordOf(o.username), 'user')).replace(MENTION, '@user');
}

/** A live stage onto the seed's, by position: first to first, last to last. */
export function mapStage(live: readonly string[], seed: readonly string[], name: string): string {
  const i = live.indexOf(name);
  if (i <= 0 || live.length === 1) return seed[0];
  return seed[Math.round((i * (seed.length - 1)) / (live.length - 1))];
}

/** One-way: no transcript on this machine can be found from it. */
export function fakeId(id: string): string {
  const h = createHash('sha256').update(id).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const isPrState = (value: unknown): boolean => PR_STATES.some((state) => state === value);

function samplePrs(raw: unknown, n: number): Rec {
  const prs = list(raw).filter(isRecord).filter((pr) => isPrState(pr.state)).map((pr, k) => ({ url: `${FAKE_PULLS}/${PR_NUMBER.exec(str(pr.url) ?? '')?.[1] ?? n * 10 + k}`, state: pr.state }));
  return prs.length === 0 ? {} : { prs };
}

function sampleSessions(raw: unknown, map: (stage: string) => string): Rec[] {
  return list(raw).filter(isRecord).flatMap((s) => {
    const id = str(s.id);
    if (id === undefined) return [];
    const stages = list(s.stages).filter((x): x is string => typeof x === 'string').map(map);
    return [{ id: fakeId(id), ...only('startedAt', iso(s.startedAt)), ...only('lastUsedAt', iso(s.lastUsedAt)), stages, ...only('tokens', finite(s.tokens)) }];
  });
}

// #629: a task's work lives on its activity (worktree, approval, stopped, session) and on that activity's record (sessions, PRs, usage)
interface Work { task: Rec; activity: Rec; record: Rec }

const isLive = (activity: Rec): boolean => activity.kind === 'task' && typeof activity.worktree === 'string' && activity.worktreeGone !== true;

function workOf(payload: Rec): Work[] {
  const activities = list(payload.activities).filter(isRecord);
  const records = list(payload.activityRecords).filter(isRecord);
  return list(payload.tasks).filter(isRecord).flatMap((task) => {
    const itemId = isRecord(task.item) ? task.item.itemId : undefined;
    const record = records.find((r) => list(r.taskIds).includes(itemId) && activities.some((a) => a.id === r.id));
    const activity = activities.find((a) => a.id === record?.id);
    return record && activity && isLive(activity) ? [{ task, activity, record }] : [];
  });
}

// Only what the Monitor View shows: no body, link, branch, error, feedback, result or session name leaves the machine
function sampleTask({ task }: Work, n: number, o: SnapshotOptions): Rec {
  const item = isRecord(task.item) ? task.item : {};
  return {
    item: { itemId: `local:${n}`, id: `${EXPERIMENT_PREFIX}-${n}`, title: sanitizeText(str(item.title) ?? `Activity ${n}`, o), body: '', url: '' },
    stage: mapStage(o.liveStages, o.seedStages, str(task.stage) ?? ''), boardColumn: '', auto: false, created: true, workspace: WORKSPACE_NAME,
    ...only('enteredAt', iso(task.enteredAt)),
  };
}

function sampleActivity({ activity }: Work): Rec {
  const since = isRecord(activity.approval) ? iso(activity.approval.since) : undefined;
  const approval = since === undefined ? {} : { approval: { since } };
  const stopped = activity.stopped === true ? { stopped: true, ...only('stoppedAt', iso(activity.stoppedAt)) } : {};
  const sessionId = str(activity.sessionId);
  return {
    id: fakeId(str(activity.id) ?? ''), kind: 'task', workspace: WORKSPACE_NAME, worktree: WORKTREE_MARK, ...approval, ...stopped,
    ...(sessionId ? { sessionId: fakeId(sessionId) } : {}),
  };
}

function sampleRecord({ activity, record }: Work, n: number, o: SnapshotOptions): Rec {
  const map = (stage: string): string => mapStage(o.liveStages, o.seedStages, stage);
  const u = isRecord(record.usage) ? record.usage : {};
  const usage = isRecord(record.usage) ? { usage: { ...only('tokens', finite(u.tokens)), ...only('ms', finite(u.ms)), ...only('waitingMs', finite(u.waitingMs)) } } : {};
  return { id: fakeId(str(activity.id) ?? ''), taskIds: [`local:${n}`], sessions: sampleSessions(record.sessions, map), ...samplePrs(record.prs, n), ...usage };
}

/** A live State (the first /events frame) as the sample (#105, the user). */
export function sanitizeState(payload: Rec, o: SnapshotOptions): Rec {
  const work = workOf(payload).slice(0, MAX_TASKS);
  return {
    ...stateBase(), maxConcurrent: 0, localCount: work.length,
    tasks: work.map((w, i) => sampleTask(w, i + 1, o)),
    activities: work.map((w) => sampleActivity(w)),
    activityRecords: work.map((w, i) => sampleRecord(w, i + 1, o)),
  };
}

// What each scenario needs on screen: the task, its activity and its record, as the Monitor View reads them
const COVERAGE: readonly (readonly [string, (work: Work[]) => boolean])[] = [
  ['7 activities', (w) => w.length >= 7],
  ['3 stages', (w) => new Set(w.map((x) => x.task.stage)).size >= 3],
  ['an activity awaiting approval', (w) => w.some((x) => x.activity.approval !== undefined)],
  ['a stopped activity', (w) => w.some((x) => x.activity.stopped === true)],
  ['an open PR', (w) => w.some((x) => list(x.record.prs).some((p) => isRecord(p) && p.state === 'open'))],
  ['an activity with two sessions', (w) => w.some((x) => list(x.record.sessions).length >= 2)],
];

export const missingStates = (state: Rec): string[] => {
  const work = workOf(state);
  return COVERAGE.filter(([, has]) => !has(work)).map(([what]) => what);
};

/** The last guard before the repo. */
export function assertClean(text: string, o: Pick<SnapshotOptions, 'username' | 'home'>): void {
  const leaks: readonly (readonly [string, boolean])[] = [
    ['the home folder', o.home !== '' && text.includes(o.home)],
    ['a home path', HOME_ROOT.test(text)],
    ['the account name', o.username !== '' && wordOf(o.username).test(text)],
    ['a token', new RegExp(TOKEN.source).test(text)],
    ['a 64-hex secret', /\b[0-9a-f]{64}\b/i.test(text)],
  ];
  const leak = leaks.find(([, found]) => found);
  if (leak) throw new Error(`the snapshot still holds ${leak[0]}: nothing machine-specific may enter the repo`);
}
