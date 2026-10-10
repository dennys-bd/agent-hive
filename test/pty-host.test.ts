import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createPtyHost, MODES_OFF, NO_PTY, PTY_SCROLLBACK_BYTES } from '../src/pty-host.js';
import { SLEPT_MAX } from '../src/types.js';
import { fakePtys } from './fakes.js';
import { tempDir } from './temp-dir.js';

const ENV = { PATH: '/bin', HIVE_PTY_ID: 'W1' };
const WORKTREE = '/repo/.hive/worktrees/hive-1-task';

// A host with one worker, W1, running in a fake pty
function hosted() {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('W1', ['/bin/sh', '-c', 'claude'], WORKTREE, ENV);
  return { host, pty: ptys[0] };
}

test('spawn runs the argv in the worktree with the env at 200x50; subscribe replays what the pty printed so far, then the live output, until unsubscribed (#251)', () => {
  const { host, pty } = hosted();
  assert.deepEqual([pty.file, pty.args, pty.options], ['/bin/sh', ['-c', 'claude'], { cwd: WORKTREE, env: ENV, cols: 200, rows: 50 }]);
  pty.emit('one ');
  pty.emit('two ');
  const seen: string[] = [];
  const stop = host.subscribe('W1', (data) => seen.push(data), () => {});
  assert.deepEqual(seen, ['one two '], 'the scrollback first, in one chunk');
  pty.emit('three');
  stop?.();
  pty.emit('four');
  assert.deepEqual(seen, ['one two ', 'three']);
  const late: string[] = [];
  host.subscribe('W1', (data) => late.push(data), () => {});
  assert.deepEqual(late, ['one two threefour'], 'a tab opened late still sees the history');
});

test('the scrollback keeps only the last PTY_SCROLLBACK_BYTES of output (#251)', () => {
  const { host, pty } = hosted();
  pty.emit('old');
  pty.emit('a'.repeat(PTY_SCROLLBACK_BYTES - 1));
  pty.emit('xyz');
  const replays: string[] = [];
  host.subscribe('W1', (data) => replays.push(data), () => {});
  assert.equal(PTY_SCROLLBACK_BYTES, 1024 * 1024);
  assert.equal(replays.length, 1);
  assert.equal(replays[0].length, PTY_SCROLLBACK_BYTES);
  assert.equal(replays[0], `${'a'.repeat(PTY_SCROLLBACK_BYTES - 3)}xyz`);
});

test('input and resize reach the pty and kill kills it; each answers whether the worker is known (#251)', () => {
  const { host, pty } = hosted();
  assert.equal(host.write('W1', 'ls\r'), true);
  assert.equal(host.resize('W1', 120, 40), true);
  assert.equal(host.kill('W1'), true);
  assert.deepEqual([pty.written, pty.sizes, pty.killed], [['ls\r'], [[120, 40]], 1]);
});

test('the pty exiting notifies every subscriber once and drops the worker, its scrollback with it (#251)', () => {
  const { host, pty } = hosted();
  let exits = 0;
  host.subscribe('W1', () => {}, () => { exits += 1; });
  host.subscribe('W1', () => {}, () => { exits += 1; });
  pty.emit('bye');
  pty.exit();
  assert.equal(exits, 2);
  assert.deepEqual([host.has('W1'), host.subscribe('W1', () => {}, () => {}), host.write('W1', 'x')], [false, undefined, false]);
});

test('an unknown worker is a no-op everywhere, never a throw (#251)', () => {
  const { host } = hosted();
  assert.equal(host.has('nope'), false);
  assert.equal(host.write('nope', 'x'), false);
  assert.equal(host.resize('nope', 1, 1), false);
  assert.equal(host.kill('nope'), false);
  assert.equal(host.subscribe('nope', () => {}, () => {}), undefined);
});

test('adopt serves a pty the host did not spawn like a spawned one: scrollback for a late viewer, live output, and its exit drops it (#351)', () => {
  const host = createPtyHost(NO_PTY);
  const { spawnPty, ptys } = fakePtys();
  host.adopt('setup:board:I1', spawnPty('/bin/true', [], { cwd: WORKTREE, env: ENV, cols: 1, rows: 1 }));
  ptys[0].emit('> RUN pnpm install\r\n');
  const seen: string[] = [];
  let exits = 0;
  host.subscribe('setup:board:I1', (data) => seen.push(data), () => { exits += 1; });
  ptys[0].emit('ok\r\n');
  ptys[0].exit();
  assert.deepEqual([seen, exits, host.has('setup:board:I1')], [['> RUN pnpm install\r\n', 'ok\r\n'], 1, false]);
});

// A host with one agent run, A1, whose transcript outlives it (#672)
function agent() {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('A1', ['/bin/sh', '-c', 'claude'], WORKTREE, ENV, {});
  return { host, pty: ptys[0] };
}

test('an agent run\'s exit keeps its scrollback: a later subscribe replays it and ends at once with the exit code; no pty is left to write to (#672)', () => {
  const { host, pty } = agent();
  pty.emit('one ');
  pty.emit('two');
  pty.exit(0);
  assert.equal(host.has('A1'), true);
  const seen: string[] = [];
  const codes: number[] = [];
  const stop = host.subscribe('A1', (data) => seen.push(data), (code) => codes.push(code));
  assert.deepEqual([seen, codes, typeof stop], [['one two'], [0], 'function']);
  assert.deepEqual([host.write('A1', 'x'), host.kill('A1')], [false, false]);
});

test('forget drops an ended run\'s scrollback, and a live one\'s at its exit; a terminal never keeps one (#672)', () => {
  const ended = agent();
  ended.pty.emit('bye');
  ended.pty.exit();
  ended.host.forget('A1');
  assert.deepEqual([ended.host.has('A1'), ended.host.subscribe('A1', () => {}, () => {})], [false, undefined]);
  const live = agent();
  live.host.forget('A1');
  live.pty.exit();
  assert.equal(live.host.has('A1'), false, 'forgotten while it ran: nothing kept');
  const { host, pty } = hosted(); // spawned with no keepsScrollback, as a terminal is
  pty.emit('ls');
  pty.exit();
  assert.equal(host.has('W1'), false);
});

test('the host keeps at most SLEPT_MAX ended runs, the oldest going first (#672)', () => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  for (let i = 0; i <= SLEPT_MAX; i += 1) {
    host.spawn(`A${i}`, ['/bin/sh', '-c', 'claude'], WORKTREE, ENV, {});
    ptys[i].exit();
  }
  assert.deepEqual([host.has('A0'), host.has('A1'), host.has(`A${SLEPT_MAX}`)], [false, true, true]);
});

test('pid answers the pty\'s own process id, undefined for an unknown one (#696)', () => {
  const { host } = hosted();
  assert.deepEqual([host.pid('W1'), host.pid('nope')], [4000, undefined]);
});

test('a kept terminal\'s exit writes its ring to its log, 0600, and keeps it for its sleeping tab past SLEPT_MAX agent runs (#696)', async (t) => {
  const dir = await tempDir(t, 'ring-');
  const log = join(dir, 'T1.log');
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('T1', ['/bin/sh', '-c', 'zsh'], WORKTREE, ENV, { log });
  ptys[0].emit('ls\r\n');
  ptys[0].exit();
  assert.deepEqual([readFileSync(log, 'utf8'), statSync(log).mode & 0o777], ['ls\r\n', 0o600]);
  for (let i = 0; i <= SLEPT_MAX; i += 1) {
    host.spawn(`A${i}`, ['/bin/sh', '-c', 'claude'], WORKTREE, ENV, {});
    ptys[i + 1].exit();
  }
  const seen: string[] = [];
  host.subscribe('T1', (data) => seen.push(data), () => {});
  assert.deepEqual([seen, host.has('A0')], [['ls\r\n'], false], 'only agent runs are pushed out');
});

test('a wake seeded with the old ring replays it first, then a line break and the new shell; restore puts a saved ring back for a sleeping tab (#696)', () => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.restore('T1', 'saved');
  const replayed: string[] = [];
  host.subscribe('T1', (data) => replayed.push(data), () => {});
  host.spawn('T1', ['/bin/sh', '-c', 'zsh'], WORKTREE, ENV, { seed: 'old output' });
  ptys[0].emit('$ ');
  const seen: string[] = [];
  host.subscribe('T1', (data) => seen.push(data), () => {});
  assert.deepEqual([replayed, seen, host.write('T1', 'x')], [['saved'], [`old output${MODES_OFF}\r\n$ `], true]); // #831: the reset after the seed
});

test('a ring the host cannot write is reported by its errno code, never its path, and the exit goes on (#696)', () => {
  const { spawnPty, ptys } = fakePtys();
  const errors: string[] = [];
  const host = createPtyHost(spawnPty, (message) => errors.push(message));
  host.spawn('T1', ['/bin/sh', '-c', 'zsh'], WORKTREE, ENV, { log: '/nonexistent-dir/T1.log' });
  ptys[0].exit();
  assert.deepEqual([errors, host.has('T1')], [['scrollback: ENOENT'], true]);
});

test('a terminal spawned again in its own id keeps its new pty when the old one exits late: no entry dropped, no ended ring served (#696)', () => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('T1', ['/bin/sh', '-c', 'zsh'], WORKTREE, ENV, {});
  host.spawn('T1', ['/bin/sh', '-c', 'zsh'], WORKTREE, ENV, {}); // the wake, before the old pty's exit
  ptys[1].emit('new prompt');
  ptys[0].exit(0);
  assert.equal(host.write('T1', 'ls\r'), true);
  assert.deepEqual([ptys[0].written, ptys[1].written], [[], ['ls\r']]);
  const seen: string[] = [];
  let ended = false;
  host.subscribe('T1', (data) => seen.push(data), () => { ended = true; });
  assert.deepEqual([seen, ended], [['new prompt'], false], 'the live pty, not the old one\'s ended tail');
});

const CLAUDE = ['/bin/sh', '-c', 'claude'];
const gridOf = (pty: { options: { cols: number; rows: number } }): [number, number] => [pty.options.cols, pty.options.rows];

test('a spawn with the page\'s grid spawns the pty at it (#808)', () => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('W1', CLAUDE, WORKTREE, ENV, undefined, { cols: 140, rows: 35 });
  assert.deepEqual(gridOf(ptys[0]), [140, 35]);
});

test('a spawn with no grid starts at 200x50 before any grid, then at the largest a page asked for, columns and rows each at their own maximum (#808)', () => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('A', CLAUDE, WORKTREE, ENV);
  host.spawn('B', CLAUDE, WORKTREE, ENV, undefined, { cols: 150, rows: 40 });
  host.spawn('C', CLAUDE, WORKTREE, ENV, undefined, { cols: 120, rows: 60 });
  host.spawn('D', CLAUDE, WORKTREE, ENV);
  assert.deepEqual(ptys.map(gridOf), [[200, 50], [150, 40], [120, 60], [150, 60]], 'the default 200x50 is no page\'s grid: it grows nothing');
});

test('a resize to the grid the pty already has never reaches it, so the program gets no SIGWINCH; another grid does, and becomes its own (#808)', () => {
  const { host, pty } = hosted(); // spawned at 200x50
  assert.equal(host.resize('W1', 200, 50), true);
  assert.equal(host.resize('W1', 120, 40), true);
  assert.equal(host.resize('W1', 120, 40), true);
  assert.deepEqual(pty.sizes, [[120, 40]]);
});

test('the largest grid grows from a resize too, each side on its own, and a smaller one never shrinks it (#808)', () => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('W1', CLAUDE, WORKTREE, ENV, undefined, { cols: 100, rows: 30 });
  host.resize('W1', 220, 30);
  host.resize('W1', 90, 70);
  host.resize('W1', 80, 24);
  host.spawn('W2', CLAUDE, WORKTREE, ENV);
  assert.deepEqual(gridOf(ptys[1]), [220, 70]);
});

test('a wake\'s reset turns off mouse tracking and its encodings, bracketed paste, application keys, focus reports and the alternate screen, then shows the cursor and resets colours (#831)', () => {
  const off = (mode: string): string => `\x1b[${mode}l`;
  const modes = ['?9', '?1000', '?1002', '?1003', '?1005', '?1006', '?1015', '?1016', '?2004', '?1', '?1004', '?1047'];
  for (const sequence of [...modes.map(off), '\x1b>', '\x1b[?25h', '\x1b[0m']) assert.ok(MODES_OFF.includes(sequence), JSON.stringify(sequence));
  assert.ok(!MODES_OFF.includes('\x1b[?1049l'), 'leaving with 1049 restores a saved cursor: the new prompt would land on a stale row');
});

test('a spawn with no seed, or an empty one, replays no reset: a live program keeps the modes it set (#831)', () => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('T1', ['/bin/sh', '-c', 'zsh'], WORKTREE, ENV, {});
  host.spawn('T2', ['/bin/sh', '-c', 'zsh'], WORKTREE, ENV, { seed: '' });
  host.spawn('W1', CLAUDE, WORKTREE, ENV);
  for (const pty of ptys) pty.emit('$ ');
  const replays = ['T1', 'T2', 'W1'].map((id) => {
    const seen: string[] = [];
    host.subscribe(id, (data) => seen.push(data), () => {});
    return seen;
  });
  assert.deepEqual(replays, [['$ '], ['$ '], ['$ ']]);
});
