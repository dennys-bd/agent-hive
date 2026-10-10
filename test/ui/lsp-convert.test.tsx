import { expect, test } from 'vitest';
import { locationsOf, markerToDiagnostic, quickFixEdits, toCompletionContext, toMarker, toMarkdown, toProblems, toSuggestion, type MonacoEnums } from '@/lib/lsp-convert';

const ENUMS: MonacoEnums = { kinds: { Text: 18, Method: 0, Function: 1, Variable: 4 }, snippet: 4, severity: { Error: 8, Warning: 4, Info: 2, Hint: 1 } };
const R = { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } };
const WORD = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };
const URI = 'file:///w/a.ts';

test('a completion item keeps its kind, its textEdit\'s range (insert and replace too), a snippet\'s rule and markdown docs (#780)', () => {
  expect(toSuggestion({ label: 'log', kind: 2, textEdit: { range: R, newText: 'log()' }, insertTextFormat: 2, documentation: { kind: 'markdown', value: '**x**' } }, WORD, ENUMS)).toEqual({
    label: 'log', kind: 0, insertText: 'log()', range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6 }, insertTextRules: 4, documentation: { value: '**x**' },
  });
  expect(toSuggestion({ label: 'x', textEdit: { insert: R, replace: R, newText: 'x' } }, WORD, ENUMS).range).toEqual({ insert: expect.any(Object), replace: expect.any(Object) });
  expect(toSuggestion({ label: 'y', kind: 99 as 1 }, WORD, ENUMS)).toMatchObject({ kind: 18, insertText: 'y', range: WORD });
});

test('hover contents become markdown, a language block fenced; definitions read Location and LocationLink (#780)', () => {
  expect(toMarkdown([{ language: 'ts', value: 'let a' }, 'doc'])).toEqual([{ value: '```ts\nlet a\n```' }, { value: 'doc' }]);
  expect(toMarkdown({ kind: 'markdown', value: 'x' })).toEqual([{ value: 'x' }]);
  expect(locationsOf([{ targetUri: URI, targetRange: R, targetSelectionRange: R }])).toEqual([{ uri: URI, range: R }]);
  expect(locationsOf({ uri: URI, range: R })).toEqual([{ uri: URI, range: R }]);
  expect(locationsOf(null)).toEqual([]);
});

test('diagnostics become markers with Monaco\'s severities and back (#780)', () => {
  const diagnostic = { range: R, message: 'x is unused', severity: 2 as const, source: 'ts', code: 6133 };
  const marker = toMarker(diagnostic, ENUMS);
  expect(marker).toEqual({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6, message: 'x is unused', severity: 4, source: 'ts', code: '6133' });
  expect(markerToDiagnostic(marker, ENUMS)).toEqual({ ...diagnostic, code: '6133' });
});

test('a quick fix is offered only with an edit touching this file alone: a bare command, another file or another kind is not (#780)', () => {
  const edit = { range: R, newText: 'y' };
  expect(quickFixEdits({ title: 'fix', kind: 'quickfix', edit: { changes: { [URI]: [edit] } } }, URI)).toEqual([edit]);
  expect(quickFixEdits({ title: 'fix', edit: { documentChanges: [{ textDocument: { uri: URI, version: 1 }, edits: [edit] }] } }, URI)).toEqual([edit]);
  expect(quickFixEdits({ title: 'run', command: 'x.fix' }, URI)).toBeUndefined();
  expect(quickFixEdits({ title: 'fix', kind: 'quickfix', command: { title: 'c', command: 'x' } }, URI)).toBeUndefined();
  expect(quickFixEdits({ title: 'fix', kind: 'quickfix', edit: { changes: { [URI]: [edit], 'file:///w/b.ts': [edit] } } }, URI)).toBeUndefined();
  expect(quickFixEdits({ title: 'org', kind: 'source.organizeImports', edit: { changes: { [URI]: [edit] } } }, URI)).toBeUndefined();
});

test('a quick fix keeps its edits when the server escapes ( ) \' ! * where the page did not: URIs compare as paths (#780)', () => {
  const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' };
  const page = "file:///w/a(1)'!*.ts";
  const server = 'file:///w/a%281%29%27%21%2A.ts';
  expect(quickFixEdits({ title: 'fix', kind: 'quickfix', edit: { changes: { [server]: [edit] } } }, page)).toEqual([edit]);
  expect(quickFixEdits({ title: 'fix', edit: { documentChanges: [{ textDocument: { uri: server, version: 1 }, edits: [edit] }] } }, page)).toEqual([edit]);
  expect(quickFixEdits({ title: 'fix', kind: 'quickfix', edit: { changes: { 'untitled:1': [edit] } } }, 'untitled:2')).toBeUndefined();
});

test('the completion context is LSP\'s: trigger kinds count from 1, the character only when given (#780)', () => {
  expect(toCompletionContext({ triggerKind: 0 })).toEqual({ triggerKind: 1 });
  expect(toCompletionContext({ triggerKind: 1, triggerCharacter: '.' })).toEqual({ triggerKind: 2, triggerCharacter: '.' });
});

test('toProblems keeps errors, warnings and infos 1-based with their code as text and the source given; a hint is no problem (#782)', () => {
  const at = { line: R.start.line + 1, column: R.start.character + 1, endLine: R.end.line + 1, endColumn: R.end.character + 1 };
  expect(toProblems('a.ts', [{ range: R, message: 'a', severity: 1, code: 2304 }, { range: R, message: 'b', severity: 2 }, { range: R, message: 'c', severity: 4 }, { range: R, message: 'd' }], 'typescript-language-server')).toEqual([
    { path: 'a.ts', ...at, severity: 'error', message: 'a', code: '2304', source: 'typescript-language-server', fromServer: true },
    { path: 'a.ts', ...at, severity: 'warning', message: 'b', source: 'typescript-language-server', fromServer: true },
    { path: 'a.ts', ...at, severity: 'error', message: 'd', source: 'typescript-language-server', fromServer: true },
  ]);
});
