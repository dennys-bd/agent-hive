import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIFF_LINE_MAX, DIFF_MAX, formatOutput, OUTPUT_LINES, TAIL_BYTES, tailTranscript } from '../src/transcript.js';

const assistant = (...content: unknown[]): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });
const text = (t: string): string => assistant({ type: 'text', text: t });

async function transcript(lines: string[]): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-transcript-')), 'session.jsonl');
  await writeFile(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

test('formatOutput shows assistant text blocks and tool calls with their main argument', () => {
  const line = assistant(
    { type: 'text', text: 'vou olhar o arquivo' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'roda os testes' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
    { type: 'tool_use', name: 'Task', input: { description: 'explora o repo' } },
    { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
  );
  assert.deepEqual(formatOutput(line), [
    'vou olhar o arquivo', '▶ Read: /repo/src/a.ts', '▶ Bash: pnpm test', '▶ Grep: TODO', '▶ Task: explora o repo', '▶ TodoWrite',
  ]);
});

test('formatOutput truncates text to 2000 chars and tool arguments to 120', () => {
  const [t, tool] = formatOutput(
    assistant({ type: 'text', text: 'x'.repeat(2500) }, { type: 'tool_use', name: 'Bash', input: { command: 'y'.repeat(300) } }),
  );
  assert.equal(t.length, 2000);
  assert.equal(tool, `▶ Bash: ${'y'.repeat(120)}`);
});

test('formatOutput hides result / system / user / stream_event lines and anything that is not a JSON object', () => {
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'result', subtype: 'success' })), [], 'a transcript has no result lines');
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'system', subtype: 'init' })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'stream_event' })), []);
  assert.deepEqual(formatOutput('stderr: warning: something'), []);
  assert.deepEqual(formatOutput('42'), []);
  assert.deepEqual(formatOutput(''), []);
});

test('formatOutput renders an Edit as one diff block entry with the file path, cutting each side at DIFF_MAX lines', () => {
  const edit = (input: Record<string, unknown>): string[] => formatOutput(assistant({ type: 'tool_use', name: 'Edit', input }));
  assert.deepEqual(edit({ file_path: '/repo/a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;' }), [
    '▶ Edit: /repo/a.ts', '```diff\n-const a = 1;\n-const b = 2;\n+const a = 10;\n```',
  ], 'the whole block is one entry, so a cut at `max` lines never leaves a stray closing fence');
  const many = Array.from({ length: DIFF_MAX + 5 }, (_, i) => `line ${i}`).join('\n');
  const long = edit({ file_path: '/repo/b.ts', old_string: many, new_string: 'x' })[1].split('\n');
  assert.equal(long.length, 1 + DIFF_MAX + 1 + 1 + 1, 'fence, DIFF_MAX old lines, cut mark, one new line, fence');
  assert.equal(long[DIFF_MAX], `-line ${DIFF_MAX - 1}`);
  assert.equal(long[DIFF_MAX + 1], '…');
  assert.equal(long[DIFF_MAX + 2], '+x');
  assert.equal(long.at(-1), '```');
  assert.deepEqual(edit({ file_path: '/repo/c.ts', old_string: '', new_string: 'novo' }), ['▶ Edit: /repo/c.ts', '```diff\n+novo\n```'], 'an empty side adds no lines');
  assert.equal(edit({ file_path: 'w.ts', old_string: 'a\r\nb\rc', new_string: '' })[1], '```diff\n-a\n-b\n-c\n```', 'CRLF and CR normalised: no \\r reaches the panel');
  const blob = edit({ file_path: 'm.js', old_string: '', new_string: 'x'.repeat(DIFF_LINE_MAX + 50) })[1].split('\n')[1];
  assert.equal(blob, `+${'x'.repeat(DIFF_LINE_MAX)}`, 'a line is cut at DIFF_LINE_MAX');
  assert.deepEqual(
    formatOutput(assistant({ type: 'tool_use', name: 'Write', input: { file_path: '/repo/d.ts', content: 'x'.repeat(5000) } })),
    ['▶ Write: /repo/d.ts'], 'Write stays a one-liner',
  );
});

test('tailTranscript returns the last `max` formatted lines of the file, skipping what formatOutput hides', async () => {
  const path = await transcript([
    JSON.stringify({ type: 'user', message: { content: 'faz a task' } }),
    ...Array.from({ length: 5 }, (_, i) => text(`passo ${i}`)),
    'not json',
    assistant({ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }),
  ]);
  assert.deepEqual(await tailTranscript(path), ['passo 0', 'passo 1', 'passo 2', 'passo 3', 'passo 4', '▶ Bash: pnpm test']);
  assert.deepEqual(await tailTranscript(path, 2), ['passo 4', '▶ Bash: pnpm test']);
  assert.equal(OUTPUT_LINES, 200);
});

test('tailTranscript reads only the last TAIL_BYTES and drops the first line of a read that did not start at byte 0, whole or not', async () => {
  // The tail is built so the cut falls exactly on a line start: `first` is whole in the read and is still dropped, which
  // proves the rule is positional (a truly partial line would fail to parse anyway).
  const first = text('primeira');
  const last = text('última');
  const padLine = (n: number): string => JSON.stringify({ type: 'system', pad: 'p'.repeat(n) });
  const overhead = Buffer.byteLength(`${first}\n${last}\n${padLine(0)}\n`);
  const tail = [first, padLine(TAIL_BYTES - overhead), last]; // exactly TAIL_BYTES on disk
  const beyond = await transcript([text('antes'), ...tail]);
  assert.deepEqual(await tailTranscript(beyond), ['última']);
  const within = await transcript(tail);
  assert.deepEqual(await tailTranscript(within), ['primeira', 'última'], 'a read from byte 0 keeps its first line');
});

test('tailTranscript rejects a missing path and a path that is not a regular file', async () => {
  await assert.rejects(tailTranscript('/definitely/missing/session.jsonl'), { code: 'ENOENT' });
  await assert.rejects(tailTranscript(tmpdir()), /não é um arquivo regular/);
});
