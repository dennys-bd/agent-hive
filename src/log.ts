import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { taskId, sessionsOf } from './tasks.js';
import { activityOf, activityOfWorker, isLocalActivityId, localWorkspaceOf, taskOfWorker } from './activities.js';
import { localSessionsOf } from './local-sessions.js';
import { prNumber } from './pull-requests.js';
import type { Stage, Effect, HiveEvent, Worker, State } from './types.js';

export type LogLevel = 'warn' | 'info' | 'debug'; // the threshold logLevel sets (#742: warn added)
export type RecordLevel = 'error' | LogLevel; // what a line or a record carries: error passes every threshold
export const LOG_LEVELS: readonly LogLevel[] = ['warn', 'info', 'debug'];
export const LOG_FILE = 'hive.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const MESSAGE_MAX = 1000; // chars per line: a gh stderr blob or a crafted hook name must not become one unbounded entry
const TAG_WIDTH = 5; // ERROR / WARN  / INFO  / DEBUG
const ID_WIDTH = 8; // enough of a uuid to grep for
const POLL_IDS_MAX = 20;
const LEVEL_RANK: Record<RecordLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Whether a line or a record at `level` is written under `threshold` (#742): error always is. */
export const passes = (level: RecordLevel, threshold: LogLevel): boolean => LEVEL_RANK[level] <= LEVEL_RANK[threshold];

export interface Logger {
  error(message: string): void; // file + stderr
  record(level: RecordLevel, message: string): void; // file only, at its level (#742): an events.jsonl record's text line, whose failure already had its own stderr line
  warn(message: string): void; // refused or degraded (#742): an MCP refusal, a failed poll or source action, an HTTP 4xx/5xx
  info(message: string): void; // what the Hive did
  debug(message: string): void; // what it received; written only at level debug
  setLevel(level: LogLevel): void;
}

export interface LoggerOptions {
  maxBytes?: number; // rotation threshold; tests use a small one
  stderr?: (line: string) => void; // default console.error; tests inject a spy
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const FILE_MODE = 0o600; // the log is this user's only, like the home (#202)
/** What may not reach a line of hive.log or a record (#742): controls (C0, DEL, C1 with U+0085), the line and paragraph separators and the bidi
 * controls. A run of them becomes one space: a hook name or a gh stderr blob can neither forge a second entry nor reorder the one it is in. */
export const UNSAFE_CHARS = /[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu;

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** One file in `dir`, sync appends, rotated once to `<file>.1` past `maxBytes`: hive.log's and events.jsonl's (#742). Never throws: a broken disk
 * disables the file with one stderr line, not the Hive. */
export function createAppender(dir: string, file: string, options: LoggerOptions = {}): (line: string) => void {
  const { maxBytes = LOG_MAX_BYTES, stderr = console.error } = options;
  const path = join(dir, file);
  let disabled = false;
  let size = 0;
  const disable = (err: unknown): void => {
    disabled = true;
    stderr(`${file}: ${errorMessage(err)}`);
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); // the home (#202): setup mode has no prepareHome yet, and the log is this user's only
    size = fileSize(path);
  } catch (err) {
    disable(err);
  }
  // ponytail: sync appends and no queue; a few short lines per second keep order for free. Move to a write stream if the volume ever matters.
  return (line) => {
    if (disabled) return;
    const bytes = Buffer.byteLength(line);
    try {
      // Another process may append to, or rotate, the same file (the main process, run.ts, hive login beside the daemon): the real size
      // decides, so a stale count never rotates away a .1 another process just made
      if (size + bytes > maxBytes) size = fileSize(path);
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(path, `${path}.1`); // one rotation: the previous .1 is gone
        size = 0;
      }
      appendFileSync(path, line, { mode: FILE_MODE });
      size += bytes;
    } catch (err) {
      disable(err);
    }
  };
}

/** One file per home, `<ISO> <LEVEL> <message>` per line, rotated once at `maxBytes`. A line under the level is dropped; error always passes. */
export function createLogger(dir: string, level: LogLevel = 'info', options: LoggerOptions = {}): Logger {
  const { stderr = console.error } = options;
  const append = createAppender(dir, LOG_FILE, options);
  let current = level;
  const write = (at: RecordLevel, message: string): void => {
    if (!passes(at, current)) return;
    // One entry per line, whatever the message carries: hook names come from any local process and gh stderr spans lines.
    const text = message.replace(UNSAFE_CHARS, ' ').slice(0, MESSAGE_MAX);
    append(`${new Date().toISOString()} ${at.toUpperCase().padEnd(TAG_WIDTH)} ${text}\n`);
  };
  return {
    error: (message) => {
      stderr(message); // keeps today's console.error behaviour in headless / terminal runs
      write('error', message);
    },
    record: write,
    warn: (message) => write('warn', message),
    info: (message) => write('info', message),
    debug: (message) => write('debug', message),
    setLevel: (next) => {
      current = next;
    },
  };
}

/** The first 8 characters of a uuid (a worker, run, pty or session id); `-` when the id is missing. */
export const shortId = (id?: string): string => id?.slice(0, ID_WIDTH) ?? '-';

// An activity in a line (#629): a local one whole, its id names the workspace; a task's by its short id
const act = (id: string): string => `activity=${isLocalActivityId(id) ? id : shortId(id)}`;
// A hook field the line names when present (#655): the tool, a SessionEnd's reason, a SessionStart's source. Never a payload's content.
const field = (name: string, value: string | undefined): string => (value ? ` ${name}=${value}` : '');

/** The pipeline in one token per stage: `spec(5)>dev(1)>review(0)`; the config line and the setStages event use it. */
export const describeStages = (stages: Stage[]): string => stages.map((c) => c.name).join('>');

/** A one-line summary of a reducer event: names, ids and counts, never a payload (tool_input, question, message). */
export function describeEvent(event: HiveEvent): string {
  switch (event.type) {
    case 'boot': return 'boot';
    case 'poll': return `poll source=${event.source ?? '-'} items=${event.items.length} ids=${event.items.slice(0, POLL_IDS_MAX).map((c) => c.item.id).join(',')}`;
    case 'setMax': return `setMax ${event.max}`;
    case 'setSignal': return `setSignal ${event.signal}`;
    case 'setSignals': return `setSignals onOpen=${event.signals.onOpen}`; // #727: the rows are the config's
    case 'setBudget': return `setBudget ${JSON.stringify(event.budget)}`;
    case 'setUsageRules': return `setUsageRules rules=${event.usageRules.length}`;
    case 'disableRule': return `disableRule ${event.source}≥${event.percent}${event.agent ? ` agent=${event.agent}` : ''} until=${event.until.kind === 'at' ? event.until.at : event.until.kind}`;
    case 'enableRule': return `enableRule ${event.source}≥${event.percent}${event.agent ? ` agent=${event.agent}` : ''}`;
    case 'setDeleteActivity': return `setDeleteActivity ${JSON.stringify(event.deleteActivity)}`;
    case 'setShutdownIdle': return `setShutdownIdle ${event.minutes}`;
    case 'setRateLimitWait': return `setRateLimitWait ${event.minutes}`; // #805
    case 'setDefaultAgent': return `setDefaultAgent ${event.agent}`; // #925
    case 'setApprovalMinutes': return `setApprovalMinutes ${event.minutes}`;
    case 'setShutdown': return `setShutdown ${event.armed ? 'on' : 'off'}`;
    case 'tick': return 'tick';
    case 'setStages': return `setStages ${describeStages(event.stages)}`;
    case 'setWorkspaces': {
      const defaults = Object.entries(event.sourceWorkspaces).map(([source, workspace]) => `${source}:${workspace}`).join(',');
      return `setWorkspaces ${event.workspaces.join(',')}${defaults === '' ? '' : ` defaults=${defaults}`}`;
    }
    case 'setWorkspace': return `setWorkspace #${event.taskId} ${event.workspace}`;
    case 'rateLimits': return `rateLimits agent=${event.agent} ${event.ptyId ? `pty=${shortId(event.ptyId)}` : 'source=hive'}`; // #929
    case 'pollFailed': return `pollFailed source=${event.source} ${event.message}`;
    case 'itemRead': return `itemRead source=${event.source} #${event.itemId}${event.entry ? ` column=${event.entry.column}` : ' unlisted'}`; // #686: never a title
    case 'blockerSet': return `blockerSet #${event.itemId} ${event.change.action} ${event.change.kind}=${event.change.ref}`; // #56: ids only, never a title
    case 'setSources': return `setSources ${event.sources.join(',')}`;
    case 'renameStages': return `renameStages ${Object.entries(event.renames).map(([from, to]) => `${from}→${to}`).join(',')}`; // #861
    case 'renameSources': return `renameSources ${Object.entries(event.renames).map(([from, to]) => `${from}→${to}`).join(',')}`;
    case 'sourceQuota': return `sourceQuota source=${event.source} remaining=${event.quota.remaining}/${event.quota.limit} resetsAt=${event.quota.resetsAt}`;
    case 'hook': {
      const { hook_event_name: name, tool_name: tool, reason, source } = event.payload;
      return `hook ${name} pty=${shortId(event.ptyId)}${field('tool', tool)}${field('reason', reason)}${field('source', source)}`;
    }
    case 'exit': return `exit pty=${shortId(event.ptyId)}`;
    case 'stop': return `stop pty=${shortId(event.ptyId)}${event.cause === undefined ? '' : ` cause=${event.cause}`}`;
    case 'forgetSlept': return `forgetSlept pty=${shortId(event.ptyId)}`; // #672
    case 'quit': return 'quit';
    case 'dismissCrash': return 'dismissCrash';
    case 'error': return event.message ? `error ${event.message}` : 'error';
    case 'start': return `start #${event.itemId}${event.workspace === undefined ? '' : ` workspace=${event.workspace}`}`;
    case 'continue': return `continue ${act(event.activityId)}`;
    case 'restarting': return `restarting ${act(event.activityId)}`;
    case 'restart': return `restart ${act(event.activityId)}${event.branch === undefined ? '' : ` branch=${event.branch}`}`;
    case 'stageStarted': return `stageStarted activity=${shortId(event.activityId)} stage=${event.stage} commit=${shortId(event.commit)}`;
    case 'checkpointCaptured': return `checkpointCaptured activity=${shortId(event.activityId)} n=${event.checkpoint.n} stage=${event.checkpoint.stage} ended=${event.checkpoint.ended}`; // #619: never a sha
    case 'restoring': return `restoring #${event.itemId}`;
    case 'restored': return `restored #${event.itemId}${event.branch === undefined ? '' : ` branch=${event.branch}`}`;
    case 'restoreFailed': return `restoreFailed #${event.itemId}`;
    case 'clearSessions': return `clearSessions ${act(event.activityId)} ${shortId(event.sessionId)}`;
    case 'closeTask': return `close task=#${event.taskId}`;
    case 'keepTask': return `keepTask #${event.taskId}`;
    case 'closeMissing': return `closeMissing stage=${event.stage}`;
    case 'done': return `done pty=${shortId(event.ptyId)}${event.result ? ` result=${Object.keys(event.result).join(',')}` : ''}${event.verdict === undefined ? '' : ` verdict=${event.verdict}`}`; // keys only; a verdict's name is config, the evidence is never logged (#134)
    case 'pr': return `pr pty=${shortId(event.ptyId)}`;
    case 'prStates': return `prStates ${event.states.map((s) => `#${prNumber(s.url)}=${s.state}`).join(',')}`; // numbers, never the links
    case 'ask': return `ask pty=${shortId(event.ptyId)}`; // the question is the worker's text: never logged
    case 'spawnFailed': return `spawnFailed pty=${shortId(event.ptyId)} ${event.message.split('\n')[0]}`; // a failed setup's output tail follows the first line: never logged (#299)
    case 'createActivity': return `createActivity #${event.taskId}`; // #629
    case 'setupStarted': return `setupStarted activity=${shortId(event.activityId)}`; // #351
    case 'setupStep': return `setupStep activity=${shortId(event.activityId)}`; // runSetup logs the step itself (#299)
    case 'setupEnded': return `setupEnded activity=${shortId(event.activityId)}${event.error === undefined ? '' : ' failed'}`; // the error carries the output tail: never logged (#351)
    case 'activityDeleted': return `activityDeleted activity=${shortId(event.activityId)}`;
    case 'deleteActivityFailed': return `deleteActivityFailed activity=${shortId(event.activityId)}: ${event.message.split('\n')[0]}`; // a failed teardown's output tail follows the first line: never logged (#654)
    case 'stageCommandEnded': return `stageCommandEnded activity=${shortId(event.activityId)} pty=${shortId(event.ptyId)} code=${event.code}`; // #755: the output is the command's: never logged
    case 'stageCommandStarted': return `stageCommandStarted activity=${shortId(event.activityId)} pty=${shortId(event.ptyId)}${event.skipped ? ' skipped' : ''}`; // #914
    case 'stageCommandOutput': return `stageCommandOutput activity=${shortId(event.activityId)} pty=${shortId(event.ptyId)}`; // #914: never the output
    case 'stageCommandsRefused': return `stageCommandsRefused activity=${shortId(event.activityId)}: ${event.message.split('\n')[0]}`; // #755: the first line only
    case 'ciClock': return `ciClock activity=${shortId(event.activityId)}`; // #834
    case 'ciRead': return `ciRead activity=${shortId(event.activityId)} prs=${event.prs.map((p) => `#${prNumber(p.url)}`).join(',') || '-'}`; // #834: numbers, never the links
    case 'ciFailed': return `ciFailed activity=${shortId(event.activityId)} failed=${event.names.join(',')}`; // #834: the names only, never the output
    case 'stopCi': return `stopCi activity=${shortId(event.activityId)}`; // #834
    case 'decompositionIssue': return `decompositionIssue #${event.taskId} ${event.id}=#${event.number}`; // #865: never a title
    case 'forkSynced': return `forkSynced activity=${shortId(event.activityId)} ${event.sync.mode} ${event.sync.result}`; // #854: never the reason, git's or gh's words
    case 'sourceActionFailed': return `sourceActionFailed #${event.taskId}: ${event.message}`;
    case 'worktreeGone': return `worktreeGone activity=${shortId(event.activityId)}`;
    case 'deletingActivity': return `deletingActivity ${act(event.activityId)}`;
    case 'activityRemoved': return `activityRemoved ${act(event.activityId)}`;
    case 'activityKept': return `activityKept ${act(event.activityId)}`;
    case 'deletingTask': return `deletingTask #${event.taskId}`;
    case 'taskDeleted': return `taskDeleted #${event.taskId}`;
    case 'moveTask': return `moveTask #${event.taskId} before=${event.before === undefined ? 'end' : `#${event.before}`}`;
    case 'resetOrder': return `resetOrder stage=${event.stage}`;
    case 'createTask': return `createTask stage=${event.stage} prefix=${event.prefix}${event.pr === undefined ? '' : ' pr=yes'}`; // the title is the user's text and the link a third party's: never logged
    case 'setAuto': return `setAuto #${event.taskId} ${event.auto}`;
    case 'openSession': return `openSession ${act(event.activityId)}${event.continueId === undefined ? '' : ` continue=${shortId(event.continueId)}`}`;
    case 'openTerminal': return `openTerminal ${act(event.activityId)}`; // the command's name reaches only the spawn's line (#300)
    case 'copySession': { // never the name nor the notice: the user's words; never the dir: it holds the home path
      const { from, to, notice, copied } = event;
      return `copySession ${act(from.activityId)} ${shortId(from.sessionId)} → ${act(to.activityId)}${notice === undefined ? '' : ' notice'}${copied === undefined ? '' : ' copied'}`;
    }
    case 'openLocalSession': return `openLocalSession ${act(event.activityId)} ${shortId(event.sessionId)}`;
    case 'clearLocalSession': return `clearLocalSession ${act(event.activityId)} ${shortId(event.sessionId)}`;
    case 'newLocalSession': return `newLocalSession ${act(event.activityId)}`; // #590
    case 'openProjectShell': return `openProjectShell project=${event.project}`; // #292
    case 'sleepTerminal': return `sleepTerminal pty=${shortId(event.terminalId)}${event.cwd === undefined ? '' : ' cwd'}`; // never the path: it holds the home (#696)
    case 'wakeTerminal': return `wakeTerminal pty=${shortId(event.terminalId)}`;
    case 'forgetTerminal': return `forgetTerminal pty=${shortId(event.terminalId)}`;
    case 'captureSession': return `captureSession pty=${shortId(event.terminalId)} run=${shortId(event.runId)}`; // #696
    case 'worktreeReady': return `worktreeReady activity=${shortId(event.activityId)} branch=${event.branch}`;
    case 'moveToStage': return `moveToStage #${event.taskId} stage=${event.stage}`;
    case 'approve': return `approve ${act(event.activityId)}`;
    case 'feedback': return `feedback ${act(event.activityId)} ${event.start ? 'start' : 'queue'} chars=${event.text.length}`; // the text is the user's: never logged
    case 'extendApproval': return `extendApproval ${act(event.activityId)}`;
    case 'approvalExpired': return `approvalExpired pty=${shortId(event.ptyId)}`;
    case 'retryDue': return `retryDue pty=${shortId(event.ptyId)} until=${event.until}`; // #805
    case 'retry': return `retry #${event.taskId}`; // #915
  }
}

// A terminal's line: its task (#283), or its workspace when it runs on a main checkout (#292); a run command by its name only, never the line nor the env (#300).
function describeTerminal({ terminal, activity, task }: Extract<Effect, { type: 'spawnTerminal' }>): string {
  const owner = task ? `#${task.item.id} slug=${activity.slug ?? '-'}` : `workspace=${localWorkspaceOf(terminal.activityId) ?? '-'}`;
  return `spawnTerminal ${owner} pty=${shortId(terminal.terminalId)}${terminal.command === undefined ? '' : ` command=${JSON.stringify(terminal.command)}`}`;
}

export function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case 'spawn': {
      const { worker, activity, task, stage, session, run, prompt } = effect;
      return `spawn worker=${shortId(worker.id)} #${task.item.id} slug=${activity.slug ?? '-'} stage=${stage.name} session=${session} pty=${shortId(worker.runId)}${run === 'continue' ? ' run=continue' : ''}${prompt === undefined ? '' : ' handover'}`;
    }
    case 'setColumn': return `setColumn #${effect.itemId} → ${effect.column}`;
    case 'sourceAction': return `sourceAction #${effect.itemId} ${effect.action.type}`;
    case 'kill': return `kill slug=${effect.slug} pty=${shortId(effect.ptyId)}`;
    case 'captureCheckpoint': return `captureCheckpoint #${effect.task.item.id} slug=${effect.activity.slug ?? '-'} stage=${effect.stage}`;
    case 'continue': return `continue stage=${effect.stage.name} pty=${shortId(effect.ptyId)}${effect.prompt === undefined ? '' : ' handover'}`; // never the text (#268, #134)
    case 'hold': return `hold pty=${shortId(effect.ptyId)} until=${effect.until}`;
    case 'release': return `release pty=${shortId(effect.ptyId)}`;
    case 'input': return `input pty=${shortId(effect.ptyId)}`; // never the text: a user's feedback (#483) or a retry's continue (#805)
    case 'deleteActivity': return `deleteActivity #${effect.task.item.id} slug=${effect.activity.slug ?? '-'}`;
    case 'stageCommand': { // #755: the command's name, never its line nor its env
      const names = effect.stage.commands ?? [];
      return `stageCommand #${effect.task.item.id} stage=${JSON.stringify(effect.stage.name)} command=${JSON.stringify(names[effect.at] ?? '')} ${effect.at + 1}/${names.length} pty=${shortId(effect.ptyId)}`;
    }
    case 'ciRead': return `ciRead activity=${shortId(effect.activityId)}`; // #834
    case 'ciRerun': return `ciRerun activity=${shortId(effect.activityId)} runs=${effect.runs.map((r) => r.runId).join(',')}`;
    case 'ciCollect': return `ciCollect activity=${shortId(effect.activityId)} failed=${effect.failed.map((c) => c.name).join(',')}`;
    case 'shutdown': return 'shutdown';
    case 'spawnTerminal': return describeTerminal(effect);
    case 'spawnSession': {
      const { worker, activity, task, continues, copy } = effect;
      const owner = task ? `#${task.item.id} slug=${activity.slug ?? '-'}` : `workspace=${activity.workspace}`;
      return `spawnSession worker=${shortId(worker.id)} ${owner} session=${copy ? 'copy' : continues ? 'continue' : 'new'} pty=${shortId(worker.runId)}`;
    }
    case 'dropCopiedTranscript': return `dropCopiedTranscript ${shortId(effect.sessionId)}`; // never the dir: it holds the home path
    case 'forgetScrollback': return `forgetScrollback pty=${shortId(effect.ptyId)}`; // #672
    case 'readCwd': return `readCwd pty=${shortId(effect.terminalId)}`; // #696
    case 'dropTerminalFiles': return `dropTerminalFiles pty=${shortId(effect.terminalId)}`;
    case 'killCaptured': return `killCaptured pty=${shortId(effect.ptyId)}`; // #696: never the session id: it is in claude's argv only
  }
}

// The workspace of a local session's worker (#590): its activity is the workspace's local one (#629)
const localOf = (state: State, worker: Worker): string | undefined => {
  const activity = activityOfWorker(state, worker);
  return activity?.kind === 'local' ? activity.workspace : undefined;
};

const workerDetail = (state: State, worker: Worker): string => {
  const task = taskOfWorker(state, worker);
  const local = localOf(state, worker);
  const owner = task ? ` #${task.item.id}` : local === undefined ? '' : ` workspace=${local}`; // a local session has no task (#590)
  return `${owner}${worker.runId ? ` pty=${shortId(worker.runId)}` : ''}`;
};

// A task's own transitions, matched by item id: the worktree vanished from disk, the auto switch flipped, or its worktree became ready (#164,
// only when no automatic worker holds the task: a SessionStart already has its own line). A move is task.moved in events.jsonl (#742).
const taskLines = (prev: State, next: State): string[] => {
  const before = new Map(prev.tasks.map((c) => [taskId(c), c]));
  return next.tasks.flatMap((task) => {
    const old = before.get(taskId(task));
    if (!old) return [];
    const id = task.item.id;
    const [was, is] = [activityOf(prev, taskId(task)), activityOf(next, taskId(task))]; // the worktree fields live on the activity (#629)
    return [
      ...((was?.worktree !== undefined && is?.worktree === undefined && was.workerId === is?.workerId) || (is?.worktreeGone && !was?.worktreeGone) ? [`task #${id}: worktree gone`] : []), // #208: the mark keeps the path
      ...(!task.auto && old.auto ? [`task #${id}: auto off`] : []),
      ...(task.auto && !old.auto ? [`task #${id}: auto on`] : []),
      ...(was?.worktree === undefined && is?.worktree !== undefined && is.workerId === undefined ? [`task #${id}: worktree ready (${is.branch ?? '-'})`] : []),
    ];
  });
};

/** Worker transitions between two states: one line per worker whose status changed, in grid order, matched by id; then the sessions that appeared; then the task lines (worktree gone, auto switch, worktree ready). The signal and a move are events.jsonl's (#742). */
export function describeChanges(prev: State, next: State): string[] {
  // A worker missing from prev appeared in this reduce: empty (setMax: no line) or already occupied (a start over the cap: one line).
  const before = (worker: Worker): Worker => prev.workers.find((s) => s.id === worker.id) ?? { id: worker.id, status: 'empty' };
  const statuses = next.workers.flatMap((worker, i) => {
    const old = before(worker);
    if (old.status === worker.status) return [];
    const detail = workerDetail(worker.status === 'empty' ? prev : next, worker.status === 'empty' ? old : worker); // an emptied worker names what it held
    return [`worker ${i + 1}: ${old.status} → ${worker.status}${detail}`];
  });
  // The worker is wiped on exit / boot; this line is what ties a PR (same pty=) back to a `claude --resume` id afterwards
  const sessions = next.workers.flatMap((worker, i) =>
    worker.sessionId && !before(worker).sessionId ? [`worker ${i + 1}: session=${worker.sessionId}${workerDetail(next, worker)}`] : []);
  // A free session (#164, #283), one line per new worker in a free session: continue when the task already listed its session id before this reduce
  const freeSessions = next.workers.flatMap((worker, i) => {
    if (!worker.freeSession || before(worker).runId === worker.runId) return [];
    const task = taskOfWorker(next, worker);
    const old = task && prev.tasks.find((c) => taskId(c) === taskId(task));
    const local = localOf(next, worker);
    const known = local === undefined ? (old ? sessionsOf(prev, taskId(old)) : []) : localSessionsOf(prev, local); // a local session is kept by its workspace (#590)
    const kind = known.some((s) => s.id === worker.sessionId) ? 'continue' : 'new';
    return [`worker ${i + 1}: free session ${kind} on ${local === undefined ? `#${task?.item.id ?? '-'}` : `workspace=${local}`}`];
  });
  return [...statuses, ...sessions, ...freeSessions, ...taskLines(prev, next)];
}
