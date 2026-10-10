import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_KINDS, CHARS_PER_LINE, checkChannel, commandChannel, crlf, formatChannel, lspChannel, commandLine, createConsoleStore, failLine, okLine, runHeader, runLabel, orphanTeardownRunId, teardownRunId, stageChannel } from '../src/console.js';

const TEST = commandChannel('hive', 'test');
const DEV = commandChannel('site', 'dev');
const H12 = '── #12 · 14:03:07 ──\r\n';
const H15 = '── #15 · 14:05:59 ──\r\n';
const H20 = '── #20 · 14:06:00 ──\r\n';

test('commandChannel keys a command by workspace and name, labelled workspace · name; runHeader stamps the task and the local time; runLabel reads #task · HH:MM back (#353)', () => {
  assert.deepEqual(TEST, { id: 'command:hive:test', kind: 'command', label: 'hive · test' });
  assert.equal(runHeader('#12', new Date(2026, 8, 27, 14, 3, 7)), H12);
  assert.equal(runHeader('#HIVE-3', new Date(2026, 8, 27, 9, 0, 5)), '── #HIVE-3 · 09:00:05 ──\r\n');
  assert.deepEqual([runLabel(H12), runLabel('── #HIVE-3 · 09:00:05 ──\r\n')], ['#12 · 14:03', '#HIVE-3 · 09:00']);
});

test('runHeader names the run\'s kind after its label, a task\'s #id or an orphan\'s slug; runLabel keeps both; a command run\'s header has no kind (#654)', () => {
  const at = new Date(2026, 8, 30, 14, 2, 11);
  assert.equal(runHeader('#654', at, 'teardown'), '── #654 · teardown · 14:02:11 ──\r\n');
  assert.equal(runHeader('#654', at, 'setup'), '── #654 · setup · 14:02:11 ──\r\n');
  assert.equal(runHeader('my-slug', at, 'teardown'), '── my-slug · teardown · 14:02:11 ──\r\n');
  assert.deepEqual(
    [runLabel(runHeader('#654', at, 'setup')), runLabel(runHeader('my-slug', at, 'teardown')), runLabel(runHeader('#12', at))],
    ['#654 · setup · 14:02', 'my-slug · teardown · 14:02', '#12 · 14:02'],
  );
  assert.equal(teardownRunId('hive:my-slug'), 'teardown:hive:my-slug');
});

test('runHeader strips control characters from the label: an orphan\'s slug is a worker-chosen folder name (#654)', () => {
  const header = runHeader('evil\x1b[2J\r\nslug\x7f\x00', new Date(2026, 8, 30, 14, 2, 11), 'teardown');
  assert.equal(header, '── evil[2Jslug · teardown · 14:02:11 ──\r\n');
});

test('an orphan\'s teardown run id is built from encoded parts, so a slug with a colon or a slash cannot forge another run\'s id (#654)', () => {
  assert.equal(orphanTeardownRunId('hive', 'my-slug'), 'teardown:hive:my-slug');
  assert.equal(orphanTeardownRunId('hive', 'a:b/c'), 'teardown:hive:a%3Ab%2Fc');
  assert.notEqual(orphanTeardownRunId('a', 'b:c'), orphanTeardownRunId('a:b', 'c'));
});

test('every run of one command lands in its channel whatever the task, its header first; channels list newest begin first (#537); an unknown channel has no view (#353)', () => {
  const store = createConsoleStore(() => 1000);
  store.begin(TEST, 'W12', H12);
  store.begin(DEV, 'W20', H20);
  store.begin(TEST, 'W15', H15);
  store.append('W12', 'ok 1\r\n');
  assert.deepEqual(store.channels(), [{ ...TEST, status: 'running' }, { ...DEV, status: 'running' }]);
  assert.deepEqual(store.history(TEST.id), { history: '', live: [{ ptyId: 'W12', header: H12 }, { ptyId: 'W15', header: H15 }], status: 'running' });
  store.end('W12');
  assert.deepEqual(store.history(TEST.id), { history: `${H12}ok 1\r\n`, live: [{ ptyId: 'W15', header: H15 }], status: 'running' });
  assert.deepEqual(store.history(DEV.id), { history: '', live: [{ ptyId: 'W20', header: H20 }], status: 'running' }, 'another channel is untouched');
  assert.equal(store.history('command:hive:nope'), undefined);
});

test('finished runs join the history in the order they ended, each contiguous, however their output interleaved while live (#353)', () => {
  const store = createConsoleStore(() => 1000);
  store.begin(TEST, 'W12', H12);
  store.begin(TEST, 'W15', H15);
  store.append('W12', 'a1\r\n');
  store.append('W15', 'b1\r\n');
  store.append('W12', 'a2\r\n');
  store.end('W15');
  store.end('W12');
  assert.equal(store.history(TEST.id)?.history, `${H15}b1\r\n${H12}a1\r\na2\r\n`);
});

test('a channel keeps at most maxLines lines over its history and live runs: whole lines go from the oldest finished run first, then from the oldest live run, whose header stays in its view (#353)', () => {
  const store = createConsoleStore(() => 4);
  store.begin(TEST, 'W12', H12);
  store.append('W12', 'a1\r\na2\r\n');
  store.end('W12'); // 3 lines
  store.begin(TEST, 'W15', H15); // 4: at the limit
  assert.equal(store.history(TEST.id)?.history, `${H12}a1\r\na2\r\n`);
  store.append('W15', 'b1\r\n'); // 5: the finished run's first line, its header, goes
  assert.equal(store.history(TEST.id)?.history, 'a1\r\na2\r\n');
  store.append('W15', 'b2\r\nb3\r\n'); // 6: the finished run goes whole
  assert.equal(store.history(TEST.id)?.history, '');
  store.append('W15', 'b4\r\n'); // 5: the live run's own head, its header, goes
  assert.deepEqual(store.history(TEST.id)?.live, [{ ptyId: 'W15', header: H15 }], 'the page still writes its header');
  store.end('W15');
  assert.equal(store.history(TEST.id)?.history, 'b1\r\nb2\r\nb3\r\nb4\r\n');
});

test('an unknown worker id on append or end does nothing, and so does one that already ended; a run that never printed ends with its header (#353)', () => {
  const store = createConsoleStore(() => 1000);
  store.append('W0', 'stray');
  store.end('W0');
  assert.deepEqual(store.channels(), []);
  store.begin(TEST, 'W12', H12);
  store.end('W12');
  store.append('W12', 'late');
  store.end('W12');
  assert.deepEqual(store.history(TEST.id), { history: H12, live: [], status: 'done' });
});

test('maxLines is read at every trim: a lower limit applies to the next output, without a new store (#353)', () => {
  let max = 1000;
  const store = createConsoleStore(() => max);
  store.begin(TEST, 'W12', H12);
  store.append('W12', 'a1\r\na2\r\n');
  store.end('W12');
  max = 2;
  assert.equal(store.history(TEST.id)?.history, `${H12}a1\r\na2\r\n`, 'nothing trims before the next output');
  store.begin(TEST, 'W15', H15); // 4 lines against 2
  assert.equal(store.history(TEST.id)?.history, 'a2\r\n');
});

test('output that never breaks a line is still bounded: a channel keeps at most maxLines * CHARS_PER_LINE characters (#353)', () => {
  const store = createConsoleStore(() => 100);
  store.begin(TEST, 'w1', H12);
  for (let i = 0; i < 2000; i += 1) store.append('w1', `\r${String(i).padStart(60, '.')}`);
  store.end('w1');
  const history = store.history(TEST.id)?.history ?? '';
  assert.equal(history.length, 100 * CHARS_PER_LINE);
  assert.ok(history.endsWith(String(1999).padStart(60, '.')), 'the newest output stays');
});

test('a channel reads running while a run is live, then failed or done by how its last run to end exited; a begin moves it to the head (#537)', () => {
  const store = createConsoleStore(() => 1000);
  store.begin(TEST, 'W12', H12);
  store.begin(DEV, 'W20', H20);
  store.end('W12', 1);
  store.end('W20', 0);
  assert.deepEqual(store.channels().map((c) => [c.id, c.status]), [[DEV.id, 'done'], [TEST.id, 'failed']]);
  store.begin(TEST, 'W15', H15);
  assert.deepEqual(store.channels().map((c) => [c.id, c.status]), [[TEST.id, 'running'], [DEV.id, 'done']]);
  store.end('W15');
  assert.equal(store.channels()[0].status, 'done', 'no exit code reads as a clean end');
});

test('clear drops a channel\'s finished runs and keeps its live ones, with nothing failed left to show; an unknown channel answers false (#537)', () => {
  const store = createConsoleStore(() => 1000);
  store.begin(TEST, 'W12', H12);
  store.end('W12', 1);
  store.begin(TEST, 'W15', H15);
  assert.equal(store.clear(TEST.id), true);
  assert.deepEqual(store.history(TEST.id), { history: '', live: [{ ptyId: 'W15', header: H15 }], status: 'running' });
  store.begin(DEV, 'W20', H20);
  store.end('W20', 1);
  store.clear(DEV.id);
  assert.equal(store.channels().find((c) => c.id === DEV.id)?.status, 'done');
  assert.equal(store.clear('command:hive:nope'), false);
});

test('commandLine, okLine and failLine wrap a line in bright white, green and red, each ending with a reset; the newline stays the caller\'s (#576)', () => {
  assert.equal(commandLine('> git status'), '\x1b[97m> git status\x1b[0m');
  assert.equal(okLine('ok 12ms'), '\x1b[32mok 12ms\x1b[0m');
  assert.equal(failLine('fatal: nope'), '\x1b[31mfatal: nope\x1b[0m');
});

test('formatChannel keys a formatter by workspace and name, kind format, labelled workspace · name; CHANNEL_KINDS lists it; crlf turns a pipe\'s \\n into \\r\\n (#749)', () => {
  assert.deepEqual(formatChannel('ui', 'ruff'), { id: 'format:ui:ruff', kind: 'format', label: 'ui · ruff' });
  assert.ok(CHANNEL_KINDS.includes('format'));
  assert.equal(crlf('a\nb\r\nc'), 'a\r\nb\r\nc');
});

test('lspChannel keys a language server by workspace and server, kind lsp; CHANNEL_KINDS lists it (#780)', () => {
  assert.deepEqual(lspChannel('hive', 'pyright'), { id: 'lsp:hive:pyright', kind: 'lsp', label: 'hive · pyright' });
  assert.ok(CHANNEL_KINDS.includes('lsp'));
});

test('the store tells its listener when a channel is added or a run ends, never on output (#780)', () => {
  let changes = 0;
  const store = createConsoleStore(() => 100, () => { changes += 1; });
  store.begin(formatChannel('hive', 'prettier'), 'F1', H12);
  assert.equal(changes, 1, 'a begin adds a channel or a run');
  store.append('F1', 'out\r\n');
  store.append('nope', 'x');
  assert.equal(changes, 1, 'output changes no channel and no status');
  store.end('nope', 0);
  assert.equal(changes, 1, 'an unknown run ends nothing');
  store.end('F1', 1);
  assert.equal(changes, 2, 'an end changes the channel\'s status');
});

test('stageChannel names a commands stage, one for every task: kind stage, the stage encoded so neither : nor / splits it, labelled stage · <stage> (#755)', () => {
  assert.deepEqual(stageChannel('Checks'), { id: 'stage:Checks', kind: 'stage', label: 'stage · Checks' });
  assert.equal(stageChannel('x/y:z').id, 'stage:x%2Fy%3Az');
  assert.ok(CHANNEL_KINDS.includes('stage'));
});

test('history(id, group) returns only that group\'s finished and live runs, with the status computed over them (#755)', () => {
  const store = createConsoleStore(() => 100);
  const channel = stageChannel('checks');
  store.begin(channel, 'A1', 'a1\r\n', 'ga');
  store.end('A1', 1);
  store.begin(channel, 'B1', 'b1\r\n', 'gb');
  store.end('B1', 0);
  store.begin(channel, 'B2', 'b2\r\n', 'gb');
  assert.deepEqual(store.history(channel.id, 'ga'), { history: 'a1\r\n', live: [], status: 'failed' });
  assert.deepEqual(store.history(channel.id, 'gb'), { history: 'b1\r\n', live: [{ ptyId: 'B2', header: 'b2\r\n' }], status: 'running' });
  store.end('B2', 0);
  assert.equal(store.history(channel.id, 'gb')?.status, 'done');
  assert.deepEqual(store.history(channel.id, 'nobody'), { history: '', live: [], status: 'done' });
  assert.equal(store.history(channel.id)?.history, 'a1\r\nb1\r\nb2\r\n', 'no group: every run, as before');
  assert.equal(store.history(channel.id)?.status, 'done', 'no group: the last to end decides');
  assert.equal(store.history('nope', 'ga'), undefined);
});

test('checkChannel keys a command-line checker by workspace and id, kind check; CHANNEL_KINDS lists it (#782)', () => {
  assert.deepEqual(checkChannel('hive', 'mypy'), { id: 'check:hive:mypy', kind: 'check', label: 'hive · mypy' });
  assert.ok(CHANNEL_KINDS.includes('check'));
});
