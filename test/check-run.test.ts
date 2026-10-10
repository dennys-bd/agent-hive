import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type CheckContext, createCheckRuns, runCheck } from '../src/check-run.js';
import { cliCheckerDef } from '../src/checkers.js';
import { createConsoleStore, failLine } from '../src/console.js';
import { tempDir } from './temp-dir.js';

type Store = ReturnType<typeof createConsoleStore>;
const MYPY = cliCheckerDef('mypy');
const SYSTEM_PATH = '/usr/bin:/bin';

// A checker for the test: a shell script in a temp folder, so no test depends on a tool installed on the machine
async function tool(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}
function context(folder: string, store: Store, extra: Partial<CheckContext> = {}): CheckContext {
  return { folder, file: join(folder, 'a.py'), args: [], env: { PATH: SYSTEM_PATH }, workspace: 'hive', label: '#HIVE-1 · a.py', consoleStore: store, signal: new AbortController().signal, ...extra };
}
const history = (store: Store, channel: string): string => store.history(channel)?.history ?? '';
// mypy -O json's line for the file it was given ($4: after --show-column-numbers -O json)
const MYPY_LINE = `printf '{"file": "%s", "line": 2, "column": 4, "message": "bad", "hint": null, "code": "arg-type", "severity": "error"}\\n' "$4"`;

test('a non-zero exit with findings is done: the project\'s copy runs in the folder, its findings relative, its stderr in the console run (#782)', async (t) => {
  const folder = await realpath(await tempDir(t, 'check-run-'));
  await tool(join(folder, '.venv', 'bin', 'mypy'), `echo "checking $(pwd -P)" >&2; ${MYPY_LINE}; exit 1`);
  const store = createConsoleStore(() => 5000);
  const answer = await runCheck(MYPY, context(folder, store));
  assert.ok(answer.state === 'done');
  assert.deepEqual([answer.scope, answer.diagnostics], ['file', [{ path: 'a.py', line: 2, column: 5, severity: 'error', message: 'bad', code: 'arg-type' }]]);
  assert.equal(answer.log.channel, 'check:hive:mypy');
  const log = history(store, 'check:hive:mypy');
  assert.match(log, /^── #HIVE-1 · a\.py · \d\d:\d\d:\d\d ──\r\n/);
  assert.ok(log.includes(`checking ${folder}\r\n`), log);
  assert.deepEqual(store.channels().map((c) => [c.id, c.kind, c.status]), [['check:hive:mypy', 'check', 'done']]);
});

test('no finding with a non-zero exit, the timeout, the cap and a report that does not read are failures: the reason ends the run in red (#782)', async (t) => {
  const folder = await realpath(await tempDir(t, 'check-run-'));
  const cases: [string, string | RegExp, Partial<CheckContext>, 'mypy' | 'pylint'][] = [
    ['echo "mypy.ini: [mypy]: unknown option" >&2; exit 2', 'exit code 2', {}, 'mypy'],
    ['exec /bin/sleep 5', 'timed out after 300 ms', { timeoutMs: 300 }, 'mypy'],
    ["head -c 100 /dev/zero | tr '\\0' a", 'output over 10 bytes', { maxBytes: 10 }, 'mypy'],
    ['echo "Traceback (most recent call last):"; exit 32', /^pylint output does not read: /, {}, 'pylint'],
  ];
  for (const [body, reason, extra, id] of cases) {
    await tool(join(folder, '.venv', 'bin', id), body);
    const store = createConsoleStore(() => 5000);
    const answer = await runCheck(cliCheckerDef(id), context(folder, store, extra));
    assert.ok(answer.state === 'failed', body);
    if (typeof reason === 'string') assert.equal(answer.reason, reason, body);
    else assert.match(answer.reason, reason, body);
    assert.ok(history(store, `check:hive:${id}`).includes(failLine(answer.reason)), body);
    assert.equal(store.channels()[0].status, 'failed', body);
  }
});

test('a newer run of the same target supersedes the older, which answers superseded (#782)', async (t) => {
  const folder = await realpath(await tempDir(t, 'check-run-'));
  await tool(join(folder, '.venv', 'bin', 'mypy'), 'case "$*" in *--slow*) exec /bin/sleep 5 ;; esac; exit 0');
  const store = createConsoleStore(() => 5000);
  const runs = createCheckRuns();
  const older = runs.start('a1\0mypy\0a.py');
  const first = runCheck(MYPY, context(folder, store, { args: ['--slow'], signal: older }));
  const newer = runs.start('a1\0mypy\0a.py');
  const second = await runCheck(MYPY, context(folder, store, { signal: newer }));
  runs.end('a1\0mypy\0a.py', newer);
  assert.deepEqual(await first, { state: 'superseded' });
  assert.ok(second.state === 'done');
  assert.deepEqual(second.diagnostics, []);
  assert.equal(older.aborted, true);
});

test('detekt\'s report is read from the file it was told to write; a checker found nowhere is absent before any console run (#782)', async (t) => {
  const folder = await realpath(await tempDir(t, 'check-run-'));
  const bin = await tempDir(t, 'check-bin-');
  const report = JSON.stringify({ runs: [{ results: [{ ruleId: 'detekt.style.MagicNumber', level: 'warning', message: { text: 'magic' }, locations: [{ physicalLocation: { artifactLocation: { uri: `file://${folder}/A.kt` }, region: { startLine: 3, startColumn: 17 } } }] }] }] });
  await tool(join(bin, 'detekt'), `report="\${4#sarif:}"; printf '%s' '${report}' > "$report"; exit 2`);
  const store = createConsoleStore(() => 5000);
  const answer = await runCheck(cliCheckerDef('detekt'), context(folder, store, { file: join(folder, 'A.kt'), env: { PATH: `${bin}:${SYSTEM_PATH}` } }));
  assert.ok(answer.state === 'done');
  assert.deepEqual(answer.diagnostics, [{ path: 'A.kt', line: 3, column: 17, severity: 'warning', message: 'magic', code: 'detekt.style.MagicNumber' }]);
  const empty = createConsoleStore(() => 5000);
  assert.deepEqual(await runCheck(cliCheckerDef('ktlint'), context(folder, empty, { env: { PATH: '' } })), { state: 'absent' });
  assert.deepEqual(empty.channels(), []);
});

test('a failure names the checker, not the absolute path of its binary (#782)', async (t) => {
  const folder = await realpath(await tempDir(t, 'check-run-'));
  const bin = await tempDir(t, 'check-bin-');
  await writeFile(join(bin, 'mypy'), '#!/nonexistent/interpreter\n');
  await chmod(join(bin, 'mypy'), 0o755);
  const answer = await runCheck(MYPY, context(folder, createConsoleStore(() => 5000), { env: { PATH: `${bin}:${SYSTEM_PATH}` } }));
  assert.ok(answer.state === 'failed');
  assert.ok(!answer.reason.includes(bin), answer.reason);
});

test('a detekt report over the cap is a failure, read or not (#782)', async (t) => {
  const folder = await realpath(await tempDir(t, 'check-run-'));
  const bin = await tempDir(t, 'check-bin-');
  await tool(join(bin, 'detekt'), `report="\${4#sarif:}"; head -c 100 /dev/zero | tr '\\0' a > "$report"; exit 2`);
  const answer = await runCheck(cliCheckerDef('detekt'), context(folder, createConsoleStore(() => 5000), { file: join(folder, 'A.kt'), env: { PATH: `${bin}:${SYSTEM_PATH}` }, maxBytes: 10 }));
  assert.ok(answer.state === 'failed');
  assert.equal(answer.reason, 'output over 10 bytes');
});

test('a temp folder that cannot be made ends the console run as failed and never throws (#782)', async (t) => {
  const folder = await realpath(await tempDir(t, 'check-run-'));
  const bin = await tempDir(t, 'check-bin-');
  await tool(join(bin, 'detekt'), 'exit 0');
  const before = process.env.TMPDIR;
  process.env.TMPDIR = join(folder, 'missing');
  t.after(() => { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; });
  const store = createConsoleStore(() => 5000);
  const answer = await runCheck(cliCheckerDef('detekt'), context(folder, store, { file: join(folder, 'A.kt'), env: { PATH: `${bin}:${SYSTEM_PATH}` } }));
  assert.ok(answer.state === 'failed');
  assert.equal(store.channels()[0].status, 'failed');
});

test('at most four runs spawn at once; the rest wait, and a waiting run that is superseded never takes a slot (#782)', async () => {
  const runs = createCheckRuns();
  const signals = Array.from({ length: 6 }, (_, i) => runs.start(`k${i}`));
  const releases = await Promise.all(signals.slice(0, 4).map((s) => runs.slot(s)));
  assert.ok(releases.every((r) => r !== undefined));
  let fifth: unknown = 'pending';
  void runs.slot(signals[4]).then((r) => { fifth = r; });
  const sixth = runs.slot(signals[5]);
  await new Promise((r) => setImmediate(r));
  assert.equal(fifth, 'pending');
  runs.start('k5'); // supersedes the sixth while it waits
  assert.equal(await sixth, undefined);
  releases[0]?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof fifth, 'function');
});
