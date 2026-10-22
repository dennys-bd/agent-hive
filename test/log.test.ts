import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppender, createLogger, describeChanges, describeEffect, describeEvent, generations, LOG_FILE, LOG_GENERATIONS, LOG_LEVELS, MESSAGE_MAX, passes, shortId } from '../src/log.js';
import { initialState } from '../src/orchestrator.js';
import { localActivityId } from '../src/activities.js';
import { activityIdOf, withLocal, withWork, type WithWork } from './fixtures/work.js';
import { SIGNALS_DEFAULTS, type Activity, type Checkpoint, type HookPayload, type Task, type Stage, type Worker, type State, type Item } from '../src/types.js';
import { tempDir, type AfterHost } from './temp-dir.js';

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (ERROR|WARN |INFO |DEBUG) /;
const ISO_WIDTH = 25; // "2026-09-17T12:00:00.000Z " — what precedes the level tag
const quiet = (): void => {};
const PTY = '1a2b3c4d-1111-4111-8111-111111111111';
const WORKER = '9f8e7d6c-2222-4222-8222-222222222222';
const item = (id: string): Item => ({ itemId: `I${id}`, id, title: 'Logs', body: 'the body is never logged', url: `https://github.com/acme/r/issues/${id}` });
const taskFor = (id: string): Task => ({ item: item(id), stage: 'dev', boardColumn: 'Ready', auto: true });
// Task 30's activity (#629): the slug the effects' lines name
const WORK30: Activity = { id: activityIdOf('I30'), kind: 'task', workspace: 'hive', slug: 'hive-30-logs' };
const LOCAL_HIVE: Activity = { id: localActivityId('hive'), kind: 'local', workspace: 'hive' };

async function logDir(t: AfterHost): Promise<string> {
  return join(await tempDir(t, 'log-'), '.hive'); // does not exist yet: the logger creates it
}

const tail = (dir: string, file = LOG_FILE): string[] =>
  readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => l.slice(ISO_WIDTH));

function stderrSpy(): { calls: string[]; stderr: (line: string) => void } {
  const calls: string[] = [];
  return { calls, stderr: (line) => { calls.push(line); } };
}

test('createLogger creates .hive/ and hive.log and writes one `<ISO> <LEVEL> <message>` line per call', async (t) => {
  const dir = await logDir(t);
  assert.equal(existsSync(dir), false);
  const log = createLogger(dir, 'info', { stderr: quiet });
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'created on construction (setup mode has no prepareHome yet), for this user only: it is the home');
  log.info('poll queue=3');
  const raw = readFileSync(join(dir, LOG_FILE), 'utf8');
  assert.match(raw, LINE);
  assert.equal(raw.slice(ISO_WIDTH), 'INFO  poll queue=3\n');
});

test('info is written and debug dropped at level info; setLevel(debug) starts writing debug', async (t) => {
  const dir = await logDir(t);
  const log = createLogger(dir, 'info', { stderr: quiet });
  log.debug('hook PreToolUse pty=1a2b3c4d tool=Bash');
  log.info('boot');
  log.setLevel('debug');
  log.debug('hook PostToolUse pty=1a2b3c4d tool=Bash');
  assert.deepEqual(tail(dir), ['INFO  boot', 'DEBUG hook PostToolUse pty=1a2b3c4d tool=Bash']);
  assert.deepEqual(tail(dir), tail(dir)); // reading is stable: sync writes leave no pending data
});

test('error goes to the injected stderr and to the file, whatever the level', async (t) => {
  const dir = await logDir(t);
  const { calls, stderr } = stderrSpy();
  const log = createLogger(dir, 'info', { stderr });
  log.error('board.listQueue: gh project item-list: rate limited');
  assert.deepEqual(calls, ['board.listQueue: gh project item-list: rate limited']);
  assert.deepEqual(tail(dir), ['ERROR board.listQueue: gh project item-list: rate limited']);
});

test('warn is written at levels warn, info and debug; info is dropped at level warn; error always passes (#742)', async (t) => {
  const dir = await logDir(t);
  const log = createLogger(dir, 'warn', { stderr: quiet });
  log.info('poll source=board items=3');
  log.warn('mcp.call tool=hive_pr outcome=refused');
  log.error('spawn failed');
  log.setLevel('info');
  log.info('boot');
  assert.deepEqual(tail(dir), ['WARN  mcp.call tool=hive_pr outcome=refused', 'ERROR spawn failed', 'INFO  boot']);
});

test('passes ranks error < warn < info < debug against the threshold (#742)', () => {
  assert.deepEqual(LOG_LEVELS, ['warn', 'info', 'debug']);
  assert.deepEqual([passes('error', 'warn'), passes('warn', 'warn'), passes('info', 'warn')], [true, true, false]);
  assert.deepEqual([passes('debug', 'info'), passes('debug', 'debug')], [false, true]);
});

test('createAppender appends raw lines to its own file and rotates it past maxBytes (#742)', async (t) => {
  const dir = await logDir(t);
  const append = createAppender(dir, 'other.jsonl', { maxBytes: 10, stderr: quiet });
  append('12345678\n'); // 9 bytes
  append('abc\n'); // 13 > 10: rotate first
  assert.equal(readFileSync(join(dir, 'other.jsonl'), 'utf8'), 'abc\n');
  assert.equal(readFileSync(join(dir, 'other.jsonl.1'), 'utf8'), '12345678\n');
});

test('past maxBytes hive.log becomes hive.log.1, the previous .1 shifting to .2, and a new hive.log starts; a new logger picks up the existing size (#93)', async (t) => {
  const dir = await logDir(t);
  // one line is 32 bytes + the message: "first" 37, "second" 38, "third" 37 …
  const log = createLogger(dir, 'info', { maxBytes: 100, stderr: quiet });
  log.info('first');
  log.info('second'); // 75 bytes so far
  log.info('third'); // 112 > 100: rotate before writing
  assert.deepEqual(tail(dir), ['INFO  third']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  first', 'INFO  second']);
  log.info('fourth'); // 75
  log.info('fifth'); // 112: rotate again, the old hive.log.1 moves to .2
  assert.deepEqual(tail(dir), ['INFO  fifth']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  third', 'INFO  fourth']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.2`), ['INFO  first', 'INFO  second']);
  const again = createLogger(dir, 'info', { maxBytes: 100, stderr: quiet }); // 37 bytes already on disk
  again.info('sixth'); // 74
  again.info('seventh'); // 113: rotates only because the size was read from the file
  assert.deepEqual(tail(dir), ['INFO  seventh']);
  assert.deepEqual([1, 2, 3].map((g) => tail(dir, `${LOG_FILE}.${g}`)), [
    ['INFO  fifth', 'INFO  sixth'], ['INFO  third', 'INFO  fourth'], ['INFO  first', 'INFO  second'],
  ]);
});

test('past maxBytes six times, .1 to .5 hold the five previous generations, newest in .1, and the oldest is gone (#93)', async (t) => {
  const dir = await logDir(t);
  const append = createAppender(dir, 'other.jsonl', { maxBytes: 3, stderr: quiet });
  for (const n of [1, 2, 3, 4, 5, 6, 7]) append(`${n}\n`); // 2 bytes each: every write after the first rotates
  assert.equal(readFileSync(join(dir, 'other.jsonl'), 'utf8'), '7\n');
  assert.deepEqual([1, 2, 3, 4, 5].map((g) => readFileSync(join(dir, `other.jsonl.${g}`), 'utf8')), ['6\n', '5\n', '4\n', '3\n', '2\n']);
  assert.equal(existsSync(join(dir, 'other.jsonl.6')), false, 'no sixth generation: the first write was dropped');
});

test('a missing middle generation does not stop the shift: the ones around it still move, and the file stays enabled (#93)', async (t) => {
  const dir = await logDir(t);
  const { calls, stderr } = stderrSpy();
  const append = createAppender(dir, 'other.jsonl', { maxBytes: 3, stderr });
  for (const n of [1, 2, 3]) append(`${n}\n`); // .2 = 1, .1 = 2, current = 3
  rmSync(join(dir, 'other.jsonl.1'));
  append('4\n');
  const read = (name: string): string | undefined => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined);
  assert.deepEqual(['other.jsonl', 'other.jsonl.1', 'other.jsonl.2', 'other.jsonl.3'].map(read), ['4\n', '3\n', undefined, '1\n']);
  assert.deepEqual(calls, []);
});

test('generations lists a rotated file oldest first, the current file last (#93)', () => {
  assert.equal(LOG_GENERATIONS, 5);
  assert.deepEqual(generations('hive.log'), ['hive.log.5', 'hive.log.4', 'hive.log.3', 'hive.log.2', 'hive.log.1', 'hive.log']);
});

test('a write failure prints once on stderr, disables the file and never throws; error still reaches stderr', async (t) => {
  const dir = join(await tempDir(t, 'log-'), '.hive');
  await writeFile(dir, 'not a directory'); // mkdir / append fail with EEXIST / ENOTDIR
  const { calls, stderr } = stderrSpy();
  const log = createLogger(dir, 'debug', { stderr });
  log.info('one');
  log.debug('two');
  log.info('three');
  assert.equal(calls.length, 1, 'one complaint, then silence');
  assert.match(calls[0], /^hive\.log: /);
  log.error('board.listQueue: boom');
  assert.deepEqual(calls.slice(1), ['board.listQueue: boom']);
  assert.equal(readFileSync(dir, 'utf8'), 'not a directory', 'the Hive kept running and touched nothing');
});

test('shortId keeps the first 8 characters and shows - for a missing id', () => {
  assert.equal(shortId(PTY), '1a2b3c4d');
  assert.equal(shortId(undefined), '-');
  assert.equal(shortId('abc'), 'abc');
});

test('describeEvent names the hook, worker and tool but never the tool_input, the response or the message', () => {
  const hook = describeEvent({
    type: 'hook', ptyId: PTY,
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/r/pull/9' },
  });
  assert.equal(hook, 'hook PostToolUse pty=1a2b3c4d tool=Bash');
  const notification = describeEvent({
    type: 'hook', ptyId: PTY, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to run rm' },
  });
  assert.equal(notification, 'hook Notification pty=1a2b3c4d');
});

test('describeEvent summarises every other event with names, ids and counts only', () => {
  assert.equal(describeEvent({ type: 'boot' }), 'boot');
  assert.equal(describeEvent({ type: 'poll', source: 'board', items: [item('1'), item('2')].map((t) => ({ item: t, column: 'Ready' })) }), 'poll source=board items=2 ids=1,2');
  const ids = Array.from({ length: 25 }, (_, i) => String(i + 1));
  assert.equal(describeEvent({ type: 'poll', source: 'board', items: ids.map((id) => ({ item: item(id), column: 'Ready' })) }), `poll source=board items=25 ids=${ids.slice(0, 20).join(',')}`);
  assert.equal(describeEvent({ type: 'exit', ptyId: PTY }), 'exit pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'continue', activityId: 'fedcba98-0000-4000-8000-000000000002' }), 'continue activity=fedcba98'); // #629: the activity's short id
  assert.equal(describeEvent({ type: 'restart', activityId: 'fedcba98-0000-4000-8000-000000000002', branch: 'hive/1-x-r2' }), 'restart activity=fedcba98 branch=hive/1-x-r2');
  assert.equal(describeEvent({ type: 'stageStarted', activityId: 'fedcba98-0000-4000-8000-000000000001', stage: 'dev', commit: '0123456789abcdef' }), 'stageStarted activity=fedcba98 stage=dev commit=01234567'); // #629: the activity's
  assert.equal(describeEvent({ type: 'clearSessions', activityId: 'a-PVTI_1', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001' }), 'clearSessions activity=a-PVTI_1 a1b2c3d4');
  assert.equal(describeEvent({ type: 'stop', ptyId: PTY }), 'stop pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'quit' }), 'quit');
  assert.equal(describeEvent({ type: 'dismissCrash' }), 'dismissCrash');
  assert.equal(describeEvent({ type: 'setSignal', signal: 'red' }), 'setSignal red');
  assert.equal(describeEvent({ type: 'setMax', max: 3 }), 'setMax 3');
  assert.equal(describeEvent({ type: 'setBudget', budget: { maxTokensPerHour: 10 } }), 'setBudget {"maxTokensPerHour":10}');
  assert.equal(describeEvent({ type: 'setUsageRules', usageRules: [{ source: 'hour', percent: 80, signal: 'yellow' }] }), 'setUsageRules rules=1');
  assert.equal(describeEvent({ type: 'setDeleteActivity', deleteActivity: { session: true, transcripts: false, nonAutoTasks: false } }), 'setDeleteActivity {"session":true,"transcripts":false,"nonAutoTasks":false}');
  assert.equal(describeEvent({ type: 'setShutdownIdle', minutes: 30 }), 'setShutdownIdle 30');
  assert.equal(describeEvent({ type: 'setApprovalMinutes', minutes: 15 }), 'setApprovalMinutes 15');
  assert.equal(describeEvent({ type: 'setRateLimitWait', minutes: 600 }), 'setRateLimitWait 600');
  assert.equal(describeEvent({ type: 'setShutdown', armed: true }), 'setShutdown on');
  assert.equal(describeEvent({ type: 'setShutdown', armed: false }), 'setShutdown off');
  assert.equal(describeEvent({ type: 'tick' }), 'tick');
  assert.equal(describeEvent({ type: 'rateLimits', agent: 'claude', ptyId: PTY, rateLimits: { at: '2026-09-17T12:00:00.000Z', windows: {} } }), 'rateLimits agent=claude pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'rateLimits', agent: 'codex', rateLimits: { at: '2026-09-17T12:00:00.000Z', windows: {} } }), 'rateLimits agent=codex source=hive');
  assert.equal(
    describeEvent({ type: 'sourceQuota', source: 'board', quota: { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' } }),
    'sourceQuota source=board remaining=4320/5000 resetsAt=2026-09-16T13:00:00.000Z',
  );
  assert.equal(describeEvent({ type: 'error', message: 'board.listQueue: boom' }), 'error board.listQueue: boom');
  assert.equal(describeEvent({ type: 'error' }), 'error');
  assert.equal(describeEvent({ type: 'start', itemId: 'PVTI_1' }), 'start #PVTI_1');
  assert.equal(describeEvent({ type: 'closeTask', taskId: 'PVTI_1' }), 'close task=#PVTI_1');
  assert.equal(describeEvent({ type: 'keepTask', taskId: 'PVTI_1' }), 'keepTask #PVTI_1');
  assert.equal(describeEvent({ type: 'closeMissing', stage: 'dev' }), 'closeMissing stage=dev');
  assert.equal(describeEvent({ type: 'done', ptyId: PTY }), 'done pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'done', ptyId: PTY, result: { spec: 'x', plan: 'y' } }), 'done pty=1a2b3c4d result=spec,plan');
  assert.equal(describeEvent({ type: 'pr', ptyId: PTY, url: 'https://github.com/acme/r/pull/9' }), 'pr pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'prStates', states: [{ url: 'https://github.com/acme/r/pull/9', state: 'merged' }, { url: 'https://github.com/acme/r/pull/10', state: 'open' }] }), 'prStates #9=merged,#10=open'); // #207
  assert.equal(describeEvent({ type: 'ask', ptyId: PTY, question: 'Which base should I use?' }), 'ask pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'spawnFailed', ptyId: PTY, message: 'pty: posix_spawnp failed.' }), 'spawnFailed pty=1a2b3c4d pty: posix_spawnp failed.');
  assert.equal(describeEvent({ type: 'openSession', activityId: 'a-PVTI_1', continueId: 'a1b2c3d4-0000-4000-8000-000000000001' }), 'openSession activity=a-PVTI_1 continue=a1b2c3d4');
  assert.equal(describeEvent({ type: 'openTerminal', activityId: 'a-PVTI_1', command: 'Run Frontend' }), 'openTerminal activity=a-PVTI_1'); // the command's name reaches only the spawn's line (#300)
  assert.equal(describeEvent({ type: 'worktreeGone', activityId: 'a-PVTI_1' }), 'worktreeGone activity=a-PVTI_1');
  assert.equal(describeEvent({ type: 'moveTask', taskId: 'PVTI_2', before: 'PVTI_1' }), 'moveTask #PVTI_2 before=#PVTI_1');
  assert.equal(describeEvent({ type: 'moveTask', taskId: 'PVTI_2' }), 'moveTask #PVTI_2 before=end');
  assert.equal(describeEvent({ type: 'resetOrder', stage: 'dev' }), 'resetOrder stage=dev');
  assert.equal(describeEvent({ type: 'setStages', stages: [{ name: 'a', from: {} }, { name: 'b', from: {} }], transitions: [] }), 'setStages a>b'); // #316: no numbers
  assert.equal(describeEvent({ type: 'sourceActionFailed', taskId: 'board:I1', message: 'must have admin rights', leaving: true }), 'sourceActionFailed #board:I1: must have admin rights'); // #286
  assert.equal(describeEvent({ type: 'activityDeleted', activityId: 'a-PVTI_1' }), 'activityDeleted activity=a-PVTI_1');
  assert.equal(describeEvent({ type: 'deleteActivityFailed', activityId: 'a-PVTI_1', message: "error: The branch 'hive-30-logs' is not fully merged." }), "deleteActivityFailed activity=a-PVTI_1: error: The branch 'hive-30-logs' is not fully merged.");
  assert.equal(describeEvent({ type: 'deletingActivity', activityId: 'a-PVTI_1' }), 'deletingActivity activity=a-PVTI_1');
  assert.equal(describeEvent({ type: 'activityRemoved', activityId: 'a-PVTI_1' }), 'activityRemoved activity=a-PVTI_1');
  assert.equal(describeEvent({ type: 'activityKept', activityId: 'a-PVTI_1' }), 'activityKept activity=a-PVTI_1');
});

test('describeEvent: deleteActivityFailed keeps only the first line of its message, so a failed teardown\'s output never reaches the log (#654)', () => {
  assert.equal(
    describeEvent({ type: 'deleteActivityFailed', activityId: 'a-PVTI_1', message: 'teardown failed at line 1 (RUN cat .env): exit 1\nTOKEN=secret' }),
    'deleteActivityFailed activity=a-PVTI_1: teardown failed at line 1 (RUN cat .env): exit 1',
  );
});

test('describeEvent: the setup events name only their task, never the step or the error, and spawnFailed keeps only the first line of its message, so a setup\'s output never reaches the log (#299, #351)', () => {
  assert.equal(describeEvent({ type: 'setupStarted', activityId: 'a-PVTI_1', consoleId: 'setup:PVTI_1', rows: [] }), 'setupStarted activity=a-PVTI_1');
  assert.equal(describeEvent({ type: 'setupStep', activityId: 'a-PVTI_1', step: 'RUN pnpm install', rows: [] }), 'setupStep activity=a-PVTI_1');
  assert.equal(describeEvent({ type: 'setupEnded', activityId: 'a-PVTI_1' }), 'setupEnded activity=a-PVTI_1');
  assert.equal(describeEvent({ type: 'setupEnded', activityId: 'a-PVTI_1', error: 'setup failed at line 1 (RUN cat .env): exit 1\nTOKEN=secret' }), 'setupEnded activity=a-PVTI_1 failed');
  assert.equal(
    describeEvent({ type: 'spawnFailed', ptyId: PTY, message: 'setup failed at line 1 (RUN cat .env): exit 1\nTOKEN=secret' }),
    'spawnFailed pty=1a2b3c4d setup failed at line 1 (RUN cat .env): exit 1',
  );
});

test('describeEffect: spawn, setColumn, kill, continue and deleteActivity', () => {
  const worker: Worker = { id: WORKER, runId: PTY, status: 'working', activityId: activityIdOf('I30') };
  const stage: Stage = { name: 'dev', from: { board: ['Ready'] }, prompt: 'x' };
  assert.equal(describeEffect({ type: 'spawnTerminal', terminal: { terminalId: PTY, activityId: activityIdOf('I30'), startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo' }, activity: WORK30, task: taskFor('30') }), 'spawnTerminal #30 slug=hive-30-logs pty=1a2b3c4d');
  assert.equal(
    describeEffect({ type: 'spawnTerminal', terminal: { terminalId: PTY, activityId: activityIdOf('I30'), startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo', command: 'Run Frontend' }, activity: WORK30, task: taskFor('30') }),
    'spawnTerminal #30 slug=hive-30-logs pty=1a2b3c4d command="Run Frontend"', // the name only: never the line nor the env (#300)
  );
  assert.equal(describeEffect({ type: 'spawn', worker, activity: WORK30, task: taskFor('30'), stage, session: 'new', run: 'stage' }), 'spawn worker=9f8e7d6c #30 slug=hive-30-logs stage=dev session=new pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'spawn', worker, activity: WORK30, task: taskFor('30'), stage, session: 'continue', run: 'continue' }), 'spawn worker=9f8e7d6c #30 slug=hive-30-logs stage=dev session=continue pty=1a2b3c4d run=continue');
  assert.equal(describeEffect({ type: 'setColumn', itemId: 'PVTI_1', column: 'In review' }), 'setColumn #PVTI_1 → In review');
  assert.equal(describeEffect({ type: 'kill', slug: 'hive-30-logs', ptyId: PTY }), 'kill slug=hive-30-logs pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'continue', ptyId: PTY, activity: WORK30, task: taskFor('30'), stage }), 'continue stage=dev pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'sourceAction', itemId: 'board:I1', taskId: 'board:I1', action: { type: 'archive' } }), 'sourceAction #board:I1 archive'); // #286
  assert.equal(describeEffect({ type: 'deleteActivity', activity: WORK30, task: taskFor('30'), scope: { session: false, transcripts: false, nonAutoTasks: false } }), 'deleteActivity #30 slug=hive-30-logs');
  assert.equal(describeEffect({ type: 'shutdown' }), 'shutdown');
});

test('describeEvent, describeEffect and describeChanges name a local activity\'s runs by their workspace, since they have no task (#292, #590)', () => {
  assert.equal(describeEvent({ type: 'openProjectShell', project: 'hive', cwd: '/repo' }), 'openProjectShell project=hive');
  assert.equal(describeEvent({ type: 'newLocalSession', activityId: localActivityId('hive') }), 'newLocalSession activity=local:hive');
  const terminal = { terminalId: PTY, activityId: localActivityId('hive'), startedAt: '2026-09-26T10:00:00.000Z', cwd: '/repo' };
  assert.equal(describeEffect({ type: 'spawnTerminal', terminal, activity: LOCAL_HIVE }), 'spawnTerminal workspace=hive pty=1a2b3c4d');
  const worker: Worker = { id: WORKER, runId: PTY, status: 'working', activityId: localActivityId('hive'), freeSession: true, sessionId: PTY };
  const prev = withLocal(initialState(0), 'hive');
  assert.deepEqual(describeChanges(prev, { ...prev, workers: [worker] }), [
    'worker 1: empty → working workspace=hive pty=1a2b3c4d',
    `worker 1: session=${PTY} workspace=hive pty=1a2b3c4d`,
    'worker 1: free session new on workspace=hive',
  ]);
});

test('describeEvent and describeEffect name the approval events and effects, never the feedback text (#268)', () => {
  const stage: Stage = { name: 'dev', from: { board: ['Ready'] }, prompt: 'x' };
  const worker: Worker = { id: WORKER, runId: PTY, status: 'working', activityId: activityIdOf('I30') };
  assert.equal(describeEvent({ type: 'approve', activityId: 'a-I30' }), 'approve activity=a-I30');
  assert.equal(describeEvent({ type: 'feedback', activityId: 'a-I30', text: 'secret plan', start: true }), 'feedback activity=a-I30 start chars=11');
  assert.equal(describeEvent({ type: 'feedback', activityId: 'a-I30', text: 'x', start: false }), 'feedback activity=a-I30 queue chars=1');
  assert.equal(describeEvent({ type: 'extendApproval', activityId: 'a-I30' }), 'extendApproval activity=a-I30');
  assert.equal(describeEvent({ type: 'approvalExpired', ptyId: PTY }), 'approvalExpired pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'hold', ptyId: PTY, until: '2026-09-25T12:10:00.000Z' }), 'hold pty=1a2b3c4d until=2026-09-25T12:10:00.000Z');
  assert.equal(describeEffect({ type: 'release', ptyId: PTY }), 'release pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'continue', ptyId: PTY, activity: WORK30, task: taskFor('30'), stage, prompt: 'secret plan' }), 'continue stage=dev pty=1a2b3c4d handover');
  assert.equal(describeEffect({ type: 'spawn', worker, activity: WORK30, task: taskFor('30'), stage, session: 'continue', run: 'continue', prompt: 'secret plan' }), 'spawn worker=9f8e7d6c #30 slug=hive-30-logs stage=dev session=continue pty=1a2b3c4d run=continue handover');
});

test('an input effect names the worker and never the text it types (#483)', () => {
  assert.equal(describeEffect({ type: 'input', ptyId: PTY, text: 'secret plan' }), 'input pty=1a2b3c4d');
});

test('describeChanges lists each worker whose status changed (position in the grid, matched by id); [] when nothing moved; the signal is facts.jsonl\'s (#742)', () => {
  const empty: Worker = { id: WORKER, status: 'empty' };
  const other: Worker = { id: 'b0b0b0b0-3333-4333-8333-333333333333', status: 'empty' };
  const working: Worker = { ...empty, runId: PTY, status: 'working', activityId: activityIdOf('I30') };
  const prev: State = withWork({ ...initialState(0), signal: 'yellow', workers: [empty, other], tasks: [taskFor('30')] }, 'I30');
  const next: State = { ...prev, signal: 'green', workers: [working, other] };
  assert.deepEqual(describeChanges(prev, next), ['worker 1: empty → working #30 pty=1a2b3c4d']);
  const reviewed: State = { ...next, workers: [{ ...working, status: 'review' }, other] };
  assert.deepEqual(describeChanges(next, reviewed), ['worker 1: working → review #30 pty=1a2b3c4d']);
  const freed: State = { ...reviewed, workers: [empty, other] };
  assert.deepEqual(describeChanges(reviewed, freed), ['worker 1: review → empty #30 pty=1a2b3c4d'], 'an emptied worker names what it held');
  assert.deepEqual(describeChanges(next, { ...next, tasks: [taskFor('30'), taskFor('1')], syncs: { board: { polledAt: '2026-09-17T12:00:00.000Z' } } }), []);
  assert.deepEqual(describeChanges(next, { ...next, workers: [working, other, { id: 'c0c0c0c0-4444-4444-8444-444444444444', status: 'empty' }] }), [], 'a worker added by setMax is not a transition');
  const added: Worker = { ...working, id: 'c0c0c0c0-4444-4444-8444-444444444444' };
  assert.deepEqual(describeChanges(next, { ...next, workers: [working, other, added] }), ['worker 3: empty → working #30 pty=1a2b3c4d'], 'a worker that appears already occupied (a start over the cap) is a transition');
});

test('describeChanges emits the session line once, when the id appears, after the status lines and before the signal', () => {
  const session = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const empty: Worker = { id: WORKER, status: 'empty' };
  const working: Worker = { ...empty, runId: PTY, status: 'working', activityId: activityIdOf('I29') };
  const prev: State = withWork({ ...initialState(0), signal: 'yellow', workers: [working], tasks: [taskFor('29')] }, 'I29');
  const started: State = { ...prev, workers: [{ ...working, sessionId: session }] };
  assert.deepEqual(describeChanges(prev, started), [`worker 1: session=${session} #29 pty=1a2b3c4d`]);
  const later: State = { ...started, workers: [{ ...started.workers[0], lastEvent: { kind: 'tool', detail: 'Bash: pnpm test' } }] };
  assert.deepEqual(describeChanges(started, later), [], 'the same id in both states is not a change');
  const both: State = { ...prev, signal: 'green', workers: [{ ...working, status: 'waiting', sessionId: session }] };
  assert.deepEqual(describeChanges(prev, both), [
    'worker 1: working → waiting #29 pty=1a2b3c4d',
    `worker 1: session=${session} #29 pty=1a2b3c4d`,
  ]);
  assert.deepEqual(describeChanges(started, { ...started, workers: [empty] }), ['worker 1: working → empty #29 pty=1a2b3c4d'], 'freeing the worker drops the id silently: its line already left');
});

test('describeChanges names a task whose worktree vanished while stopped; a worker change owns its own line', () => {
  const stopped: WithWork = { ...taskFor('30'), sessionId: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b' };
  // #629: the path and the gone mark are the activity's, the one a worker points at
  const on = (state: State, work: Partial<Activity>): State => withWork(state, 'I30', work);
  const prev: State = on({ ...initialState(0), tasks: [stopped] }, { worktree: '/wt/hive-30-logs' });
  const lost = on(prev, {});
  assert.deepEqual(describeChanges(prev, lost), ['task #30: worktree gone']);
  assert.deepEqual(describeChanges(prev, on(prev, { worktree: '/wt/hive-30-logs', worktreeGone: true })), ['task #30: worktree gone'], 'marked, path kept (#208)');
  const running: State = { ...on(prev, { worktree: '/wt/hive-30-logs', workerId: WORKER }), workers: [{ id: WORKER, runId: PTY, status: 'working', activityId: activityIdOf('I30') }] }; // #629: the run is the activity's
  const freed: State = { ...on(running, {}), workers: [{ id: WORKER, status: 'empty' }], tasks: [stopped] };
  assert.deepEqual(describeChanges(running, freed), ['worker 1: working → empty #30 pty=1a2b3c4d'], 'the path leaving with the worker is not a second line');
  assert.deepEqual(describeChanges(prev, { ...prev, tasks: [] }), [], 'a task that left says nothing here');
  assert.deepEqual(describeChanges(prev, { ...lost, signal: 'red' }), ['task #30: worktree gone'], 'the signal is signal.changed in facts.jsonl (#742)');
});

test('describeChanges names the auto switch, the worktree a task with auto off got, its move and each free session, new or resumed (#164, #283, #573)', () => {
  const stopped: WithWork = { ...taskFor('30'), sessionId: 'kept-session-id-0001' };
  const kept = { id: 'kept-session-id-0001', startedAt: '', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '' }; // #629: the task's session, in its record
  const prev: State = { ...initialState(0), workers: [{ id: WORKER, status: 'empty' }], tasks: [stopped], activityRecords: [{ id: 'r30', taskIds: ['I30'], sessions: [kept] }] };
  const marked: State = { ...prev, tasks: [{ ...stopped, auto: false }] };
  assert.deepEqual(describeChanges(prev, marked), ['task #30: auto off']);
  assert.deepEqual(describeChanges(marked, prev), ['task #30: auto on']);
  const ready: State = withWork(marked, 'I30', { id: 'r30', worktree: '/wt/hive-30-logs', branch: 'hive/30-logs' }, { sessions: [kept] }); // #629: on the activity
  assert.deepEqual(describeChanges(marked, ready), ['task #30: worktree ready (hive/30-logs)']);
  const resumed: State = { ...ready, workers: [{ id: WORKER, status: 'working', runId: PTY, activityId: 'r30', freeSession: true, sessionId: 'kept-session-id-0001' }] };
  assert.deepEqual(describeChanges(ready, resumed), [
    'worker 1: empty → working #30 pty=1a2b3c4d',
    'worker 1: session=kept-session-id-0001 #30 pty=1a2b3c4d',
    'worker 1: free session continue on #30',
  ]);
  const fresh: State = { ...resumed, workers: [{ ...resumed.workers[0], sessionId: 'a1b2c3d4-0000-4000-8000-000000000009' }] };
  assert.equal(describeChanges(ready, fresh).at(-1), 'worker 1: free session new on #30');
  assert.deepEqual(describeChanges(ready, { ...ready, tasks: [{ ...ready.tasks[0], stage: 'review' }] }), [], 'a move is task.moved in facts.jsonl (#742)');
});

test('a message with line breaks stays one log line, and an oversized one is cut: the file is always grep-able', async (t) => {
  const dir = await logDir(t);
  const log = createLogger(dir, 'info', { stderr: quiet });
  log.error('board.listQueue: gh api graphql: line one\nline two\r\nERROR forged'); // gh stderr, or a hook_event_name from any local process
  log.info(`x${'y'.repeat(MESSAGE_MAX + 100)}`);
  const lines = tail(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'ERROR board.listQueue: gh api graphql: line one line two ERROR forged');
  assert.equal(lines[1].length, 'INFO  '.length + MESSAGE_MAX);
});

test('describeEvent names the workspaces events and the workspace a start carries (#179)', () => {
  assert.equal(describeEvent({ type: 'setWorkspaces', workspaces: ['hive', 'site'], sourceWorkspaces: { work: 'site', notes: 'hive' }, commands: {}, workspaceColors: {} }), 'setWorkspaces hive,site defaults=work:site,notes:hive');
  assert.equal(describeEvent({ type: 'setWorkspaces', workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, workspaceColors: {} }), 'setWorkspaces hive');
  assert.equal(describeEvent({ type: 'setWorkspace', taskId: 'I1', workspace: 'site' }), 'setWorkspace #I1 site');
  assert.equal(describeEvent({ type: 'start', itemId: 'I1', workspace: 'site' }), 'start #I1 workspace=site');
  assert.equal(describeEvent({ type: 'start', itemId: 'I1' }), 'start #I1');
});
test('describeEvent names a disabled or re-enabled rule by its source and percent, and a timed disable by its time (#297)', () => {
  assert.equal(describeEvent({ type: 'disableRule', source: 'session', percent: 80, until: { kind: 'reset' } }), 'disableRule session≥80 until=reset');
  assert.equal(describeEvent({ type: 'disableRule', source: 'hour', percent: 50, until: { kind: 'at', at: '2026-09-25T15:00:00.000Z' } }), 'disableRule hour≥50 until=2026-09-25T15:00:00.000Z');
  assert.equal(describeEvent({ type: 'disableRule', source: 'week', percent: 90, until: { kind: 'manual' } }), 'disableRule week≥90 until=manual');
  assert.equal(describeEvent({ type: 'enableRule', source: 'week', percent: 90 }), 'enableRule week≥90');
  assert.equal(describeEvent({ type: 'disableRule', source: 'week', percent: 90, agent: 'codex', until: { kind: 'manual' } }), 'disableRule week≥90 agent=codex until=manual');
  assert.equal(describeEvent({ type: 'enableRule', source: 'week', percent: 90, agent: 'codex' }), 'enableRule week≥90 agent=codex');
});


test('poll, pollFailed and sourceQuota lines name the source, a source-less poll shows "-", and setSources lists the sources (#180)', () => {
  assert.equal(describeEvent({ type: 'poll', source: 'work', items: [] }), 'poll source=work items=0 ids=');
  assert.equal(describeEvent({ type: 'poll', items: [] }), 'poll source=- items=0 ids=');
  assert.equal(describeEvent({ type: 'pollFailed', source: 'notes', message: 'project not found' }), 'pollFailed source=notes project not found');
  assert.equal(describeEvent({ type: 'setSources', sources: ['work', 'notes'] }), 'setSources work,notes');
  assert.equal(describeEvent({ type: 'renameSources', renames: { work: 'job', a: 'b' } }), 'renameSources work→job,a→b'); // #278
  assert.equal(describeEvent({ type: 'renameStages', renames: { Backlog: 'Spec', a: 'b' } }), 'renameStages Backlog→Spec,a→b'); // #861
});

test('describeEffect names a local session by its workspace and a copy\'s first run, and dropCopiedTranscript by the short id only, never the dir (#587)', () => {
  const worker = { id: 'a1b2c3d4-9', status: 'working' as const, runId: 'b1b2c3d4-9' };
  assert.equal(describeEffect({ type: 'spawnSession', worker, activity: LOCAL_HIVE, sessionId: 'c1b2c3d4-9', continues: false, copy: { from: 'd1b2c3d4-9' } }),
    'spawnSession worker=a1b2c3d4 workspace=hive session=copy pty=b1b2c3d4');
  assert.equal(describeEffect({ type: 'dropCopiedTranscript', dir: '/somewhere/private', sessionId: 'd1b2c3d4-9' }), 'dropCopiedTranscript d1b2c3d4');
});

test('describeEvent names a copy by its ends and flags, never the name or the notice, and the local session events by workspace and short id (#587)', () => {
  const s = 'a1b2c3d4-0000-4000-8000-000000000001';
  assert.equal(describeEvent({ type: 'copySession', from: { activityId: 'fedcba98-0000-4000-8000-000000000003', sessionId: s }, to: { activityId: localActivityId('hive') }, name: 'secret words', notice: 'text', copied: '/x' }),
    `copySession activity=fedcba98 ${shortId(s)} → activity=local:hive notice copied`); // #629: a task's activity by its short id, a local one whole
  assert.equal(describeEvent({ type: 'copySession', from: { activityId: localActivityId('hive'), sessionId: s }, to: { activityId: '0badcafe-0000-4000-8000-000000000004' } }), `copySession activity=local:hive ${shortId(s)} → activity=0badcafe`);
  assert.equal(describeEvent({ type: 'openLocalSession', activityId: localActivityId('hive'), sessionId: s }), `openLocalSession activity=local:hive ${shortId(s)}`);
  assert.equal(describeEvent({ type: 'clearLocalSession', activityId: localActivityId('hive'), sessionId: s }), `clearLocalSession activity=local:hive ${shortId(s)}`);
});

test('describeEvent appends a SessionEnd\'s reason and a SessionStart\'s source, so the log shows why a /clear kept the run (#655)', () => {
  assert.equal(describeEvent({ type: 'hook', ptyId: PTY, payload: { hook_event_name: 'SessionEnd', reason: 'clear' } }), 'hook SessionEnd pty=1a2b3c4d reason=clear');
  assert.equal(describeEvent({ type: 'hook', ptyId: PTY, payload: { hook_event_name: 'SessionStart', source: 'clear' } }), 'hook SessionStart pty=1a2b3c4d source=clear');
  assert.equal(describeEvent({ type: 'hook', ptyId: PTY, payload: { hook_event_name: 'SessionEnd' } }), 'hook SessionEnd pty=1a2b3c4d', 'no reason, no suffix');
});

test('describeEvent names a stop\'s cause and a forgetSlept, describeEffect a forgetScrollback, by short ids only (#672)', () => {
  assert.equal(describeEvent({ type: 'stop', ptyId: PTY, cause: 'all' }), 'stop pty=1a2b3c4d cause=all');
  assert.equal(describeEvent({ type: 'stop', ptyId: PTY, block: true }), 'stop pty=1a2b3c4d block');
  assert.equal(describeEvent({ type: 'forgetSlept', ptyId: PTY }), 'forgetSlept pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'forgetScrollback', ptyId: PTY }), 'forgetScrollback pty=1a2b3c4d');
});

test('describeEvent names the terminal events by short id and only says a cwd was read, never the path; describeEffect names readCwd and dropTerminalFiles (#696)', () => {
  assert.equal(describeEvent({ type: 'sleepTerminal', terminalId: PTY, cwd: '/repo/src' }), 'sleepTerminal pty=1a2b3c4d cwd');
  assert.equal(describeEvent({ type: 'sleepTerminal', terminalId: PTY }), 'sleepTerminal pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'wakeTerminal', terminalId: PTY }), 'wakeTerminal pty=1a2b3c4d');
  assert.equal(describeEvent({ type: 'forgetTerminal', terminalId: PTY }), 'forgetTerminal pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'readCwd', terminalId: PTY }), 'readCwd pty=1a2b3c4d');
  assert.equal(describeEffect({ type: 'dropTerminalFiles', terminalId: PTY }), 'dropTerminalFiles pty=1a2b3c4d');
});

test('a line is kept on one line whatever control, separator or bidi character it carries: each run becomes one space (#742)', async (t) => {
  const dir = await logDir(t);
  const log = createLogger(dir, 'info', { stderr: quiet });
  log.info('a\u0000b\u0085c d e‮f⁦g‏h\r\ni');
  assert.deepEqual(tail(dir), ['INFO  a b c d e f g h i']);
});

test('record writes a line at its level without the stderr echo error has; the file is created 0600 (#742)', async (t) => {
  const dir = await logDir(t);
  const calls: string[] = [];
  const log = createLogger(dir, 'info', { stderr: (line) => { calls.push(line); } });
  log.record('error', 'run.spawn_failed code=git_failed');
  log.record('debug', 'source.polled source=board');
  assert.deepEqual(tail(dir), ['ERROR run.spawn_failed code=git_failed']);
  assert.deepEqual(calls, []);
  assert.equal(statSync(join(dir, LOG_FILE)).mode & 0o777, 0o600);
});

test('two appenders on one file (the daemon and a process beside it) rotate on the file\'s real size, so one never rotates away the other\'s fresh .1 (#742)', async (t) => {
  const dir = await logDir(t);
  const first = createAppender(dir, 'shared.log', { maxBytes: 100, stderr: quiet });
  const second = createAppender(dir, 'shared.log', { maxBytes: 100, stderr: quiet });
  first(`${'a'.repeat(59)}\n`);
  second(`${'b'.repeat(59)}\n`); // its own count says 60; the file holds 120
  first(`${'c'.repeat(49)}\n`); // 60 + 50 > 100: rotates the 120 bytes away
  second(`${'d'.repeat(49)}\n`); // its own count says 60 + 50 > 100, but the file holds 50: no rotation
  assert.equal(statSync(join(dir, 'shared.log.1')).size, 120);
  assert.equal(statSync(join(dir, 'shared.log')).size, 100);
});

test('retryDue names its pty and its until; a StopFailure hook line never carries the payload\'s details or message (#805)', () => {
  assert.equal(describeEvent({ type: 'retryDue', ptyId: PTY, until: '2026-10-06T12:01:00.000Z' }), 'retryDue pty=1a2b3c4d until=2026-10-06T12:01:00.000Z');
  const payload = { hook_event_name: 'StopFailure', error: 'overloaded', error_details: 'SECRET-DETAILS', last_assistant_message: 'SECRET-MESSAGE' } as HookPayload;
  assert.equal(describeEvent({ type: 'hook', ptyId: PTY, payload }), 'hook StopFailure pty=1a2b3c4d');
});

test('setSignals logs its opening signal only: the rows are config, read from the file (#727)', () => {
  assert.equal(describeEvent({ type: 'setSignals', signals: SIGNALS_DEFAULTS }), 'setSignals onOpen=yellow');
});

test('describeEvent names a retry by its task only (#915)', () => {
  assert.equal(describeEvent({ type: 'retry', taskId: 'board:I7' }), 'retry #board:I7');
});

test('describeEvent names a dismissError by its task only (#354)', () => {
  assert.equal(describeEvent({ type: 'dismissError', taskId: 'board:I7' }), 'dismissError #board:I7');
});

test('describeEvent and describeEffect name a checkpoint by number, stage and end, never its shas (#619)', () => {
  const checkpoint: Checkpoint = { n: 2, stage: 'dev', start: 'a1b2c3d', head: 'b2c3d4e', commit: 'c3d4e5f', branch: 'hive/1-x', at: '2026-10-10T10:00:00.000Z', ended: 'restart' };
  assert.equal(describeEvent({ type: 'checkpointCaptured', activityId: 'fedcba98-0000-4000-8000-000000000002', checkpoint }), 'checkpointCaptured activity=fedcba98 n=2 stage=dev ended=restart');
  assert.equal(describeEvent({ type: 'restoring', itemId: 'board:I1' }), 'restoring #board:I1');
  assert.equal(describeEvent({ type: 'restored', itemId: 'board:I1', branch: 'hive/1-x-r2' }), 'restored #board:I1 branch=hive/1-x-r2');
  assert.equal(describeEvent({ type: 'restoreFailed', itemId: 'board:I1' }), 'restoreFailed #board:I1');
  const task = { item: { itemId: 'board:I1', id: '1', title: 't', body: '', url: '' }, stage: 'dev', boardColumn: 'x', auto: true };
  const activity = { id: 'a', kind: 'task' as const, workspace: 'hive', slug: 'hive-1-x' };
  assert.equal(describeEffect({ type: 'captureCheckpoint', activity, task, stage: 'dev', ended: 'done' }), 'captureCheckpoint #1 slug=hive-1-x stage=dev');
});

test('the createTask line says pr=yes for a task made from a PR, never its link (#67)', () => {
  const event = { type: 'createTask', title: 'T', body: '', stage: 'fila', prefix: 'HIVE', auto: false } as const;
  const link = 'https://github.com/acme/app/pull/7';
  const line = describeEvent({ ...event, pr: { url: link, recordId: '0d9a2f3e-1111-4222-8333-444455556666' } });
  assert.equal(line, 'createTask stage=fila prefix=HIVE pr=yes');
  assert.ok(!line.includes(link));
  assert.equal(describeEvent(event), 'createTask stage=fila prefix=HIVE');
});

test('captureSession names a resume by its session\'s short id, and - while the id is learnt late (#347)', () => {
  const S = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const base = { type: 'captureSession' as const, terminalId: PTY, runId: PTY, agent: 'claude' as const };
  assert.equal(describeEvent(base), `captureSession pty=${shortId(PTY)} run=${shortId(PTY)}`);
  assert.equal(describeEvent({ ...base, resume: { sessionId: S, activityId: 'a-1' } }), `captureSession pty=${shortId(PTY)} run=${shortId(PTY)} resume=${shortId(S)}`);
  assert.equal(describeEvent({ ...base, resume: {} }), `captureSession pty=${shortId(PTY)} run=${shortId(PTY)} resume=-`);
});

test('describeEffect names a cleared run\'s transcript removal by task, slug and short session id, never its dir (#494)', () => {
  const task = { item: { itemId: 'board:I1', id: '1', title: 't', body: '', url: '' }, stage: 'plan', boardColumn: 'x', auto: true };
  const activity = { id: 'a', kind: 'task' as const, workspace: 'hive', slug: 'hive-1-x' };
  const at = '2026-10-22T10:00:00.000Z';
  const session = { id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: at, stages: ['spec'], lastUsedAt: at, agent: 'claude' as const };
  assert.equal(describeEffect({ type: 'removeTranscripts', task, activity, session }), 'removeTranscripts #1 slug=hive-1-x a1b2c3d4');
});
