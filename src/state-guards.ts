import { isPrUrl, isSessionId, isUuid } from './orchestrator.js';
import { PR_STATES } from './pull-requests.js';
import { cleanTitle } from './usage.js';
import { addUsage, localActivityId } from './activities.js';
import { knownAgent, savedAgent } from './agents.js';
import { savedLaunch } from './launch-pick.js';
import { FEEDBACK_MAX, isBranchName, SETUP_ROW_KINDS, SETUP_ROW_STATUSES, SLICE_DELIVERIES, type Activity, type SetupRow, type SetupRowKind, type SetupRowStatus, type ActivityRecord, type CommandFailure, type ForkSyncResult, type PrSlice, type PrState, type RunPick, type Session, type SliceDelivery, type StageCi, type StageCommands, type StageEvaluate, type StageStart, type TaskApproval, type TaskBase, type TaskPr, type TaskUsage, type TryRecord, type UsagePart, type Checkpoint, type CheckpointEnd } from './types.js';

// The validators of what state.json holds, shared by the loader and the pre-#629 migration: each keeps a value only in the shape the
// reducer writes, so a hand-edited file cannot feed it garbage.

export const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
// #248: a total, a duration or a baseline: a finite number ≥ 0. A stamp: a string Date.parse reads. Anything else reads as absent.
export const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const isDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export const SLUG = /^hive-[a-z0-9-]+$/; // what slugFor produces; the slug names a path and the prompt file

// The chosen base reaches git's argv at the next spawn (#131): kept only in the shape the popup writes, so a hand-edited file cannot
// smuggle an option or a revision expression in. Anything else drops the key and the task reads as a default-base task.
export const isTaskBase = (value: unknown): value is TaskBase =>
  typeof value === 'object' && value !== null && typeof (value as TaskBase).ref === 'string'
  && isBranchName((value as TaskBase).ref) && typeof (value as TaskBase).tellWorker === 'boolean';

export const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A task's totals (#248): kept only with all three counts; anything else reads as nothing recorded. Its parts are read apart (#617)
export const isTaskUsage = (value: unknown): value is Record<string, unknown> & Omit<TaskUsage, 'parts'> =>
  isJsonObject(value) && isCount(value.tokens) && isCount(value.ms) && isCount(value.waitingMs);

// #617: a part in the shape the reducer writes, copied field by field: a stage only as text, an agent only one AGENT_IDS has. Anything else drops the part alone
function savedPart(value: unknown): UsagePart[] {
  if (!isTaskUsage(value)) return [];
  const { stage, agent } = value;
  const known = knownAgent(agent);
  if ((stage !== undefined && typeof stage !== 'string') || (agent !== undefined && known === undefined)) return [];
  return [{ ...(typeof stage === 'string' ? { stage } : {}), ...(known === undefined ? {} : { agent: known }), tokens: value.tokens, ms: value.ms, waitingMs: value.waitingMs }];
}

// #617: what the kept parts do not cover (a usage saved before the breakdown, or a part the load dropped) reads as one part with neither
// stage nor agent, so the parts still add up to the total; nothing left over adds no line
function savedUsage(value: unknown): Pick<ActivityRecord, 'usage'> {
  if (!isTaskUsage(value)) return {};
  const { tokens, ms, waitingMs } = value;
  const parts = Array.isArray(value.parts) ? value.parts.flatMap(savedPart) : [];
  const left = (total: number, key: 'tokens' | 'ms' | 'waitingMs'): number => Math.max(0, total - parts.reduce((sum, p) => sum + p[key], 0));
  const rest = { tokens: left(tokens, 'tokens'), ms: left(ms, 'ms'), waitingMs: left(waitingMs, 'waitingMs') };
  const covered = rest.tokens === 0 && rest.ms === 0 && rest.waitingMs === 0;
  return { usage: { ...(covered ? { parts } : addUsage({ tokens: 0, ms: 0, waitingMs: 0, parts }, {}, rest)), tokens, ms, waitingMs } };
}

// #283: a starting commit reaches git's argv as Restart's target, so only a hex sha is kept.
const COMMIT = /^[0-9a-f]{7,64}$/;
export const isStageStart = (value: unknown): value is StageStart =>
  isJsonObject(value) && typeof value.stage === 'string' && typeof value.commit === 'string' && COMMIT.test(value.commit);
// #580: the stage that ended there, only as text
const savedStageStart = (value: StageStart): StageStart =>
  ({ stage: value.stage, commit: value.commit, ...(typeof value.after === 'string' ? { after: value.after } : {}) });

// #619: a checkpoint as the reducer wrote it, copied field by field; its shas reach git's argv (a diff base, a reset, a read-tree), so only hex
// shas are kept, as a stage start's. A malformed entry is dropped alone
const CHECKPOINT_ENDS: readonly CheckpointEnd[] = ['done', 'restart', 'restore'];
const isSha = (value: unknown): value is string => typeof value === 'string' && COMMIT.test(value);
const isCheckpoint = (value: unknown): value is Checkpoint =>
  isJsonObject(value) && isRunCount(value.n) && typeof value.stage === 'string' && isSha(value.start) && isSha(value.head) && isSha(value.commit)
  && typeof value.branch === 'string' && isDate(value.at) && CHECKPOINT_ENDS.includes(value.ended as CheckpointEnd);
function savedCheckpoints(value: unknown): Pick<Activity, 'checkpoints'> {
  const kept = Array.isArray(value)
    ? value.filter(isCheckpoint).map(({ n, stage, start, head, commit, branch, at, ended }): Checkpoint => ({ n, stage, start, head, commit, branch, at, ended }))
    : [];
  return kept.length > 0 ? { checkpoints: kept } : {};
}

// A task's PRs (#207): an entry is kept only as a GitHub pull request link (it reaches an href and the PR query) in one of the three
// states, copied field by field. A file from before #207 has one prUrl: read as that PR, open, and the next poll corrects its state.
const isTaskPr = (value: unknown): value is TaskPr =>
  isJsonObject(value) && typeof value.url === 'string' && isPrUrl(value.url) && PR_STATES.includes(value.state as PrState);

// #698: a slice only in the shape hive_pr's schema admits; anything else is dropped and the PR stays, a PR without a slice
const isPrSlice = (value: unknown): value is PrSlice =>
  isJsonObject(value) && Number.isInteger(value.k) && (value.k as number) >= 1 && SLICE_DELIVERIES.includes(value.type as SliceDelivery);

// #742: the times the PR poll read, each only as a date
const savedPrTimes = (pr: TaskPr): Pick<TaskPr, 'openedAt' | 'mergedAt' | 'closedAt'> => ({
  ...(isDate(pr.openedAt) ? { openedAt: pr.openedAt } : {}), ...(isDate(pr.mergedAt) ? { mergedAt: pr.mergedAt } : {}),
  ...(isDate(pr.closedAt) ? { closedAt: pr.closedAt } : {}),
});

export function savedPrs(prs: unknown, legacy: unknown): TaskPr[] {
  if (prs === undefined) return typeof legacy === 'string' && isPrUrl(legacy) ? [{ url: legacy, state: 'open' }] : [];
  return Array.isArray(prs)
    ? prs.filter(isTaskPr).map((pr) => ({ url: pr.url, state: pr.state, ...(isPrSlice(pr.slice) ? { slice: { k: pr.slice.k, type: pr.slice.type } } : {}),
      ...(isUuid(pr.sessionId) ? { sessionId: pr.sessionId } : {}), ...savedPrTimes(pr) })) // #62: only a session id's uuid shape is shown
    : [];
}

// A session id the popup offers reaches claude's argv as --resume <id> (#164): an entry is kept only in the uuid shape Claude
// Code itself writes there, not the looser isSessionId (which allows a leading `-`, so e.g. `--settings` would reach argv as an option).
// An entry from before #236 has the one `column` it started in: read as its only stage, last used when it started.
// #489: a name only as display text, through the same rule the transcript read uses.
export function savedSession(value: unknown): Session[] {
  if (typeof value !== 'object' || value === null) return [];
  const { id, startedAt, stages, lastUsedAt, column, tokens, repo, free, name, agent, launch } = value as Record<string, unknown>;
  if (!isUuid(id) || typeof startedAt !== 'string') return [];
  const title = cleanTitle(name);
  // a resume counts its first delta from tokens (#248); repo, only as true, sends the session to the main repo (#208); free, only as true,
  // keeps a session opened by hand out of every stage (#812); a name its tab shows (#489)
  const kept = {
    ...(isCount(tokens) ? { tokens } : {}), ...(repo === true ? { repo: true as const } : {}), ...(free === true ? { free: true as const } : {}),
    ...(title === undefined ? {} : { name: title }),
    ...savedLaunch(launch), // #257: a resume re-sends it to the argv: only in the routes' shape
  };
  const ran = savedAgent(agent); // #925: a session saved before it was Claude's
  if (isStringArray(stages) && typeof lastUsedAt === 'string') return [{ id, startedAt, stages, lastUsedAt, agent: ran, ...kept }];
  return typeof column === 'string' ? [{ id, startedAt, stages: [column], lastUsedAt: startedAt, agent: ran }] : [];
}

// A stage awaiting approval (#268): kept when since is a date, until only when it is one too; copied field by field.
export function savedApproval(value: unknown): { approval?: TaskApproval } {
  if (!isJsonObject(value) || !isDate(value.since)) return {};
  // #812: the free session that ended the stage reaches claude's argv as --resume <id>, as a handover's does: only its uuid shape is kept
  return { approval: { since: value.since, ...(isDate(value.until) ? { until: value.until } : {}), ...(isUuid(value.sessionId) ? { sessionId: value.sessionId } : {}) } };
}

// #134: a string the state file may hold at that length at most; a longer one was not written by the Hive. A handover's prompt carries the
// item, a rendered result (64 KB) and a feedback, so its cap is wider than a feedback's
const HANDOVER_MAX = 256 * 1024;
const isCapped = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

// #134: a transition's handover as the reducer wrote it; the session id reaches claude's argv, so only its uuid shape is kept
const savedHandover = (value: unknown): Pick<Activity, 'handover'> =>
  (isJsonObject(value) && isCapped(value.prompt, HANDOVER_MAX) && value.prompt !== ''
    ? { handover: { prompt: value.prompt, ...(isUuid(value.sessionId) ? { sessionId: value.sessionId } : {}) } } : {});

// #755: a commands stage in flight as the reducer wrote it; anything else reads as none. A failure that is not one is dropped alone
const savedFailure = (value: unknown): CommandFailure[] =>
  (isJsonObject(value) && typeof value.name === 'string' && Number.isInteger(value.code) && typeof value.output === 'string' ? [{ name: value.name, code: value.code as number, output: value.output }] : []);
function savedCommands(value: unknown): { commands?: StageCommands } {
  if (!isJsonObject(value)) return {};
  const { stage, at, ptyId, runId, failed, workerId, started } = value;
  if (typeof stage !== 'string' || !Number.isInteger(at) || typeof ptyId !== 'string' || typeof runId !== 'string' || !Array.isArray(failed) || typeof workerId !== 'string') return {};
  // #914: the starts round-trip; the boot stops the run anyway, so outputAt and skipped are never read
  return { commands: { stage, at: at as number, ptyId, runId, failed: failed.flatMap(savedFailure), workerId, started: isStringArray(started) ? started : [] } };
}

// #834: a wait for CI as the reducer wrote it, read so the wait goes on after a boot; anything else reads as none. collecting never survives a
// boot, so it is never read
function savedCi(value: unknown): { ci?: StageCi } {
  if (!isJsonObject(value)) return {};
  const { stage, since, reran, rerunAt, done, total, waitingPr, fellBack, awaiting, noRerun } = value;
  if (typeof stage !== 'string' || !isDate(since) || !isStringArray(reran)) return {};
  return {
    ci: {
      stage, since, reran, ...(isDate(rerunAt) ? { rerunAt } : {}), ...(isCount(done) ? { done } : {}), ...(isCount(total) ? { total } : {}),
      ...(waitingPr === true ? { waitingPr: true as const } : {}), ...(fellBack === true ? { fellBack: true as const } : {}),
      ...(isCount(awaiting) ? { awaiting } : {}), ...(noRerun === true ? { noRerun: true as const } : {}), // #854
    },
  };
}

// #877: an evaluation in flight as the reducer wrote it, read so the boot can stop it; anything else reads as none
const PHASES: readonly StageEvaluate['phase'][] = ['reviewing', 'judging'];
const isPhase = (value: unknown): value is StageEvaluate['phase'] => PHASES.some((p) => p === value);
function savedEvaluate(value: unknown): { evaluate?: StageEvaluate } {
  if (!isJsonObject(value)) return {};
  const { stage, runId, workerId, startedAt, phase } = value;
  if (typeof stage !== 'string' || typeof runId !== 'string' || typeof workerId !== 'string' || !isDate(startedAt) || !isPhase(phase)) return {};
  return { evaluate: { stage, runId, workerId, startedAt, phase } };
}

// An activity's work as the reducer writes it (#629), each key only in its written shape, as a task's were (#131, #208, #224, #268, #283, #692):
// what loadActivity and the pre-#629 migration both read. setup and deleting never survive a boot (#182, #351), so they are never read; a commands
// stage is read so the boot can stop it (#755), a wait for CI so it goes on (#834).
const SYNC_RESULTS: readonly ForkSyncResult['result'][] = ['synced', 'current', 'diverged', 'conflict', 'offline', 'error'];
const isSyncResult = (value: unknown): value is ForkSyncResult['result'] => SYNC_RESULTS.some((r) => r === value);

// #854: a fork sync as the spawn wrote it, kept while the activity lives; anything else reads as none
function savedSync(value: unknown): { sync?: ForkSyncResult } {
  if (!isJsonObject(value)) return {};
  const { result, mode, commits, files, reason, base, sha, at } = value;
  if (!isSyncResult(result) || (mode !== 'github' && mode !== 'local') || typeof base !== 'string' || typeof sha !== 'string' || !isDate(at)) return {};
  return {
    sync: {
      result, mode, base, sha, at,
      ...(isCount(commits) ? { commits } : {}), ...(isStringArray(files) ? { files } : {}), ...(typeof reason === 'string' ? { reason } : {}),
    },
  };
}

// #915: a try's record as take wrote it; the session id reaches claude's argv through a handover, so only its uuid shape is kept
const isTryRecord = (value: unknown): value is TryRecord =>
  isJsonObject(value) && isCapped(value.transition, FEEDBACK_MAX) && isRunCount(value.n) && isRunCount(value.max)
  && isCapped(value.cause, FEEDBACK_MAX) && isCapped(value.error, FEEDBACK_MAX) && isDate(value.at) && isCapped(value.stage, FEEDBACK_MAX);
const savedTryRecord = (r: TryRecord): TryRecord => ({
  transition: r.transition, n: r.n, max: r.max, cause: r.cause, error: r.error, at: r.at, stage: r.stage, ...(isUuid(r.sessionId) ? { sessionId: r.sessionId } : {}),
});

// #134: the tries an automatic transition took (whole counts of at least one) and the arrow the task came through, each only in that shape;
// #915: the log only for a key the tries still count, a malformed record dropped alone
function savedRouting(tries: unknown, via: unknown, tryLog: unknown): Pick<Activity, 'tries' | 'via' | 'tryLog'> {
  const counted = isJsonObject(tries) ? Object.entries(tries).filter((entry): entry is [string, number] => isRunCount(entry[1])) : [];
  const keys = new Set(counted.map(([key]) => key));
  const log = Array.isArray(tryLog) ? tryLog.filter(isTryRecord).filter((r) => keys.has(r.transition)).map(savedTryRecord) : [];
  return {
    ...(counted.length > 0 ? { tries: Object.fromEntries(counted) } : {}), ...(log.length > 0 ? { tryLog: log } : {}),
    ...(isCapped(via, FEEDBACK_MAX) ? { via } : {}),
  };
}

// #290: a manual start's picks as the start route wrote them; the occupy of the same reduction takes them off, so the state file only ever has
// one by hand. The session id reaches the argv as --resume <id>: only its uuid shape is kept, as a handover's
function savedRunPick(value: unknown): Pick<Activity, 'runPick'> {
  if (!isJsonObject(value)) return {};
  const { agent, resume, launch } = value;
  const known = knownAgent(agent);
  const runPick: RunPick = {
    ...(known === undefined ? {} : { agent: known }),
    ...(resume === null ? { resume: null } : isUuid(resume) ? { resume } : {}),
    ...savedLaunch(launch),
  };
  return Object.keys(runPick).length === 0 ? {} : { runPick };
}

// #390: one row of a failed setup as the reducer wrote it, copied field by field; texts capped, a time a date, a duration a count
const ROW_TEXTS = ['label', 'header', 'branch', 'base', 'code'] as const;
function savedRow(value: unknown): SetupRow[] {
  if (!isJsonObject(value) || !SETUP_ROW_KINDS.includes(value.kind as SetupRowKind) || !SETUP_ROW_STATUSES.includes(value.status as SetupRowStatus)) return [];
  const texts = ROW_TEXTS.filter((key) => value[key] !== undefined);
  const { startedAt, durationMs } = value;
  if (!texts.every((key) => isCapped(value[key], FEEDBACK_MAX))) return [];
  if ((startedAt !== undefined && !isDate(startedAt)) || (durationMs !== undefined && !isCount(durationMs))) return [];
  const copied = Object.fromEntries(texts.map((key) => [key, value[key]])) as Pick<SetupRow, (typeof ROW_TEXTS)[number]>;
  return [{ kind: value.kind as SetupRowKind, status: value.status as SetupRowStatus, ...copied, ...(startedAt === undefined ? {} : { startedAt }), ...(durationMs === undefined ? {} : { durationMs }) }];
}

// #390: the last failed setup, kept whole or not at all: a row dropped alone would make the dialog's bar count wrong
function savedLastSetup(value: unknown): Pick<Activity, 'lastSetup'> {
  if (!isJsonObject(value) || !isCapped(value.consoleId, FEEDBACK_MAX) || !Array.isArray(value.rows)) return {};
  const rows = value.rows.flatMap(savedRow);
  return rows.length > 0 && rows.length === value.rows.length ? { lastSetup: { consoleId: value.consoleId, rows } } : {};
}

export function savedWork(value: Record<string, unknown>): Partial<Activity> {
  const { worktree, branch, worktreeGone, local, base, sessionId, workerId, stopped, stoppedAt, stageStart, error, handover, handoffPending, handoffFeedback, tries, tryLog, via, freeSessionStage } = value;
  return {
    ...(typeof worktree === 'string' ? { worktree } : {}), ...(typeof branch === 'string' ? { branch } : {}),
    ...(worktreeGone === true ? { worktreeGone: true as const } : {}), ...(local === true ? { local: true as const } : {}),
    ...(isTaskBase(base) ? { base: { ref: base.ref, tellWorker: base.tellWorker } } : {}),
    ...(isSessionId(sessionId) ? { sessionId } : {}), ...(typeof workerId === 'string' ? { workerId } : {}),
    ...(stopped === true ? { stopped: true as const, ...(isDate(stoppedAt) ? { stoppedAt } : {}) } : {}), // #580: the time only beside its mark
    ...(isStageStart(stageStart) ? { stageStart: savedStageStart(stageStart) } : {}),
    ...(typeof error === 'string' ? { error } : {}), ...savedApproval(value.approval), ...savedHandover(handover),
    ...(isCapped(handoffPending, FEEDBACK_MAX) ? { handoffPending } : {}), // #692, #134: the waiting transition's key
    ...(isCapped(handoffFeedback, FEEDBACK_MAX) ? { handoffFeedback } : {}), // #134: the feedback it fires with
    ...(typeof freeSessionStage === 'string' ? { freeSessionStage } : {}), // #812: a stage name, only compared with task.stage
    ...savedRouting(tries, via, tryLog), // #134, #915
    ...savedCommands(value.commands), // #755: the boot stops it
    ...savedCi(value.ci), // #834: the boot keeps it
    ...savedEvaluate(value.evaluate), // #877: the boot stops it
    ...savedSync(value.sync), // #854: shown while the activity lives
    ...savedCheckpoints(value.checkpoints), // #619: listed until the activity's delete
    ...savedRunPick(value.runPick), // #290
    ...savedLastSetup(value.lastSetup), // #390
  };
}

// #742: each stage's run count, kept only as a whole count of at least one (a stage never run has no key); anything else reads as none run
const isRunCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;
function savedStageRuns(value: unknown): Pick<ActivityRecord, 'stageRuns'> {
  if (!isJsonObject(value)) return {};
  const counts = Object.entries(value).filter(([, n]) => isRunCount(n));
  return counts.length > 0 ? { stageRuns: Object.fromEntries(counts) as Record<string, number> } : {};
}

// A record's fields as a task carried them (#99, #164, #207, #248): a legacy prUrl reads as one open PR, as on a task.
export function savedRecordFields(value: Record<string, unknown>): Omit<ActivityRecord, 'id' | 'taskIds'> {
  const { slug, sessions, result, usage } = value;
  const prs = savedPrs(value.prs, value.prUrl);
  return {
    ...(typeof slug === 'string' && SLUG.test(slug) ? { slug } : {}),
    sessions: Array.isArray(sessions) ? sessions.flatMap(savedSession) : [],
    ...(isJsonObject(result) ? { result } : {}), ...(prs.length > 0 ? { prs } : {}),
    ...savedUsage(usage),
    ...savedStageRuns(value.stageRuns),
  };
}

/** A saved activity (#629): a local one only under its own workspace's id; a task's only with the uuid the reducer draws and the slug
 * slugFor writes, since both reach a path, a branch and a prompt file. */
export function loadActivity(value: unknown): Activity | undefined {
  if (!isJsonObject(value)) return undefined;
  const { id, kind, workspace, slug } = value;
  if (typeof id !== 'string' || typeof workspace !== 'string') return undefined;
  if (kind === 'local') return id === localActivityId(workspace) ? { id, kind, workspace } : undefined;
  if (kind !== 'task' || !isUuid(id) || typeof slug !== 'string' || !SLUG.test(slug)) return undefined;
  return { id, kind, workspace, slug, ...savedWork(value) };
}

/** A saved record (#629): an id, its tasks' item ids and the record's fields in their written shapes. */
export function loadRecord(value: unknown): ActivityRecord | undefined {
  if (!isJsonObject(value) || typeof value.id !== 'string' || !isStringArray(value.taskIds)) return undefined;
  return { id: value.id, taskIds: value.taskIds, ...savedRecordFields(value) };
}
