import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, SIGNALS } from '../src/orchestrator.js';
import { SIGNALS_DEFAULTS, type Signal, type SignalOnOpen } from '../src/types.js';
import { localSessionsOf } from '../src/local-sessions.js';
import type { Activity, Session, State, Terminal, Worker } from '../src/types.js';
import { closeTerminals } from '../src/runs.js';
import { liveRuns, stageSession, startMode } from '../src/task-runs.js';
import { sessionsOf } from '../src/tasks.js';
import { activityOf, localActivityId } from '../src/activities.js';
import { activityIdOf, withLocal, withWork, workId } from './fixtures/work.js';

// A workspace's local activity (#590): a new claude session in its checkout, kept as a local session (#587) from its start.
const SESSION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PAST = '2026-09-28T10:00:00.000Z';
const kept: Session = { id: SESSION, startedAt: PAST, stages: [], agent: 'claude' as const, lastUsedAt: PAST, tokens: 900 };
// The one worker busy under red: a local session opens past the signal and the cap, as the user's own sessions do (#459)
const red = (): State => withLocal({
  ...initialState(1), signal: 'red', workspaces: ['hive'],
  workers: [{ id: 's0', status: 'working', activityId: activityIdOf('board:item1'), runId: 'aaaaaaaa-0000-4000-8000-000000000000' }],
}, 'hive', [kept]);
const localWorkers = (state: State): Worker[] => state.workers.filter((s) => s.activityId === localActivityId('hive'));

test('newLocalSession appends a free session holding the workspace and no task, past red and a full cap, keeps the new session last and spawns it new (#590)', () => {
  const { state, effects } = reduce(red(), { type: 'newLocalSession', activityId: localActivityId('hive') });
  const [worker] = localWorkers(state);
  assert.deepEqual([worker.activityId, worker.freeSession, worker.status, state.workers.length], [localActivityId('hive'), true, 'working', 2]); // #629: the local activity is its only owner
  assert.notEqual(worker.sessionId, SESSION, 'a new session');
  assert.deepEqual(effects, [{ type: 'spawnSession', worker, activity: { id: localActivityId('hive'), kind: 'local', workspace: 'hive' }, sessionId: worker.sessionId, continues: false }]); // #629: the local activity
  assert.deepEqual(localSessionsOf(state, 'hive'), [kept, { id: worker.sessionId, startedAt: worker.startedAt, stages: [], agent: 'claude', lastUsedAt: worker.startedAt }]);
});

test('newLocalSession opens nothing for a workspace the Comb does not have; a spawn that fails forgets the entry it appended (#590)', () => {
  const start = red();
  assert.equal(reduce(start, { type: 'newLocalSession', activityId: localActivityId('nope') }).state, start);
  const opened = reduce(start, { type: 'newLocalSession', activityId: localActivityId('hive') }).state;
  const [worker] = localWorkers(opened);
  const failed = reduce(opened, { type: 'spawnFailed', ptyId: worker.runId ?? '', message: 'no claude' }).state;
  assert.deepEqual(localSessionsOf(failed, 'hive'), [kept]);
});

const WORKTREE = '/repo/.hive/worktrees/hive-1-t';
const ITEM = { itemId: 'board:I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
// One task under red, its activity with its worktree unless `live` says otherwise (#629): a terminal needs no worker and no signal
const onTask = (live: Partial<Activity> = {}): State => withWork({
  ...initialState(1), signal: 'red', workspaces: ['hive'],
  tasks: [{ item: ITEM, stage: 'spec', boardColumn: 'Ready', auto: true }],
}, ITEM.itemId, { slug: 'hive-1-t', worktree: WORKTREE, ...live });

test('openTerminal opens a Terminal on a task whose worktree is there, past red and with no worker, and emits spawnTerminal; no worktree, one gone from disk or an unknown task change nothing (#283, #570)', () => {
  const start = onTask();
  const { state, effects } = reduce(start, { type: 'openTerminal', activityId: workId(start, 'board:I1'), command: 'Run Frontend' });
  const [terminal] = state.terminals;
  assert.deepEqual(terminal, { terminalId: terminal.terminalId, activityId: activityOf(state, 'board:I1')?.id, startedAt: terminal.startedAt, command: 'Run Frontend', cwd: WORKTREE }); // #629: the task's activity; #696: it starts in the worktree
  assert.deepEqual(effects, [{ type: 'spawnTerminal', terminal, activity: activityOf(state, 'board:I1'), task: state.tasks[0] }]);
  assert.equal(state.workers, start.workers, 'no worker, no cap');
  const refused: [State, string][] = [[onTask({ worktree: undefined }), 'no worktree'], [onTask({ worktreeGone: true }), 'gone from disk (#208)']];
  for (const [s, why] of refused) assert.equal(reduce(s, { type: 'openTerminal', activityId: workId(s, 'board:I1') }).state, s, why);
  assert.equal(reduce(start, { type: 'openTerminal', activityId: workId(start, 'nope') }).state, start, 'unknown task');
});

test('openProjectShell keeps the checkout it was given as the terminal\'s cwd, where it starts and wakes (#696)', () => {
  const start = withLocal({ ...initialState(1), workspaces: ['hive'] }, 'hive', []);
  const [terminal] = reduce(start, { type: 'openProjectShell', project: 'hive', cwd: '/repo' }).state.terminals;
  assert.equal(terminal.cwd, '/repo');
});

const SHELL_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const LIVE_ID = 'dddddddd-0000-4000-8000-000000000001';
// A task's plain terminal in its worktree (#696)
const withShell = (patch: Partial<Terminal> = {}): State => {
  const start = onTask();
  const terminal: Terminal = { terminalId: SHELL_ID, activityId: workId(start, ITEM.itemId), startedAt: PAST, cwd: WORKTREE, ...patch };
  return { ...start, terminals: [terminal] };
};

test('stop on a terminal reads its cwd first; sleepTerminal marks it asleep on the cwd read and kills its pty; a command run is still killed and dropped on its exit (#696)', () => {
  const start = withShell();
  assert.deepEqual(reduce(start, { type: 'stop', ptyId: SHELL_ID }).effects, [{ type: 'readCwd', terminalId: SHELL_ID }]);
  const { state, effects } = reduce(start, { type: 'sleepTerminal', terminalId: SHELL_ID, cwd: '/repo/src' });
  assert.deepEqual(state.terminals, [{ ...start.terminals[0], cwd: '/repo/src', asleep: true }]);
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-t', ptyId: SHELL_ID }]);
  assert.deepEqual(reduce(state, { type: 'stop', ptyId: SHELL_ID }).effects, [], 'a sleeping terminal has nothing to stop');
  assert.equal(reduce(state, { type: 'sleepTerminal', terminalId: SHELL_ID }).state, state, 'already asleep');
  const command = withShell({ command: 'Run Frontend' });
  assert.deepEqual(reduce(command, { type: 'stop', ptyId: SHELL_ID }).effects, [{ type: 'kill', slug: 'hive-1-t', ptyId: SHELL_ID }]);
  assert.deepEqual(reduce(command, { type: 'exit', ptyId: SHELL_ID }).state.terminals, []);
});

test('a shell that exits by itself sleeps its terminal on the cwd it held; the exit after a sleep changes nothing (#696)', () => {
  const start = withShell();
  const asleep = reduce(start, { type: 'exit', ptyId: SHELL_ID }).state;
  assert.deepEqual(asleep.terminals, [{ ...start.terminals[0], asleep: true }]);
  assert.equal(reduce(asleep, { type: 'exit', ptyId: SHELL_ID }).state, asleep);
});

test('boot keeps every plain terminal asleep, after a Quit and after a crash, and drops a command run (#696)', () => {
  const live = withShell();
  const command: Terminal = { ...live.terminals[0], terminalId: LIVE_ID, command: 'Run Frontend' };
  const start: State = { ...live, terminals: [...live.terminals, command] };
  assert.deepEqual(reduce({ ...start, cleanStop: true }, { type: 'boot' }).state.terminals, [{ ...live.terminals[0], asleep: true }], 'after a Quit');
  assert.deepEqual(reduce(start, { type: 'boot' }).state.terminals, [{ ...live.terminals[0], asleep: true }], 'after a crash');
});

test('wakeTerminal wakes a sleeping terminal in its own id on the cwd it held; a live one, a worktree gone from disk or an unknown id wake nothing (#696)', () => {
  const asleep = withShell({ cwd: '/repo/src', asleep: true });
  const { state, effects } = reduce(asleep, { type: 'wakeTerminal', terminalId: SHELL_ID });
  const [terminal] = state.terminals;
  assert.deepEqual(terminal, { terminalId: SHELL_ID, activityId: asleep.terminals[0].activityId, startedAt: PAST, cwd: '/repo/src', woken: true }, 'marked woken: a failed spawn now sleeps it again');
  assert.deepEqual(effects, [{ type: 'spawnTerminal', terminal, activity: activityOf(state, ITEM.itemId), task: state.tasks[0] }]);
  assert.deepEqual(reduce(withShell(), { type: 'wakeTerminal', terminalId: SHELL_ID }).effects, [], 'already live');
  const gone: State = { ...asleep, activities: asleep.activities.map((a) => ({ ...a, worktreeGone: true as const })) };
  assert.equal(reduce(gone, { type: 'wakeTerminal', terminalId: SHELL_ID }).state, gone, 'its worktree is gone from disk');
  assert.equal(reduce(asleep, { type: 'wakeTerminal', terminalId: 'nope' }).state, asleep);
});

test('forgetTerminal drops a sleeping terminal and its files, never a live one; closing the task\'s terminals drops every one, killing the live one (#696)', () => {
  const asleep = withShell({ asleep: true });
  const { state, effects } = reduce(asleep, { type: 'forgetTerminal', terminalId: SHELL_ID });
  assert.deepEqual([state.terminals, effects], [[], [{ type: 'dropTerminalFiles', terminalId: SHELL_ID }]]);
  const live = withShell();
  assert.equal(reduce(live, { type: 'forgetTerminal', terminalId: SHELL_ID }).state, live);
  const both: State = { ...asleep, terminals: [...asleep.terminals, { ...live.terminals[0], terminalId: LIVE_ID }] };
  const closed = closeTerminals(both, both.tasks[0]);
  assert.deepEqual(closed.state.terminals, []);
  assert.deepEqual(closed.effects, [
    { type: 'dropTerminalFiles', terminalId: SHELL_ID }, { type: 'kill', slug: 'hive-1-t', ptyId: LIVE_ID }, { type: 'dropTerminalFiles', terminalId: LIVE_ID },
  ]);
});

test('a sleeping terminal is no live run, and a live one keeps its number among the kept ones (#696)', () => {
  const asleep = withShell({ asleep: true });
  const { asleep: _asleep, ...awake } = asleep.terminals[0];
  const both: State = { ...asleep, terminals: [asleep.terminals[0], { ...awake, terminalId: LIVE_ID }] };
  assert.deepEqual(liveRuns(both.tasks[0], both), [{ ptyId: LIVE_ID, label: 'Terminal 2', kind: 'terminal' }]);
});

test('captureSession adds a free session holding the terminal and a new session of the task; Stop kills that claude by its run\'s MCP config path; the terminal sleeping or closing ends its run (#696)', () => {
  const start = withShell();
  const RUN = 'eeeeeeee-0000-4000-8000-000000000001';
  const SESSION_ID = 'ffffffff-0000-4000-8000-000000000001';
  const { state, effects } = reduce(start, { type: 'captureSession', terminalId: SHELL_ID, runId: RUN, sessionId: SESSION_ID });
  const worker = state.workers.find((w) => w.runId === RUN);
  assert.deepEqual([worker?.terminalId, worker?.freeSession, worker?.sessionId, worker?.activityId, effects], [SHELL_ID, true, SESSION_ID, workId(start, ITEM.itemId), []]);
  assert.ok(sessionsOf(state, ITEM.itemId).some((s) => s.id === SESSION_ID), 'the task keeps the session');
  assert.deepEqual(reduce(state, { type: 'stop', ptyId: RUN, cause: 'manual' }).effects, [{ type: 'killCaptured', ptyId: RUN }]);
  assert.equal(reduce(state, { type: 'sleepTerminal', terminalId: SHELL_ID }).state.workers.some((w) => w.runId === RUN), false, 'its claude died with the shell');
  assert.equal(closeTerminals(state, state.tasks[0]).state.workers.some((w) => w.runId === RUN), false, 'and with a deleted activity');
  const refused = withShell({ asleep: true });
  assert.equal(reduce(refused, { type: 'captureSession', terminalId: SHELL_ID, runId: RUN, sessionId: SESSION_ID }).state, refused, 'a sleeping terminal captures nothing');
});

test('a terminal whose activity went (its workspace removed, its task gone) leaves with it: a live one killed, every plain one\'s files dropped (#696)', () => {
  const local = red();
  const live: Terminal = { terminalId: LIVE_ID, activityId: localActivityId('hive'), startedAt: PAST, cwd: '/repo' };
  const asleep: Terminal = { ...live, terminalId: SHELL_ID, asleep: true };
  const removed = reduce({ ...local, terminals: [live, asleep] }, { type: 'setWorkspaces', workspaces: [], sourceWorkspaces: {}, commands: {} });
  assert.deepEqual(removed.state.terminals, []);
  assert.deepEqual(removed.effects.filter((e) => e.type === 'kill' || e.type === 'dropTerminalFiles'), [
    { type: 'kill', slug: 'workspace', ptyId: LIVE_ID }, { type: 'dropTerminalFiles', terminalId: LIVE_ID }, { type: 'dropTerminalFiles', terminalId: SHELL_ID },
  ]);
  const shell = withShell({ asleep: true });
  const orphaned = { ...shell, tasks: [], activities: shell.activities.map((a) => ({ ...a, worktreeGone: true as const })) }; // #861: a task activity with a worktree on disk is kept, so this one's is gone
  const gone = reduce(orphaned, { type: 'setMax', max: 1 });
  assert.deepEqual([gone.state.activities, gone.state.terminals, gone.effects], [[], [], [{ type: 'dropTerminalFiles', terminalId: SHELL_ID }]]);
});

test('a kept activity (its task gone, its worktree on disk) keeps no terminal: a live one killed, its files dropped, the activity stays (#861)', () => {
  const shell = withShell({});
  const kept = reduce({ ...shell, tasks: [] }, { type: 'setMax', max: 1 });
  assert.equal(kept.state.activities.length, shell.activities.length);
  assert.deepEqual(kept.state.terminals, []);
  assert.deepEqual(kept.effects.filter((e) => e.type === 'kill' || e.type === 'dropTerminalFiles').map((e) => e.type), ['kill', 'dropTerminalFiles']);
});

test('boot opens on signals.onOpen: yellow, green or the saved signal under last; a saved red always opens red (#727)', () => {
  const booted = (signal: Signal, onOpen: SignalOnOpen): Signal =>
    reduce({ ...initialState(1), signal, signals: { ...SIGNALS_DEFAULTS, onOpen } }, { type: 'boot' }).state.signal;
  assert.deepEqual(SIGNALS.map((s) => booted(s, 'yellow')), ['yellow', 'yellow', 'red']);
  assert.deepEqual(SIGNALS.map((s) => booted(s, 'green')), ['green', 'green', 'red']);
  assert.deepEqual(SIGNALS.map((s) => booted(s, 'last')), ['green', 'yellow', 'red']);
});

test('openTerminal starts in the event\'s cwd when the shell route gave one, else in the worktree (#818)', () => {
  const start = onTask();
  const { state, effects } = reduce(start, { type: 'openTerminal', activityId: workId(start, 'board:I1'), cwd: `${WORKTREE}/src` });
  const [terminal] = state.terminals;
  assert.equal(terminal.cwd, `${WORKTREE}/src`);
  assert.deepEqual(effects, [{ type: 'spawnTerminal', terminal, activity: activityOf(state, 'board:I1'), task: state.tasks[0] }]);
  assert.equal(reduce(start, { type: 'openTerminal', activityId: workId(start, 'board:I1') }).state.terminals[0].cwd, WORKTREE);
});

// #812: task 1 in `stage`, its worktree there, and a stage run's session from spec in its record; under red nothing fills on an exit
const STAGE_RUN = 'cccccccc-0000-4000-8000-000000000001';
const SPEC_RUN: Session = { id: STAGE_RUN, startedAt: PAST, stages: ['spec'], agent: 'claude' as const, lastUsedAt: PAST };
const ranSpec = (stage: string): State => withWork({
  ...initialState(1), signal: 'red', workspaces: ['hive'],
  stages: [{ name: 'spec', from: {}, prompt: 'x' }, { name: 'plan', from: {}, prompt: 'x' }, { name: 'dev', from: {}, prompt: 'x' }],
  tasks: [{ item: ITEM, stage, boardColumn: 'Ready', auto: true }],
}, ITEM.itemId, { slug: 'hive-1-t', worktree: WORKTREE, sessionId: STAGE_RUN }, { sessions: [SPEC_RUN] });
const freeRun = (state: State): Worker => state.workers.find((w) => w.freeSession)!;
const exited = (state: State): State => reduce(state, { type: 'exit', ptyId: freeRun(state).runId! }).state; // the user stopped it
const opens = (state: State, continueId?: string): State =>
  reduce(state, { type: 'openSession', activityId: workId(state, ITEM.itemId), ...(continueId === undefined ? {} : { continueId }) }).state;

test('openSession with no continueId appends a free session with no stage: stopped, a stage that never ran still offers start, and a stage that ran keeps its stage run\'s session (#812)', () => {
  const opened = opens(ranSpec('plan'));
  const worker = freeRun(opened);
  assert.deepEqual(sessionsOf(opened, ITEM.itemId), [SPEC_RUN, { id: worker.sessionId, startedAt: worker.startedAt, stages: [], agent: 'claude', lastUsedAt: worker.startedAt, free: true }]);
  const stopped = exited(opened);
  assert.equal(startMode(stopped.tasks[0], stopped), 'start', 'plan never ran: the free session is no stage run');
  const inSpec = exited(opens(ranSpec('spec')));
  assert.equal(stageSession(inSpec.tasks[0], inSpec, 'spec')?.id, STAGE_RUN, 'the later free session is not the stage\'s');
});

test('openSession resuming a stage run\'s session in a later stage only moves its lastUsedAt: no stage appended, no free mark, and that stage still offers start (#812)', () => {
  const opened = opens(ranSpec('plan'), STAGE_RUN);
  assert.deepEqual(sessionsOf(opened, ITEM.itemId), [{ ...SPEC_RUN, lastUsedAt: freeRun(opened).startedAt }]);
  const stopped = exited(opened);
  assert.equal(startMode(stopped.tasks[0], stopped), 'start');
});

test('stageStarted keeps `after` as the stage run\'s stage when a free session was used since: its empty stages are skipped (#812, #580)', () => {
  const opened = exited(opens(ranSpec('plan'))); // used in plan, after spec's run
  const inDev: State = { ...opened, tasks: opened.tasks.map((c) => ({ ...c, stage: 'dev' })) };
  const started = reduce(inDev, { type: 'stageStarted', activityId: workId(inDev, ITEM.itemId), stage: 'dev', commit: 'a1b2c3d' }).state;
  assert.deepEqual(activityOf(started, ITEM.itemId)?.stageStart, { stage: 'dev', commit: 'a1b2c3d', after: 'spec' });
});

test('hive_done in a free session hands a `previous` transition that session, the run that ended the stage, though it ran no stage (#812, #134)', () => {
  const start: State = { ...ranSpec('spec'), transitions: [{ from: 'spec', to: 'plan', when: 'done', session: 'previous' }] };
  const opened = opens(start);
  const own = freeRun(opened);
  const done = reduce(opened, { type: 'done', ptyId: own.runId! }).state;
  assert.deepEqual([done.tasks[0].stage, activityOf(done, ITEM.itemId)?.handover?.sessionId], ['plan', own.sessionId]);
});

test('captureSession on a task appends a free session with no stage: the task still offers start (#812, #696)', () => {
  const start = ranSpec('plan');
  const shell: Terminal = { terminalId: SHELL_ID, activityId: workId(start, ITEM.itemId), startedAt: PAST, cwd: WORKTREE };
  const SESSION_ID = 'ffffffff-0000-4000-8000-000000000002';
  const captured = reduce({ ...start, terminals: [shell] }, { type: 'captureSession', terminalId: SHELL_ID, runId: 'eeeeeeee-0000-4000-8000-000000000002', sessionId: SESSION_ID }).state;
  const at = freeRun(captured).startedAt;
  assert.deepEqual(sessionsOf(captured, ITEM.itemId).at(-1), { id: SESSION_ID, startedAt: at, stages: [], agent: 'claude', lastUsedAt: at, free: true });
  assert.equal(startMode(captured.tasks[0], captured), 'start', 'its run holds no stage session either');
});

test('a free run marks its stage: no continue there, start or restart instead, and the reducer refuses continue too; a stage run\'s spawn or a move drops the mark (#812)', () => {
  const opened = exited(opens(ranSpec('spec')));
  assert.equal(activityOf(opened, ITEM.itemId)?.freeSessionStage, 'spec');
  assert.equal(startMode(opened.tasks[0], opened), 'start', 'no start recorded: no restart either');
  const recorded = reduce(opened, { type: 'stageStarted', activityId: workId(opened, ITEM.itemId), stage: 'spec', commit: 'a1b2c3d' }).state;
  assert.deepEqual(startMode(recorded.tasks[0], recorded), { continue: false, restart: true });
  assert.equal(reduce(recorded, { type: 'continue', activityId: workId(recorded, ITEM.itemId) }).state, recorded);
  assert.equal(activityOf(reduce(recorded, { type: 'start', itemId: ITEM.itemId }).state, ITEM.itemId)?.freeSessionStage, undefined, 'a stage run\'s spawn');
  assert.equal(activityOf(reduce(recorded, { type: 'moveToStage', taskId: ITEM.itemId, stage: 'plan' }).state, ITEM.itemId)?.freeSessionStage, undefined, 'a fresh entry');
});

test('a stage entered again drops the start of its earlier visit, so its own spawn records a new one; Restart never goes back to the first visit (#812, #283)', () => {
  const start = ranSpec('spec');
  const recorded = reduce(start, { type: 'stageStarted', activityId: workId(start, ITEM.itemId), stage: 'spec', commit: 'a1b2c3d' }).state;
  const away = reduce(recorded, { type: 'moveToStage', taskId: ITEM.itemId, stage: 'plan' }).state;
  assert.equal(activityOf(away, ITEM.itemId)?.stageStart, undefined, 'the stage left behind');
  const back = reduce(reduce(away, { type: 'stageStarted', activityId: workId(away, ITEM.itemId), stage: 'plan', commit: 'b2c3d4e' }).state, { type: 'moveToStage', taskId: ITEM.itemId, stage: 'spec' }).state;
  assert.deepEqual([activityOf(back, ITEM.itemId)?.stageStart, back.tasks[0].stage], [undefined, 'spec']);
});

test('a free open whose spawn fails leaves no free run behind: the mark goes and the stage offers continue again, unless another free session of the task is still open (#812, #283)', () => {
  const opened = opens(ranSpec('spec'));
  const failed = reduce(opened, { type: 'spawnFailed', ptyId: freeRun(opened).runId!, message: 'no claude' }).state;
  assert.equal(activityOf(failed, ITEM.itemId)?.freeSessionStage, undefined);
  assert.deepEqual(startMode(failed.tasks[0], failed), { continue: true, restart: false });
  const twice = opens(opened);
  const second = twice.workers.filter((w) => w.freeSession).at(-1)!;
  const one = reduce(twice, { type: 'spawnFailed', ptyId: second.runId!, message: 'no claude' }).state;
  assert.equal(activityOf(one, ITEM.itemId)?.freeSessionStage, 'spec', 'the first one still runs');
});

test('a failed free open keeps the mark an earlier free run of this visit set, and drops one only a session of an earlier visit could explain; the failed session itself never counts (#812)', () => {
  const ran = exited(opens(ranSpec('spec'))); // a free run in spec, closed
  const again = opens(ran);
  const failed = reduce(again, { type: 'spawnFailed', ptyId: freeRun(again).runId!, message: 'no claude' }).state;
  assert.equal(activityOf(failed, ITEM.itemId)?.freeSessionStage, 'spec', 'the earlier free run happened');
  // the same, with the earlier free session last used before the task entered spec: another visit's
  const entered = '2026-09-29T10:00:00.000Z';
  const older: State = {
    ...ran, tasks: ran.tasks.map((c) => ({ ...c, enteredAt: entered })),
    activityRecords: ran.activityRecords.map((r) => ({ ...r, sessions: r.sessions.map((s) => (s.free ? { ...s, lastUsedAt: PAST } : s)) })),
  };
  const retried = opens(older);
  const gone = reduce(retried, { type: 'spawnFailed', ptyId: freeRun(retried).runId!, message: 'no claude' }).state;
  assert.equal(activityOf(gone, ITEM.itemId)?.freeSessionStage, undefined);
});
