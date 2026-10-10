import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runs from '../src/task-runs.js';
import { taskBranch, commandsOf, liveCommand, localRuns, ownBranch, sessionLabel } from '../src/task-runs.js';
import { localActivityId } from '../src/activities.js';
import type { Activity, ActivityRecord, Task, Session, Terminal, Stage, Worker, State } from '../src/types.js';

const SPEC: Stage = { name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive:spec {url}' };
const DEV: Stage = { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive:build {url}', session: 'continue' };
const WAIT: Stage = { name: 'wait', from: { board: ['Waiting'] }, prompt: '/hive:check {url}', after: '5d' };
const REVIEW: Stage = { name: 'review', from: { board: ['In review'] } };
const DONE: Stage = { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' };
const stages = [SPEC, DEV, WAIT, REVIEW, DONE];
const AT = '2026-09-25T10:00:00.000Z';
const session = (id: string, stages: string[]): Session => ({ id, startedAt: AT, stages, lastUsedAt: AT });
// A fixture task, the sessions its record holds and its activity's worktree and run fields (#629): the adapters below hand them to the reads
// as the task's one activity and record
type Work = Pick<Activity, 'worktree' | 'branch' | 'worktreeGone' | 'local' | 'base' | 'setup' | 'deleting' | 'sessionId' | 'workerId' | 'stopped'
  | 'stageStart' | 'error' | 'approval' | 'handover' | 'freeSessionStage'>;
type Fixture = Task & { sessions?: Session[] } & Partial<Work>;
const task = (stage: string, extra: Partial<Fixture> = {}): Fixture =>
  ({ item: { itemId: 'board:1', id: '1', title: 'T', body: '', url: '' }, stage, boardColumn: '', auto: true, ...extra });
const liveOf = ({ item: _item, stage: _stage, boardColumn: _column, auto: _auto, sessions: _sessions, missing: _m, orphan: _o, enteredAt: _e, leaving: _l, pinned: _p, created: _c, workspace: _w, ...work }: Fixture): Activity => {
  return { id: 'a-1', kind: 'task', workspace: 'hive', slug: 'hive-1-t', ...work };
};
const canRunCommand = (c: Fixture) => runs.canRunCommand(c, liveOf(c));
const canDiff = (c: Fixture, scope: Parameters<typeof runs.canDiff>[2]) => runs.canDiff(c, liveOf(c), scope);
const ran = (stage: string, extra: Partial<Fixture> = {}): Fixture => task(stage, { sessions: [session('a-session-0001', ['spec', 'dev'])], ...extra });
// Task board:<n>'s activity is a-<n> (#629): the one a worker or a terminal on it points at
const recorded = (c: Fixture): Pick<State, 'activities' | 'activityRecords'> => ({
  activities: [liveOf(c)],
  activityRecords: [{ id: 'a-1', taskIds: [c.item.itemId], sessions: c.sessions ?? [] }],
});
const stageSession = (c: Fixture, stage: string) => runs.stageSession(c, recorded(c), stage);
const gateSession = (c: Fixture, stages: Stage[]) => runs.gateSession(c, { stages, ...recorded(c) });
const feedbackSession = (c: Fixture, stages: Stage[], stage?: string) => runs.feedbackSession(c, { stages, ...recorded(c) }, stage);
const startMode = (c: Fixture, state: Pick<State, 'stages' | 'workers'>) => runs.startMode(c, { ...state, ...recorded(c) });
const openFeedbackSession = (c: Fixture, state: Pick<State, 'stages' | 'workers'>) => runs.openFeedbackSession(c, { ...state, ...recorded(c) });
const liveRuns = (c: Fixture, state: Pick<State, 'workers' | 'terminals'>, opts?: { commands?: boolean }) => runs.liveRuns(c, { ...state, ...recorded(c) }, opts);

test('stageSession: the latest session whose stages hold the stage; undefined when the stage never ran (#283)', () => {
  const three = task('dev', { sessions: [session('a-session-0001', ['spec', 'dev']), session('b-session-0002', ['review']), session('c-session-0003', ['dev'])] });
  assert.equal(stageSession(three, 'dev')?.id, 'c-session-0003');
  assert.equal(stageSession(three, 'spec')?.id, 'a-session-0001');
  assert.equal(stageSession(three, 'wait'), undefined);
  // #629: a lone sessionId (a task saved before the list) becomes a record's session on load (state-store.test); the reads see records only
  assert.equal(stageSession(task('dev', { sessionId: 'd-session-0004', enteredAt: AT }), 'dev'), undefined, 'no record, no session');
});

test('startMode: none for a blocked, missing or deleting task and a stage with nothing to run; running while a stage worker holds it; start until the stage ran, after and manual included; then continue, with restart only on a stage that starts a new session and a recorded start for it (#283)', () => {
  const state = { stages, workers: [] };
  const blocked = task('spec', { item: { ...task('spec').item, blockedBy: ['9'] } });
  const none: [Fixture, string][] = [
    [blocked, 'blocked'], [task('spec', { missing: true }), 'missing'], [task('spec', { deleting: true }), 'deleting'],
    [task('review'), 'no prompt, no action'], [task('gone'), 'a stage the Comb lost'],
  ];
  for (const [c, why] of none) assert.equal(startMode(c, state), 'none', why);
  assert.equal(startMode(task('done', { item: blocked.item }), state), 'start', 'a delete activity stage ignores blockers, as its start does');
  assert.equal(startMode(ran('spec', { workerId: 's1' }), state), 'running');
  for (const c of [task('spec'), task('wait'), task('spec', { auto: false }), ran('wait'), ran('done')]) assert.equal(startMode(c, state), 'start', c.stage);
  assert.deepEqual(startMode(ran('spec', { stopped: true }), state), { continue: true, restart: false }, 'no recorded start');
  assert.deepEqual(startMode(ran('spec', { stageStart: { stage: 'spec', commit: 'a1b2c3d' } }), state), { continue: true, restart: true });
  assert.deepEqual(startMode(ran('spec', { stageStart: { stage: 'dev', commit: 'a1b2c3d' } }), state), { continue: true, restart: false }, 'the start of another stage');
  assert.deepEqual(startMode(ran('dev', { stageStart: { stage: 'dev', commit: 'a1b2c3d' } }), state), { continue: true, restart: false }, 'dev continues the session of the stage before');
});

test('startMode: approval while the task awaits the user, whether or not its stage ran; a held stage worker still reads running; a blocked task none (#268)', () => {
  const state = { stages, workers: [] };
  assert.equal(startMode(ran('spec', { approval: { since: AT }, stageStart: { stage: 'spec', commit: 'a1b2c3d' } }), state), 'approval', 'no Continue, no Restart');
  assert.equal(startMode(task('spec', { approval: { since: AT } }), state), 'approval', 'no Start');
  assert.equal(startMode(ran('spec', { approval: { since: AT, until: AT }, workerId: 's1' }), state), 'running', 'its session is live: Terminal and Parar reach it');
  assert.equal(startMode(task('spec', { approval: { since: AT }, item: { ...task('spec').item, blockedBy: ['9'] } }), state), 'none');
});

test('startMode names the live run that already holds the stage\'s latest session, so Continue focuses it instead of starting a second process; another task\'s worker or another session is no holder (#283)', () => {
  const holder: Worker = { id: 's9', status: 'working', runId: 'w9', activityId: 'a-1', sessionId: 'a-session-0001' };
  const stopped = ran('spec', { stopped: true });
  assert.deepEqual(startMode(stopped, { stages, workers: [holder] }), { continue: true, restart: false, live: 'w9' });
  const others: Worker[] = [{ ...holder, activityId: 'a-2' }, { ...holder, sessionId: 'b-session-0002' }, { ...holder, status: 'empty' }];
  assert.deepEqual(startMode(stopped, { stages, workers: others }), { continue: true, restart: false });
});

test('startMode never offers Restart on a checkout task: it would reset the user\'s own checkout (#444)', () => {
  const state = { stages, workers: [] };
  assert.deepEqual(startMode(ran('spec', { stageStart: { stage: 'spec', commit: 'a1b2c3d' }, local: true }), state), { continue: true, restart: false });
});

test('ownBranch trusts a task branch only when it is the template or <template>-r<n>; taskBranch falls back to the template (#283)', () => {
  const template = 'hive/1-fix.it';
  assert.equal(ownBranch({ branch: template }, template), template);
  assert.equal(ownBranch({ branch: `${template}-r2` }, template), `${template}-r2`);
  for (const branch of [undefined, 'main', `${template}-r`, `${template}-rx`, `${template}-r2-x`, 'hive/1-fixXit']) {
    assert.equal(ownBranch({ branch }, template), undefined, String(branch));
  }
  assert.equal(taskBranch({ branch: `${template}-r3` }, template), `${template}-r3`);
  assert.equal(taskBranch({ branch: 'main' }, template), template);
});

test('liveRuns lists every live run on the task for the pickers and the terminal panel, named by what runs in it: the stage run and each free session as Claude · the first 8 characters of their session id, a plain terminal as Terminal, with its kind (#283, #489)', () => {
  const c = task('dev', { workerId: 's1', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' });
  const workers: Worker[] = [
    { id: 's1', status: 'working', runId: 'w1111111-0000-4000-8000-000000000001', activityId: 'a-1' },
    { id: 's2', status: 'waiting', runId: 'w2222222-0000-4000-8000-000000000002', activityId: 'a-1', freeSession: true, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' },
    { id: 's3', status: 'working', runId: 'w3333333-0000-4000-8000-000000000003', activityId: 'a-2' },
    { id: 's4', status: 'empty' },
  ];
  const terminals = [{ terminalId: 'w4444444-0000-4000-8000-000000000004', activityId: 'a-1', startedAt: AT, cwd: '/repo' }];
  assert.deepEqual(liveRuns(c, { workers, terminals }), [
    { ptyId: 'w1111111-0000-4000-8000-000000000001', label: 'Claude · aaaaaaaa', kind: 'stage', session: 'aaaaaaaa' },
    { ptyId: 'w2222222-0000-4000-8000-000000000002', label: 'Claude · bbbbbbbb', kind: 'session', session: 'bbbbbbbb' },
    { ptyId: 'w4444444-0000-4000-8000-000000000004', label: 'Terminal', kind: 'terminal' },
  ]);
});

test('liveRuns labels a run command\'s terminal with the command\'s name, a plain terminal as Terminal (#300, #489)', () => {
  const terminals = [
    { terminalId: 'w5555555-0000-4000-8000-000000000005', activityId: 'a-1', startedAt: AT, cwd: '/repo', command: 'Run Frontend' },
    { terminalId: 'w6666666-0000-4000-8000-000000000006', activityId: 'a-1', startedAt: AT, cwd: '/repo' },
  ];
  assert.deepEqual(liveRuns(task('dev'), { workers: [], terminals }).map((r) => r.label), ['Run Frontend', 'Terminal']);
});

test('liveRuns with commands: false leaves the run commands\' terminals out, the workers and a plain terminal kept; by default every run counts (#353)', () => {
  const c = task('dev', { workerId: 's1', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' });
  const workers: Worker[] = [{ id: 's1', status: 'working', runId: 'w1111111-0000-4000-8000-000000000001', activityId: 'a-1' }];
  const terminals = [
    { terminalId: 'w5555555-0000-4000-8000-000000000005', activityId: 'a-1', startedAt: AT, cwd: '/repo', command: 'Run Frontend' },
    { terminalId: 'w6666666-0000-4000-8000-000000000006', activityId: 'a-1', startedAt: AT, cwd: '/repo' },
  ];
  assert.deepEqual(liveRuns(c, { workers, terminals }, { commands: false }).map((r) => r.ptyId), ['w1111111-0000-4000-8000-000000000001', 'w6666666-0000-4000-8000-000000000006']);
  assert.deepEqual(liveRuns(c, { workers, terminals }).map((r) => r.ptyId), ['w1111111-0000-4000-8000-000000000001', 'w5555555-0000-4000-8000-000000000005', 'w6666666-0000-4000-8000-000000000006']);
});

test('liveRuns names an agent run Claude alone before its session id is known, then Claude · <name> once its listed session has one, else the id\'s first 8 characters (#489)', () => {
  const stage: Worker = { id: 's1', status: 'working', runId: 'w1111111-0000-4000-8000-000000000001', activityId: 'a-1' };
  const freeSession: Worker = { id: 's2', status: 'working', runId: 'w2222222-0000-4000-8000-000000000002', activityId: 'a-1', freeSession: true };
  const labels = (c: Task, workers: Worker[]): string[] => liveRuns(c, { workers, terminals: [] }).map((r) => r.label);
  assert.deepEqual(labels(task('dev', { workerId: 's1' }), [stage, freeSession]), ['Claude', 'Claude'], 'a stage run before its spawn wrote task.sessionId, a session before SessionStart');
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const named = task('dev', { workerId: 's1', sessionId: id, sessions: [{ ...session(id, ['dev']), name: 'fix the login' }] });
  const other: Worker = { ...freeSession, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' };
  assert.deepEqual(labels(named, [stage, other]), ['Claude · fix the login', 'Claude · bbbbbbbb'], 'only the session the name belongs to reads it');
});

test('liveRuns numbers a task\'s plain terminals Terminal 1, Terminal 2 in the order they opened when it has several; a run command neither counts nor changes its name, another task\'s terminal does not count (#489)', () => {
  const terminals = [
    { terminalId: 'w5555555-0000-4000-8000-000000000005', activityId: 'a-1', startedAt: AT, cwd: '/repo' },
    { terminalId: 'w6666666-0000-4000-8000-000000000006', activityId: 'a-1', startedAt: AT, cwd: '/repo', command: 'Run Frontend' },
    { terminalId: 'w7777777-0000-4000-8000-000000000007', activityId: 'a-2', startedAt: AT, cwd: '/repo' },
    { terminalId: 'w8888888-0000-4000-8000-000000000008', activityId: 'a-1', startedAt: AT, cwd: '/repo' },
  ];
  const labels = (list: typeof terminals, commands = true): string[] => liveRuns(task('dev'), { workers: [], terminals: list }, { commands }).map((r) => r.label);
  assert.deepEqual(labels(terminals), ['Terminal 1', 'Run Frontend', 'Terminal 2']);
  assert.deepEqual(labels(terminals, false), ['Terminal 1', 'Terminal 2'], 'the same numbers where the pickers leave the command out');
  assert.deepEqual(labels(terminals.slice(1)), ['Run Frontend', 'Terminal'], 'one plain terminal left: Terminal again');
});

test('liveCommand names the live run of that command on this task; another command, another task\'s run of it or a plain terminal is none (#353)', () => {
  const terminals = [
    { terminalId: 'w5555555-0000-4000-8000-000000000005', activityId: 'a-1', startedAt: AT, cwd: '/repo', command: 'Run Frontend' },
    { terminalId: 'w6666666-0000-4000-8000-000000000006', activityId: 'a-2', startedAt: AT, cwd: '/repo', command: 'Run API' },
    { terminalId: 'w7777777-0000-4000-8000-000000000007', activityId: 'a-1', startedAt: AT, cwd: '/repo' },
  ];
  assert.equal(liveCommand(task('dev'), { terminals, ...recorded(task('dev')) }, 'Run Frontend'), 'w5555555-0000-4000-8000-000000000005');
  assert.equal(liveCommand(task('dev'), { terminals, ...recorded(task('dev')) }, 'Run API'), undefined);
  assert.equal(liveCommand(task('dev'), { terminals, ...recorded(task('dev')) }, 'Terminal'), undefined);
});

test('canRunCommand: only a task open to a session whose worktree is on disk; a blocked one is open (#300, #491)', () => {
  assert.equal(canRunCommand(task('spec', { worktree: '/wt' })), true);
  assert.equal(canRunCommand(task('spec', { worktree: '/wt', item: { ...task('spec').item, blockedBy: ['9'] } })), true, 'a blocker holds the stage run only');
  const refused: [Fixture, string][] = [
    [task('spec'), 'no worktree'], [task('spec', { worktree: '/wt', worktreeGone: true }), 'gone from disk'],
    [task('spec', { worktree: '/wt', missing: true }), 'missing'], [task('spec', { worktree: '/wt', deleting: true }), 'deleting'],
  ];
  for (const [c, why] of refused) assert.equal(canRunCommand(c), false, why);
});

test('commandsOf: the command names of the workspace the task resolves to; [] with no workspace, or one the config gave no entry (#300)', () => {
  const state = { workspaces: ['hive', 'site'], sourceWorkspaces: { board: 'site' }, commands: { hive: ['Run Frontend'], site: ['Run API', 'Seed'] } };
  assert.deepEqual(commandsOf(task('spec', { workspace: 'hive' }), state), ['Run Frontend']);
  assert.deepEqual(commandsOf(task('spec', { item: { ...task('spec').item, source: 'board' } }), state), ['Run API', 'Seed'], 'the board default');
  assert.deepEqual(commandsOf(task('spec'), state), [], 'two workspaces, no rule: none');
  assert.deepEqual(commandsOf(task('spec', { workspace: 'hive' }), { ...state, commands: {} }), []);
  assert.deepEqual(commandsOf(task('spec', { workspace: 'toString' }), { ...state, workspaces: ['toString'] }), [], 'own keys only');
});

test('startMode: none on a continue stage for a task with no session to resume, cleaned up or never run; start on a new-session stage after the same delete activity; start on a continue stage with an earlier stage\'s session (#350)', () => {
  const state = { stages, workers: [] };
  const cleaned = task('dev', { enteredAt: AT }); // what a delete activity with the session scope leaves: no sessions, no sessionId
  assert.equal(startMode(cleaned, state), 'none', 'nothing to resume and the stage expects the previous session');
  assert.equal(startMode(task('dev', { auto: false }), state), 'none', 'a task that lands in a continue stage without ever having run');
  assert.equal(startMode(task('wait', { enteredAt: AT }), state), 'start', 'a new-session stage starts afresh');
  assert.equal(startMode(task('dev', { sessions: [session('a-session-0001', ['spec'])], sessionId: 'a-session-0001' }), state), 'start', 'Start resumes the spec session');
  assert.equal(startMode(task('dev', { sessions: [session('a-session-0001', ['spec'])], approval: { since: AT } }), state), 'approval');
  assert.equal(startMode(task('done'), { stages: [{ ...DONE, session: 'continue' }], workers: [] }), 'start', 'a delete activity stage resumes nothing: its Delete activity stays');
});

const GATE: Stage = { name: 'gate', from: { board: ['Review'] }, approval: true }; // a manual gate (#315): approval, no prompt
const GATED = [SPEC, GATE, DEV]; // the gate reviews spec's work

test('gateSession: in a manual gate, the latest session of the stage right before it, else the task\'s latest session of any stage; undefined outside a gate and on a task with no session (HIVE-2, #685)', () => {
  const reviewed = task('gate', { sessions: [
    session('a-session-0001', ['spec']), session('b-session-0002', ['review']), session('c-session-0003', ['spec', 'gate']), session('d-session-0004', ['review']),
  ] });
  assert.equal(gateSession(reviewed, GATED)?.id, 'c-session-0003', 'the reviewed stage\'s work first, though a later session exists');
  assert.equal(gateSession({ ...reviewed, stage: 'dev' }, GATED), undefined, 'dev is no gate');
  assert.equal(gateSession(reviewed, [GATE, SPEC, DEV])?.id, 'd-session-0004', 'a first-stage gate reviews nothing: the task\'s latest session');
  const moved = task('gate', { sessions: [session('b-session-0002', ['review'])] }); // entered the gate by hand: spec never ran here
  assert.equal(gateSession(moved, GATED)?.id, 'b-session-0002', 'the reviewed stage never ran: the task\'s latest session');
  assert.equal(gateSession(task('gate'), GATED), undefined, 'no session at all: its feedback starts a new one');
});

test('handoverRun resumes the session the handover names as a continue run, or starts a new one, and takes the handover off the activity (#134)', () => {
  const activity = { id: 'a', kind: 'task' as const, workspace: 'hive', sessionId: 'old' };
  assert.deepEqual(runs.handoverRun({ ...activity, handover: { prompt: 'p', sessionId: 's' } }), { activity: { ...activity, sessionId: 's' }, run: 'continue', policy: 'continue', prompt: 'p' });
  assert.deepEqual(runs.handoverRun({ ...activity, handover: { prompt: 'p' } }), { activity, run: 'stage', policy: 'new', prompt: 'p' });
  assert.equal(runs.handoverRun(activity), undefined);
});

test('openFeedbackSession: the live free session on the session feedback would resume, the stage\'s own or, in a gate, the reviewed stage\'s; nothing for a stage run, an empty worker, another task, another session or no worker (#483)', () => {
  const own: Worker = { id: 's', status: 'working', runId: 'w1', activityId: 'a-1', sessionId: 'a-session-0001', freeSession: true };
  const { freeSession: _freeSession, ...stageRun } = own;
  const { runId: _ptyId, ...noWorker } = own;
  const dev = ran('dev'); // a-session-0001 ran spec and dev
  const at = (workers: Worker[], c: Task = dev): string | undefined => openFeedbackSession(c, { stages, workers })?.runId;
  assert.equal(feedbackSession(dev, stages)?.id, 'a-session-0001');
  assert.equal(at([own]), 'w1');
  assert.equal(at([stageRun]), undefined, 'a stage run is answerFeedback\'s or the spawn\'s');
  assert.equal(at([{ ...own, status: 'empty' }]), undefined);
  assert.equal(at([{ ...own, activityId: 'a-2' }]), undefined);
  assert.equal(at([{ ...own, sessionId: 'b-session-0002' }]), undefined, 'another conversation: feedback follows today\'s path');
  assert.equal(at([noWorker]), undefined);
  const reviewed = task('gate', { sessions: [session('a-session-0001', ['spec'])] });
  assert.equal(feedbackSession(reviewed, GATED)?.id, 'a-session-0001', 'a gate resumes the stage it reviews');
  assert.equal(openFeedbackSession(reviewed, { stages: GATED, workers: [own] })?.runId, 'w1');
  assert.equal(openFeedbackSession(task('gate'), { stages: GATED, workers: [own] }), undefined, 'a gate with nothing to review');
});

test('canDiff: both scopes need a worktree on disk; the stage scope also a start recorded in the task\'s current stage (#270)', () => {
  const start = { stage: 'dev', commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' };
  const cases: [Fixture, boolean, boolean, string][] = [
    [task('dev', { worktree: '/wt', stageStart: start }), true, true, 'both'],
    [task('dev', { stageStart: start }), false, false, 'no worktree'],
    [task('dev', { worktree: '/wt', worktreeGone: true, stageStart: start }), false, false, 'worktree gone from disk (#208)'],
    [task('dev', { worktree: '/wt' }), false, true, 'no stage start'],
    [task('dev', { worktree: '/wt', stageStart: { ...start, stage: 'spec' } }), false, true, 'a start of another stage'],
  ];
  for (const [c, stage, worktree, why] of cases) assert.deepEqual([canDiff(c, 'stage'), canDiff(c, 'worktree'), canDiff(c, 'commit')], [stage, worktree, worktree], why);
});

test('localRuns lists a workspace\'s local claude sessions, named by their kept session, then its terminals; a task\'s runs and another workspace\'s are left out; sessionLabel is the name, else the id\'s head (#590)', () => {
  const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const workers: Worker[] = [
    { id: 's1', status: 'working', activityId: localActivityId('hive'), freeSession: true, runId: 'W1', sessionId: id },
    { id: 's2', status: 'waiting', activityId: localActivityId('hive'), freeSession: true, runId: 'W2' },
    { id: 's3', status: 'working', activityId: localActivityId('site'), freeSession: true, runId: 'W3' },
    { id: 's4', status: 'working', activityId: 'a-1', runId: 'W4' },
  ];
  const terminals: Terminal[] = [{ terminalId: 'P1', activityId: localActivityId('hive'), startedAt: AT, cwd: '/repo' }, { terminalId: 'P2', activityId: localActivityId('hive'), startedAt: AT, cwd: '/repo' }, { terminalId: 'C1', activityId: 'a-1', startedAt: AT, cwd: '/repo' }];
  const activityRecords: ActivityRecord[] = [{ id: localActivityId('hive'), taskIds: [], sessions: [{ id, startedAt: AT, stages: [], lastUsedAt: AT, name: 'fix login' }] }];
  assert.deepEqual(localRuns('hive', { workers, terminals, activityRecords }), [
    { ptyId: 'W1', label: 'Claude · fix login', kind: 'session', session: 'fix login' },
    { ptyId: 'W2', label: 'Claude', kind: 'session' },
    { ptyId: 'P1', label: 'Terminal 1', kind: 'terminal' },
    { ptyId: 'P2', label: 'Terminal 2', kind: 'terminal' },
  ]);
  assert.deepEqual([sessionLabel({ id, name: 'fix login' }), sessionLabel({ id })], ['fix login', '3f2504e0']);
});

const free = (id: string): Session => ({ ...session(id, []), free: true }); // opened by hand (#812): it never ran a stage

test('a free session is never the stage\'s session: alone it leaves start; beside a stage run\'s it leaves continue and feedback on that one, and an open run on it is no feedback target; a continue stage it unlocks still starts (#812, #350, #483)', () => {
  const state = { stages, workers: [] };
  assert.equal(startMode(task('spec', { sessions: [free('f-session-0001')], stopped: true }), state), 'start');
  const both = task('spec', { sessions: [session('a-session-0001', ['spec']), free('f-session-0002')], stopped: true });
  assert.equal(stageSession(both, 'spec')?.id, 'a-session-0001');
  assert.deepEqual(startMode(both, state), { continue: true, restart: false });
  assert.equal(feedbackSession(both, stages)?.id, 'a-session-0001');
  const onFree: Worker = { id: 's', status: 'working', runId: 'w1', activityId: 'a-1', sessionId: 'f-session-0002', freeSession: true };
  assert.equal(openFeedbackSession(both, { stages, workers: [onFree] }), undefined, 'another conversation');
  assert.equal(startMode(task('dev', { sessions: [free('f-session-0001')] }), state), 'start', 'any session is context for a continue stage (#350)');
});

test('feedback goes to the free session whose hive_done ended the stage, which the approval names; without one, or once that session is cleared, to the stage run\'s (#812, #483)', () => {
  const sessions = [session('a-session-0001', ['spec']), free('f-session-0002')];
  const parked = task('spec', { sessions, approval: { since: AT, sessionId: 'f-session-0002' } });
  assert.equal(feedbackSession(parked, stages)?.id, 'f-session-0002');
  const onFree: Worker = { id: 's', status: 'working', runId: 'w1', activityId: 'a-1', sessionId: 'f-session-0002', freeSession: true };
  assert.equal(openFeedbackSession(parked, { stages, workers: [onFree] })?.runId, 'w1', 'open: typed into it (#483)');
  assert.equal(feedbackSession(task('spec', { sessions, approval: { since: AT } }), stages)?.id, 'a-session-0001');
  assert.equal(feedbackSession(task('spec', { sessions: [sessions[0]], approval: { since: AT, sessionId: 'f-session-0002' } }), stages)?.id, 'a-session-0001', 'cleared');
});

test('after a free run in the task\'s stage startMode offers no continue: start and restart with a start recorded there, a free session\'s own included; else start; while the hand resume of the stage\'s session runs, continue focuses it; a mark of another stage changes nothing (#812)', () => {
  const state = { stages, workers: [] };
  const recorded = { stageStart: { stage: 'spec', commit: 'a1b2c3d' } };
  assert.deepEqual(startMode(ran('spec', { stopped: true, freeSessionStage: 'spec', ...recorded }), state), { continue: false, restart: true });
  assert.equal(startMode(ran('spec', { stopped: true, freeSessionStage: 'spec' }), state), 'start', 'no start recorded');
  assert.deepEqual(startMode(task('spec', { sessions: [free('f-session-0001')], freeSessionStage: 'spec', ...recorded }), state), { continue: false, restart: true }, 'the free session recorded the start of a stage that never ran');
  assert.equal(startMode(ran('dev', { freeSessionStage: 'dev', stageStart: { stage: 'dev', commit: 'a1b2c3d' } }), state), 'start', 'a continue stage never restarts');
  const holder: Worker = { id: 's9', status: 'working', runId: 'w9', activityId: 'a-1', sessionId: 'a-session-0001', freeSession: true };
  assert.deepEqual(startMode(ran('spec', { freeSessionStage: 'spec', ...recorded }), { stages, workers: [holder] }), { continue: true, restart: true, live: 'w9' }, 'no second process on the session');
  assert.deepEqual(startMode(ran('spec', { stopped: true, freeSessionStage: 'dev' }), state), { continue: true, restart: false }, 'a free run in another stage');
});
