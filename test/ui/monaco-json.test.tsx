import { beforeAll, expect, test } from 'vitest';
import type * as MonacoApi from 'monaco-editor/esm/vs/editor/editor.api';
import { registerJson } from '@/lib/monaco-json';

let monaco: typeof MonacoApi;

beforeAll(async () => {
  // Real Monaco, not the mock the editor tests use: the tokenizer is only proven by Monaco running it
  monaco = await import('monaco-editor/esm/vs/editor/editor.api');
  registerJson(monaco.languages);
});

// The token type covering the character `index` chars into the first occurrence of `needle`. Monarch may split one string into
// several tokens (quote, body, escape), so a test reads the type at one character, never a whole token
function typeAt(text: string, needle: string, index = 1): string {
  const lines = text.split('\n');
  const row = lines.findIndex((l) => l.includes(needle));
  if (row < 0) throw new Error(`${needle} not in the sample`);
  const column = (lines[row] ?? '').indexOf(needle) + index;
  const tokens = monaco.editor.tokenize(text, 'json')[row] ?? [];
  return tokens.filter((t) => t.offset <= column).at(-1)?.type ?? '';
}

test('keys, string values, numbers and keywords each get their own token (#793)', () => {
  const sample = '{"name": "hive", "n": -1.5e3, "ok": true, "x": null}';
  expect(typeAt(sample, '"name"')).toBe('string.key.json');
  expect(typeAt(sample, '"x"')).toBe('string.key.json');
  expect(typeAt(sample, '"hive"')).toBe('string.value.json');
  expect(typeAt(sample, '-1.5e3', 3)).toBe('number.json');
  expect(typeAt(sample, 'true', 0)).toBe('keyword.json');
  expect(typeAt(sample, 'null', 0)).toBe('keyword.json');
  expect(typeAt(sample, '{', 0)).toBe('delimiter.bracket.json');
  expect(typeAt(sample, ':', 0)).toBe('delimiter.json');
});

test('an escaped quote does not end the string: the escape is painted inside it and the string closes at the real quote (#793)', () => {
  const value = '{"k": "a\\"b"}';
  expect(typeAt(value, '\\"', 0)).toBe('string.escape.json');
  expect(typeAt(value, 'b"', 0)).toBe('string.value.json');
  expect(typeAt(value, '}', 0)).toBe('delimiter.bracket.json');
  expect(typeAt('{"a\\"b": 1}', 'b"', 0)).toBe('string.key.json');
});

test('a string left open is kept to its line, so the next line is tokenized afresh (#793)', () => {
  const sample = '{"a": "open\n"b": 1}';
  expect(typeAt(sample, 'open', 0)).toBe('string.invalid.json');
  expect(typeAt(sample, '"b"')).toBe('string.key.json');
  const dangling = '{"a": "x\\\n"b": 1}'; // a lone backslash at the line's end must not carry the string into the next line
  expect(typeAt(dangling, '"b"')).toBe('string.key.json');
});

test('line comments and a block comment across two lines are comments, and code after the block is not (#793)', () => {
  const sample = '// line\n{"a": 1 /* block\nstill */ }';
  expect(typeAt(sample, 'line', 0)).toBe('comment.json');
  expect(typeAt(sample, 'block', 0)).toBe('comment.json');
  expect(typeAt(sample, 'still', 0)).toBe('comment.json');
  expect(typeAt(sample, '}', 0)).toBe('delimiter.bracket.json');
});

test('a string inside an array is a value, not a key (#793)', () => {
  expect(typeAt('["a", "b"]', '"b"')).toBe('string.value.json');
});

test('Monaco knows .json and .jsonc as json, so the catalog loop leaves them out of web (#793)', () => {
  const json = monaco.languages.getLanguages().find((l) => l.id === 'json');
  expect(json?.extensions).toEqual(expect.arrayContaining(['.json', '.jsonc']));
});
