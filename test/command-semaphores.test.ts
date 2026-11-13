import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { type Acquire, type CommandSemaphores, createSemaphores, isPidAlive, lineWords, matchSemaphore, MISSED_TURNS_MAX, type SemaphoresConfig, SWEEP_MS, workspaceLines } from '../src/command-semaphores.js';
import type { Command, SemaphoreEvent, SemaphoreState } from '../src/types.js';

const command = (name: string, impls: Command['impls']): Command => ({ name, impls, menu: true, env: {} });
// #798: `test` holds memory on every workspace but web, whose own line has none; `db` holds disk everywhere
const TEST_COMMAND = command('test', [{ workspace: null, command: 'CI=1 pnpm test && pnpm lint', semaphore: 'memory' }, { workspace: 'web', command: 'pnpm test' }]);
const DB_COMMAND = command('db', [{ workspace: null, command: 'docker compose up', semaphore: 'disk' }]);

test('lineWords: the words of the first command, its leading NAME=value skipped (#798)', () => {
  assert.deepEqual(lineWords('VAR=x pnpm test && pnpm lint'), ['pnpm', 'test']);
  assert.deepEqual(lineWords('  A=1 B_2=y vitest   run\t--reporter=dot | tee out'), ['vitest', 'run', '--reporter=dot'], 'a later NAME=value is an argument');
  for (const line of ['pnpm test; pnpm lint', 'pnpm test || true', 'pnpm test & wait', 'pnpm test&&pnpm lint', 'pnpm test; echo $HOME']) {
    assert.deepEqual(lineWords(line), ['pnpm', 'test'], line);
  }
});

test('lineWords: a first command the daemon would have to expand never matches (#798)', () => {
  for (const line of ['pnpm "test"', "pnpm 'test'", 'pnpm $SCRIPT', 'pnpm `which x`', 'pnpm test > out.txt', 'pnpm test 2>&1', 'pnpm test < in',
    'vitest run *.test.ts', 'vitest run a?.ts', 'vitest run [ab].ts', '(cd web && pnpm test)', 'pnpm test\\ x', 'ls ~', 'echo {a,b}', 'A=1 B=2', '   ']) {
    assert.equal(lineWords(line), undefined, line);
  }
});

test('matchSemaphore: a line matches when its words prefix the argv word for word; the longest wins, then the first (#798)', () => {
  const lines = [{ semaphore: 'disk', words: ['vitest'] }, { semaphore: 'memory', words: ['vitest', 'run'] }, { semaphore: 'other', words: ['vitest', 'run'] }];
  assert.equal(matchSemaphore(['vitest', 'run', 'a.test.ts'], lines), 'memory', 'longest, then first in comb.commands order');
  assert.equal(matchSemaphore(['vitest', 'watch'], lines), 'disk');
  assert.equal(matchSemaphore(['vitest-run'], lines), undefined, 'word for word, never a string prefix');
  assert.equal(matchSemaphore(['npx', 'vitest', 'run'], lines), undefined, 'a prefix, never a substring');
  assert.equal(matchSemaphore([], lines), undefined);
});

test('workspaceLines: each command\'s line resolveCommand picks there, only those with a semaphore and words (#798)', () => {
  const commands = [TEST_COMMAND, DB_COMMAND, command('dev', [{ workspace: null, command: 'pnpm "dev"', semaphore: 'memory' }])];
  assert.deepEqual(workspaceLines(commands, 'api'), [{ semaphore: 'memory', words: ['pnpm', 'test'] }, { semaphore: 'disk', words: ['docker', 'compose', 'up'] }]);
  assert.deepEqual(workspaceLines(commands, 'web'), [{ semaphore: 'disk', words: ['docker', 'compose', 'up'] }], 'web\'s own test line has none');
});

const MEMORY = { name: 'memory', limit: 1, reservation: '2m' };
const DISK = { name: 'disk', limit: 1, reservation: '1m' };
const RESERVATION_MS = 120_000; // MEMORY's
const START = Date.parse('2026-11-13T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const CONFIG: SemaphoresConfig = { commandSemaphores: [MEMORY, DISK], comb: { commands: [TEST_COMMAND, DB_COMMAND] } };
const TEST = ['pnpm', 'test', '--', 'a.test.ts'];
const DB = ['docker', 'compose', 'up', '-d'];
const agent = (ptyId: string, argv = TEST, pid = 100): Acquire => ({ ptyId, workspace: 'api', isAgent: true, argv, pid });
const terminal = (ptyId: string, argv = TEST, pid = 200): Acquire => ({ ...agent(ptyId, argv, pid), isAgent: false });

interface Harness {
  s: CommandSemaphores; events: SemaphoreEvent[];
  advance(ms: number): void; // the clock and the sweep's timer together
  kill(pid: number): void;
  state(): Record<string, SemaphoreState>; // the last setSemaphores
  turns(): SemaphoreEvent[];
}

// A fake clock, a fake pidAlive, a recorded dispatch, and node:test's mock timers for the sweep
function harness(t: TestContext): Harness {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = START;
  const dead = new Set<number>();
  const events: SemaphoreEvent[] = [];
  const s = createSemaphores({ config: CONFIG, dispatch: (e) => { events.push(e); }, now: () => clock, pidAlive: (pid) => !dead.has(pid) });
  t.after(() => s.stop());
  const state = (): Record<string, SemaphoreState> => {
    const last = events.filter((e) => e.type === 'setSemaphores').slice(-1)[0];
    assert.ok(last?.type === 'setSemaphores', 'a snapshot was published');
    return last.semaphores;
  };
  return {
    s, events, state,
    advance: (ms) => { clock += ms; t.mock.timers.tick(ms); },
    kill: (pid) => { dead.add(pid); },
    turns: () => events.filter((e) => e.type === 'semaphoreTurn'),
  };
}

test('the boot publishes an empty entry for every configured semaphore (#798)', (t) => {
  const h = harness(t);
  assert.deepEqual(h.events, [{ type: 'setSemaphores', semaphores: { memory: { runs: [], line: [] }, disk: { runs: [], line: [] } } }]);
});

test('with memory at limit 1, a first matching acquire is granted; a second agent is refused at place 1, again on a retry (#798)', (t) => {
  const h = harness(t);
  assert.equal(h.s.acquire(agent('A')), 'run memory', 'CI=1 pnpm test && pnpm lint matches pnpm test …');
  assert.deepEqual(h.state().memory, { runs: ['A'], line: [] });
  assert.equal(h.s.acquire(agent('B', TEST, 101)), 'refused memory 1');
  assert.equal(h.s.acquire(agent('B', TEST, 101)), 'refused memory 1', 'the place is the pair (pty, semaphore), not the call');
  assert.deepEqual(h.state().memory, { runs: ['A'], line: [{ ptyId: 'B', place: 1 }] });
});

test('release by the holder gives the first in line its turn: one semaphoreTurn with its pty, semaphore and argv, then its acquire is granted (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  const refused = [...TEST, '--watch=false'];
  h.s.acquire(agent('B', refused, 101));
  h.s.release('A', 'memory');
  assert.deepEqual(h.turns(), [{ type: 'semaphoreTurn', ptyId: 'B', semaphore: 'memory', argv: refused }]);
  const at = h.events.findIndex((e) => e.type === 'semaphoreTurn');
  assert.equal(h.events[at + 1]?.type, 'setSemaphores', 'the turn first, then the snapshot');
  assert.deepEqual(h.state().memory, { runs: [], line: [{ ptyId: 'B', place: 0, turnUntil: iso(START + RESERVATION_MS) }] });
  assert.equal(h.s.acquire(agent('C', TEST, 102)), 'refused memory 1', 'a newcomer never takes a reserved permit');
  assert.equal(h.s.acquire(agent('B', TEST, 101)), 'run memory');
  assert.equal(h.turns().length, 1, 'once per turn given');
  assert.deepEqual(h.state().memory, { runs: ['B'], line: [{ ptyId: 'C', place: 1 }] });
});

test('past the reservation the turn moves to the next in line and the pty that missed it goes to the back (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  h.s.acquire(agent('B', TEST, 101));
  h.s.acquire(agent('C', TEST, 102));
  h.s.release('A', 'memory');
  h.advance(RESERVATION_MS + SWEEP_MS);
  const now = START + RESERVATION_MS + SWEEP_MS;
  assert.deepEqual(h.state().memory, { runs: [], line: [{ ptyId: 'C', place: 0, turnUntil: iso(now + RESERVATION_MS) }, { ptyId: 'B', place: 1 }] });
  assert.deepEqual(h.turns().map((e) => (e.type === 'semaphoreTurn' ? e.ptyId : '')), ['B', 'C']);
});

test(`a pty that misses its turn ${MISSED_TURNS_MAX} times in a row leaves the line (#798)`, (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  h.s.acquire(agent('B', TEST, 101));
  h.s.release('A', 'memory');
  for (let missed = 1; missed < MISSED_TURNS_MAX; missed += 1) {
    h.advance(RESERVATION_MS + SWEEP_MS);
    assert.equal(h.state().memory?.line[0]?.ptyId, 'B', `alone in line: after miss ${missed} it is at the back, which is the front`);
  }
  h.advance(RESERVATION_MS + SWEEP_MS);
  assert.deepEqual(h.state().memory, { runs: [], line: [] });
  assert.equal(h.turns().length, MISSED_TURNS_MAX);
});

test('an argv matching no line with a semaphore in the workspace answers run and dispatches nothing; so does the same line where it has none (#798)', (t) => {
  const h = harness(t);
  const before = h.events.length;
  assert.equal(h.s.acquire(agent('A', ['pnpm', 'lint'])), 'run');
  assert.equal(h.s.acquire(agent('A', ['pnpm'])), 'run', 'shorter than the line: no prefix');
  assert.equal(h.s.acquire({ ...agent('A'), workspace: 'web' }), 'run', 'web\'s own test line has no semaphore');
  assert.equal(h.events.length, before);
});

test('a pty\'s end and a holder\'s pid that is gone each free the permit and the place (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A', TEST, 100));
  h.s.acquire(agent('B', TEST, 101));
  h.s.ended('B');
  assert.deepEqual(h.state().memory, { runs: ['A'], line: [] }, 'the end frees its place');
  h.s.acquire(agent('B', TEST, 101));
  h.s.ended('A');
  assert.deepEqual(h.state().memory, { runs: [], line: [{ ptyId: 'B', place: 0, turnUntil: iso(START + RESERVATION_MS) }] }, 'the end frees its permit, the next one\'s turn');
  assert.equal(h.s.acquire(agent('B', TEST, 101)), 'run memory');
  h.kill(101);
  h.advance(SWEEP_MS);
  assert.deepEqual(h.state().memory, { runs: [], line: [] }, 'the sweep frees a permit whose pid is gone');
  h.s.acquire(agent('C', TEST, 102));
  h.kill(102);
  assert.equal(h.s.acquire(agent('D', TEST, 103)), 'run memory', 'and so does the next acquire, before it answers');
  assert.deepEqual(h.state().memory?.runs, ['D']);
});

test('a terminal waits in place where an agent is refused; its release leaves the line; its now is granted above the limit, an agent\'s is ignored (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  assert.equal(h.s.acquire(terminal('T')), 'wait memory 1');
  h.s.release('T', 'memory');
  assert.deepEqual(h.state().memory, { runs: ['A'], line: [] }, 'a shim that stops waiting leaves the line');
  assert.equal(h.s.acquire({ ...agent('B', TEST, 101), now: true }), 'refused memory 1', 'an agent\'s now is answered as without it');
  assert.equal(h.s.acquire(terminal('T')), 'wait memory 2');
  assert.equal(h.s.acquire({ ...terminal('T'), now: true }), 'run memory');
  assert.deepEqual(h.state().memory, { runs: ['A', 'T'], line: [{ ptyId: 'B', place: 1 }] }, 'above the limit, counted in runs; its place is gone');
});

test('an acquire from a pty holding a permit of that semaphore answers run and takes no second permit (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  assert.equal(h.s.acquire(agent('A', ['pnpm', 'test', 'b.test.ts'], 150)), 'run');
  assert.deepEqual(h.state().memory, { runs: ['A'], line: [] });
  h.s.release('A', 'memory');
  assert.deepEqual(h.state().memory, { runs: [], line: [] }, 'one release gives it all back');
});

test('runNow gives a place in line its turn above the limit and dispatches it; a pty with no place there is refused (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  h.s.acquire(agent('B', TEST, 101));
  h.s.acquire(agent('C', TEST, 102));
  assert.equal(h.s.runNow('memory', 'C'), true);
  assert.deepEqual(h.turns(), [{ type: 'semaphoreTurn', ptyId: 'C', semaphore: 'memory', argv: TEST }]);
  assert.deepEqual(h.state().memory, { runs: ['A'], line: [{ ptyId: 'C', place: 0, turnUntil: iso(START + RESERVATION_MS) }, { ptyId: 'B', place: 1 }] }, 'B keeps its place: the run-now permit is outside the count');
  assert.equal(h.s.acquire(agent('C', TEST, 102)), 'run memory');
  assert.deepEqual(h.state().memory?.runs, ['A', 'C']);
  assert.equal(h.s.runNow('memory', 'Z'), false);
  assert.equal(h.s.runNow('gone', 'B'), false);
});

test('two semaphores never change each other\'s answers; a pty holds and waits in both at once (#798)', (t) => {
  const h = harness(t);
  assert.equal(h.s.acquire(agent('A')), 'run memory');
  assert.equal(h.s.acquire(agent('A', DB)), 'run disk', 'a permit of memory does not stop one of disk');
  assert.equal(h.s.acquire(agent('B', TEST, 101)), 'refused memory 1');
  assert.equal(h.s.acquire(agent('B', DB, 101)), 'refused disk 1');
  h.s.release('A', 'disk');
  assert.deepEqual(h.state(), {
    memory: { runs: ['A'], line: [{ ptyId: 'B', place: 1 }] },
    disk: { runs: [], line: [{ ptyId: 'B', place: 0, turnUntil: iso(START + 60_000) }] },
  });
  h.s.ended('B');
  assert.deepEqual(h.state(), { memory: { runs: ['A'], line: [] }, disk: { runs: [], line: [] } }, 'an end frees it in every semaphore');
});

test('apply: a removed semaphore gives each place its turn and leaves State; a raised limit hands out turns; a lowered one keeps the runs and grants nobody new (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  h.s.acquire(agent('B', TEST, 101));
  h.s.acquire(agent('C', TEST, 102));
  h.s.acquire(agent('D', DB, 103));
  h.s.acquire(agent('E', DB, 104));
  const commands = [TEST_COMMAND, command('db', [{ workspace: null, command: 'docker compose up' }])];
  h.s.apply({ commandSemaphores: [{ ...MEMORY, limit: 3 }], comb: { commands } });
  assert.deepEqual(h.turns().map((e) => (e.type === 'semaphoreTurn' ? `${e.ptyId}:${e.semaphore}` : '')), ['E:disk', 'B:memory', 'C:memory']);
  const until = iso(START + RESERVATION_MS);
  assert.deepEqual(h.state(), { memory: { runs: ['A'], line: [{ ptyId: 'B', place: 0, turnUntil: until }, { ptyId: 'C', place: 0, turnUntil: until }] } });
  assert.equal(h.s.acquire(agent('G', DB, 105)), 'run', 'a save changes only later matches');
  h.s.release('D', 'disk');
  h.s.acquire(agent('B', TEST, 101));
  h.s.acquire(agent('C', TEST, 102));
  h.s.apply({ commandSemaphores: [MEMORY], comb: { commands } });
  assert.deepEqual(h.state().memory?.runs, ['A', 'B', 'C'], 'a lowered limit cuts no run');
  assert.equal(h.s.acquire(agent('F', TEST, 106)), 'refused memory 1');
  h.s.release('A', 'memory');
  assert.deepEqual(h.state().memory?.line, [{ ptyId: 'F', place: 1 }], 'runs 2 of limit 1: no turn yet');
  h.s.release('B', 'memory');
  h.s.release('C', 'memory');
  assert.equal(h.state().memory?.line[0]?.place, 0, 'below the limit again: F\'s turn');
});

test('isPidAlive reads a running process as alive (#798)', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive reads EPERM as dead: a pid of another user is not the Hive\'s own shim (#798)', (t) => {
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
  assert.equal(isPidAlive(1), false);
});

test('after stop, a pty end neither dispatches nor restarts the sweep (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  h.s.acquire(agent('B', TEST, 101));
  h.s.stop();
  const spy = t.mock.method(globalThis, 'setInterval');
  const before = h.events.length;
  h.s.ended('A'); // would hand B a turn, which would be busy and arm the timer
  assert.equal(spy.mock.callCount(), 0);
  assert.equal(h.events.length, before);
});

test('run now on a pty already in its turn is refused: no second turn, no extra permit (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  h.s.acquire(agent('B', TEST, 101));
  h.s.acquire(agent('C', TEST, 102));
  h.s.release('A', 'memory');
  assert.equal(h.s.runNow('memory', 'B'), false, 'B has its turn already');
  assert.equal(h.turns().length, 1);
  assert.equal(h.s.acquire(agent('B', TEST, 101)), 'run memory');
  assert.equal(h.s.acquire(agent('C', TEST, 102)), 'refused memory 1', 'the limit held');
});

test('run now reads the clock first: a dead holder is released, so the waiter already has its turn (#798)', (t) => {
  const h = harness(t);
  h.s.acquire(agent('A'));
  h.s.acquire(agent('B', TEST, 101));
  h.kill(100);
  assert.equal(h.s.runNow('memory', 'B'), false);
  assert.equal(h.turns().length, 1);
});
