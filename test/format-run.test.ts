import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConsoleStore, failLine } from '../src/console.js';
import { type FormatContext, formatForSave, runFormatter } from '../src/format-run.js';
import type { FormatterPick } from '../src/formatters.js';
import { EDITOR_FILE_MAX, EDITOR_DEFAULTS } from '../src/types.js';
import { tempDir } from './temp-dir.js';

type Store = ReturnType<typeof createConsoleStore>;

// A formatter for the test: a shell script in a temp folder, so no test depends on a tool installed on the machine
async function fakeTool(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}
const ruff = (binary: string): FormatterPick => ({ kind: 'supported', name: 'ruff', binary, argv: (file) => ['format', '--stdin-filename', file, '-'] });

function setup(dir: string, timeoutMs?: number): { store: Store; ctx: FormatContext } {
  const store = createConsoleStore(() => 5000);
  const ctx: FormatContext = {
    cwd: dir, file: join(dir, 'a.py'), workspace: { name: 'ui', env: { GREETING: 'hi' } }, label: '#HIVE-1 · a.py', consoleStore: store,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  return { store, ctx };
}
const history = (store: Store, channel: string): string => store.history(channel)?.history ?? '';

test('a supported formatter\'s stdout replaces the text; it runs in the activity\'s folder with its argv, its stderr in its console run (#749)', async (t) => {
  const dir = await tempDir(t, 'fmt-run-');
  const tool = await fakeTool(dir, 'ruff', 'echo "$(pwd -P) $*" >&2; tr a-z A-Z');
  const { store, ctx } = setup(dir);
  assert.deepEqual(await runFormatter(ruff(tool), 'x = 1\n', ctx), { text: 'X = 1\n' });
  const log = history(store, 'format:ui:ruff');
  assert.match(log, /^── #HIVE-1 · a\.py · \d\d:\d\d:\d\d ──\r\n/);
  assert.ok(log.includes(`${await realpath(dir)} format --stdin-filename ${ctx.file} -\r\n`), log);
  assert.deepEqual(store.channels().map((c) => [c.id, c.kind, c.status]), [['format:ui:ruff', 'format', 'done']]);
});

test('a non-zero exit, an empty stdout, a stdout not UTF-8 or over the cap, and the timeout are failures: the reason ends the run in red, the channel reads failed (#749)', async (t) => {
  const dir = await tempDir(t, 'fmt-run-');
  const cases: [string, string, number?][] = [
    ['cat > /dev/null; echo "bad config" >&2; exit 3', 'exit code 3'],
    ['cat > /dev/null', 'empty output'],
    ["cat > /dev/null; printf '\\377'", 'output is not UTF-8'],
    [`cat > /dev/null; head -c ${EDITOR_FILE_MAX + 1} /dev/zero | tr '\\0' a`, `output over ${EDITOR_FILE_MAX} bytes`],
    ['exec sleep 5', 'timed out after 500 ms', 500], // exec: the killed process is the one holding the pipe
  ];
  for (const [i, [body, reason, timeoutMs]] of cases.entries()) {
    const tool = await fakeTool(dir, `tool${i}`, body);
    const { store, ctx } = setup(dir, timeoutMs);
    const outcome = await runFormatter(ruff(tool), 'x = 1\n', ctx);
    assert.ok('error' in outcome, body);
    assert.equal(outcome.error, reason, body);
    assert.equal(outcome.log.channel, 'format:ui:ruff');
    assert.ok(history(store, 'format:ui:ruff').includes(failLine(reason)), body);
    assert.equal(store.channels()[0].status, 'failed', body);
  }
});

test('a custom formatter runs its line through the shell with FILE and the workspace\'s env (#749)', async (t) => {
  const dir = await tempDir(t, 'fmt-run-');
  const { store, ctx } = setup(dir);
  const sql: FormatterPick = { kind: 'custom', name: 'sql', command: 'cat > /dev/null; printf "%s %s" "$FILE" "$GREETING"' };
  assert.deepEqual(await runFormatter(sql, 'select 1', ctx), { text: `${ctx.file} hi` });
  assert.equal(store.channels()[0].id, 'format:ui:sql');
});

test('a binary gone since its detection is a failure, never a throw (#749)', async (t) => {
  const dir = await tempDir(t, 'fmt-run-');
  const outcome = await runFormatter(ruff(join(dir, 'gone')), 'x\n', setup(dir).ctx);
  assert.ok('error' in outcome);
});

test('formatForSave runs what the folder has installed for the file\'s extension; nothing for an extension no formatter takes (#749)', async (t) => {
  const dir = await tempDir(t, 'fmt-run-');
  await mkdir(join(dir, '.venv', 'bin'), { recursive: true });
  await fakeTool(join(dir, '.venv', 'bin'), 'ruff', 'tr a-z A-Z');
  const { ctx } = setup(dir);
  const format = EDITOR_DEFAULTS;
  assert.deepEqual(await formatForSave(format, 'x = 1\n', ctx), { text: 'X = 1\n' });
  assert.equal(await formatForSave(format, 'x', { ...ctx, file: join(dir, 'notes.xyz') }), undefined);
});

test('a custom formatter killed by a signal fails with the signal, never its command line; a tool that exits without reading a large stdin reports its own exit code and stderr (#749)', async (t) => {
  const dir = await tempDir(t, 'fmt-run-');
  const { store, ctx } = setup(dir);
  const secret = 'SECRET-IN-LINE';
  const killed = await runFormatter({ kind: 'custom', name: 'up', command: `kill -9 $$ # ${secret}` }, 'x\n', ctx);
  assert.ok('error' in killed);
  assert.equal(killed.error, 'killed by SIGKILL');
  assert.ok(!history(store, 'format:ui:up').includes(secret));
  const tool = await fakeTool(dir, 'early', 'echo "syntax error" >&2; exit 2');
  const early = await runFormatter(ruff(tool), 'x'.repeat(EDITOR_FILE_MAX - 1), ctx);
  assert.ok('error' in early);
  assert.equal(early.error, 'exit code 2');
  assert.ok(history(store, 'format:ui:ruff').includes('syntax error'));
});

test('biome refusing with its formatter disabled is no error: the save goes on as typed and its console run ends done; any other exit 1 of biome stays a failure (#749)', async (t) => {
  const dir = await tempDir(t, 'fmt-run-');
  const bin = join(dir, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  const disabled = 'The content was not formatted because the formatter is currently disabled.';
  await fakeTool(bin, 'biome', `cat; echo "${disabled}" >&2; exit 1`);
  const { store, ctx } = setup(dir);
  const ts = { ...ctx, file: join(dir, 'vite.config.ts') };
  const format = EDITOR_DEFAULTS;
  assert.equal(await formatForSave(format, 'const a = 1\n', ts), undefined);
  const channel = store.channels().find((c) => c.id === 'format:ui:biome');
  assert.equal(channel?.status, 'done');
  assert.ok(history(store, 'format:ui:biome').includes(disabled));
  await fakeTool(bin, 'biome', 'cat; echo "parse error" >&2; exit 1');
  const failed = await formatForSave(format, 'const a = 1\n', ts);
  assert.ok(failed !== undefined && 'error' in failed);
  assert.equal(failed.error, 'exit code 1');
});
