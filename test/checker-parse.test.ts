import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheck } from '../src/checker-parse.js';
import type { CheckFormat } from '../src/checkers.js';
import type { CheckDiagnostic } from '../src/types.js';

const F = '/w';
const lines = (...objects: object[]): string => `${objects.map((o) => JSON.stringify(o)).join('\n')}\n`;

const CASES: [CheckFormat, string, CheckDiagnostic[]][] = [
  ['tsc', "src/a.ts(12,5): error TS2304: Cannot find name 'x'.\nsrc/b.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n  The expected type comes from property 'n'.\n", [
    { path: 'src/a.ts', line: 12, column: 5, severity: 'error', message: "Cannot find name 'x'.", code: '2304' },
    { path: 'src/b.ts', line: 1, column: 1, severity: 'error', message: "Type 'string' is not assignable to type 'number'.", code: '2322' },
  ]],
  ['mypy', `${lines(
    { file: '/w/src/a.py', line: 3, column: 4, message: 'Argument 1 to "f" has incompatible type "str"; expected "int"', hint: null, code: 'arg-type', severity: 'error' },
    { file: '/w/src/a.py', line: 9, column: -1, message: 'See https://mypy.rtfd.io', hint: null, code: null, severity: 'note' },
  )}Found 1 error in 1 file (checked 1 source file)\n`, [
    { path: 'src/a.py', line: 3, column: 5, severity: 'error', message: 'Argument 1 to "f" has incompatible type "str"; expected "int"', code: 'arg-type' },
    { path: 'src/a.py', line: 9, column: 1, severity: 'info', message: 'See https://mypy.rtfd.io' },
  ]],
  ['pylint', JSON.stringify({ messages: [
    { type: 'convention', symbol: 'missing-module-docstring', message: 'Missing module docstring', messageId: 'C0114', confidence: 'HIGH', module: 'a', obj: '', line: 1, column: 0, endLine: null, endColumn: null, path: 'a.py', absolutePath: '/w/a.py' },
  ], statistics: { messageTypeCount: { convention: 1 }, modulesLinted: 1, score: 0 } }), [
    { path: 'a.py', line: 1, column: 1, severity: 'info', message: 'Missing module docstring', code: 'missing-module-docstring' },
  ]],
  ['golangci', JSON.stringify({ Issues: [
    { FromLinter: 'errcheck', Text: 'Error return value of `f.Close` is not checked', Severity: '', SourceLines: ['\tf.Close()'], Pos: { Filename: 'main.go', Offset: 120, Line: 10, Column: 9 } },
  ], Report: { Linters: [] } }), [
    { path: 'main.go', line: 10, column: 9, severity: 'warning', message: 'Error return value of `f.Close` is not checked', code: 'errcheck' },
  ]],
  ['staticcheck', lines({ code: 'SA4006', severity: 'error', location: { file: '/w/main.go', line: 5, column: 2 }, end: { file: '/w/main.go', line: 5, column: 3 }, message: 'this value of x is never used' }), [
    { path: 'main.go', line: 5, column: 2, endLine: 5, endColumn: 3, severity: 'error', message: 'this value of x is never used', code: 'SA4006' },
  ]],
  ['cargo', lines(
    { reason: 'compiler-artifact', package_id: 'app 0.1.0', target: { name: 'app' }, filenames: [] },
    { reason: 'compiler-message', package_id: 'app 0.1.0', manifest_path: '/w/Cargo.toml', target: { name: 'app' }, message: {
      rendered: 'warning: unneeded `return` statement', $message_type: 'diagnostic', children: [], code: { code: 'clippy::needless_return', explanation: null }, level: 'warning', message: 'unneeded `return` statement',
      spans: [{ file_name: 'src/main.rs', byte_start: 30, byte_end: 39, is_primary: true, line_start: 3, line_end: 3, column_start: 5, column_end: 14, label: null, text: [] }],
    } },
    { reason: 'compiler-message', package_id: 'app 0.1.0', message: { rendered: 'warning: 1 warning emitted', children: [], code: null, level: 'warning', message: '`app` (bin "app") generated 1 warning', spans: [] } },
    { reason: 'build-finished', success: true },
  ), [{ path: 'src/main.rs', line: 3, column: 5, endLine: 3, endColumn: 14, severity: 'warning', message: 'unneeded `return` statement', code: 'clippy::needless_return' }]],
  ['gnu', [
    "src/a.lua:1:7-7: (W211) unused variable 'x'",
    'cfg.yaml:1:1: [warning] missing document start "---" (document-start)',
    "src/main.zig:3:5: error: expected ';' after statement",
    '    const x = 1',
    '    ^',
    '',
  ].join('\n'), [
    { path: 'src/a.lua', line: 1, column: 7, endLine: 1, endColumn: 8, severity: 'warning', message: "unused variable 'x'", code: 'W211' },
    { path: 'cfg.yaml', line: 1, column: 1, severity: 'warning', message: 'missing document start "---" (document-start)' },
    { path: 'src/main.zig', line: 3, column: 5, severity: 'error', message: "expected ';' after statement" },
  ]],
  ['sarif', JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'detekt' } }, results: [
    { ruleId: 'detekt.style.MagicNumber', level: 'warning', message: { text: 'This expression contains a magic number.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///w/src/A.kt' }, region: { startLine: 3, startColumn: 17, endLine: 3, endColumn: 19 } } }] },
  ] }] }), [{ path: 'src/A.kt', line: 3, column: 17, endLine: 3, endColumn: 19, severity: 'warning', message: 'This expression contains a magic number.', code: 'detekt.style.MagicNumber' }]],
  ['markdownlint', JSON.stringify([{ fileName: '/w/README.md', lineNumber: 1, ruleNames: ['MD041'], ruleDescription: 'First line in a file should be a top-level heading', errorDetail: null, errorContext: null, errorRange: null }]), [
    { path: 'README.md', line: 1, column: 1, severity: 'warning', message: 'First line in a file should be a top-level heading', code: 'MD041' },
  ]],
];

test('each format reads as diagnostics with paths relative to the activity\'s folder; tsc\'s code is its number (#782)', () => {
  for (const [format, output, expected] of CASES) assert.deepEqual(parseCheck(format, output, F), expected, format);
});

test('a finding outside the folder is dropped; selene\'s findings take the checked file (#782)', () => {
  const out = lines(
    { file: '/w/src/a.py', line: 1, column: 0, message: 'kept', hint: null, code: 'x', severity: 'error' },
    { file: '/elsewhere/b.py', line: 1, column: 0, message: 'dropped', hint: null, code: 'x', severity: 'error' },
    { file: '../w2/c.py', line: 1, column: 0, message: 'dropped too', hint: null, code: 'x', severity: 'error' },
  );
  assert.deepEqual((parseCheck('mypy', out, F) as CheckDiagnostic[]).map((d) => d.message), ['kept']);
  const selene = lines({ type: 'Diagnostic', severity: 'Error', code: 'parse_error', message: 'unexpected token', primary_label: { span: { start_line: 4, start_column: 0, end_line: 4, end_column: 1 } } });
  assert.deepEqual((parseCheck('selene', selene, F, { file: '/w/init.lua' }) as CheckDiagnostic[]).map((d) => [d.path, d.line]), [['init.lua', 5]]);
});

test('a report that does not read is an error naming its format; lines a line format does not read are skipped (#782)', () => {
  assert.match((parseCheck('pylint', 'Traceback (most recent call last):\n  File "x"', F) as { error: string }).error, /^pylint output does not read: /);
  assert.match((parseCheck('sarif', '{"runs":{}}', F) as { error: string }).error, /^sarif output does not read: runs is not an array$/);
  assert.deepEqual(parseCheck('tsc', "error TS18003: No inputs were found in config file 'tsconfig.json'.\n", F), []);
});
