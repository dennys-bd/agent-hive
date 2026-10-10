import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonLines, jsonOf, severityOf, TOOL_PARSERS } from '../src/checker-parse-tools.js';
import type { CheckDiagnostic } from '../src/types.js';

type Tool = keyof typeof TOOL_PARSERS;
const lines = (...objects: object[]): string => `${objects.map((o) => JSON.stringify(o)).join('\n')}\n`;

const CASES: [Tool, string, CheckDiagnostic[]][] = [
  ['selene', lines(
    { type: 'Diagnostic', severity: 'Warning', code: 'unused_variable', message: 'x is defined, but never used', primary_label: { span: { start: 6, start_line: 0, start_column: 6, end: 7, end_line: 0, end_column: 7 }, message: '' }, notes: [], secondary_labels: [] },
    { type: 'Summary', errors: 0, warnings: 1, parse_errors: 0 },
  ), [{ path: '/w/src/a.lua', line: 1, column: 7, endLine: 1, endColumn: 8, severity: 'warning', message: 'x is defined, but never used', code: 'unused_variable' }]],
  ['stylelint', JSON.stringify([{ source: '/w/src/a.css', deprecations: [], invalidOptionWarnings: [], parseErrors: [], errored: true, warnings: [
    { line: 3, column: 10, endLine: 3, endColumn: 17, rule: 'color-no-invalid-hex', severity: 'error', text: 'Unexpected invalid hex color "#fff1az" (color-no-invalid-hex)' },
  ] }]), [{ path: '/w/src/a.css', line: 3, column: 10, endLine: 3, endColumn: 17, severity: 'error', message: 'Unexpected invalid hex color "#fff1az" (color-no-invalid-hex)', code: 'color-no-invalid-hex' }]],
  ['htmlhint', JSON.stringify([{ file: 'src/index.html', messages: [
    { type: 'error', message: 'Doctype must be declared before any non-comment content.', raw: '<html>', evidence: '<html>', line: 1, col: 1, rule: { id: 'doctype-first', description: 'Doctype must be declared first.', link: 'https://htmlhint.com/docs/user-guide/rules/doctype-first' } },
  ], time: 3 }]), [{ path: 'src/index.html', line: 1, column: 1, severity: 'error', message: 'Doctype must be declared before any non-comment content.', code: 'doctype-first' }]],
  ['markdownlint', JSON.stringify([
    { fileName: 'README.md', lineNumber: 3, ruleNames: ['MD022', 'blanks-around-headings'], ruleDescription: 'Headings should be surrounded by blank lines', ruleInformation: 'https://github.com/DavidAnson/markdownlint/blob/main/doc/md022.md', errorDetail: 'Expected: 1; Actual: 0; Below', errorContext: '# Title', errorRange: null },
  ]), [{ path: 'README.md', line: 3, column: 1, severity: 'warning', message: 'Headings should be surrounded by blank lines [Expected: 1; Actual: 0; Below]', code: 'MD022' }]],
  ['sqlfluff', JSON.stringify([{ filepath: 'q.sql', violations: [
    { start_line_no: 1, start_line_pos: 9, code: 'LT01', description: "Expected only single space before '*'.", name: 'layout.spacing', warning: false, end_line_no: 1, end_line_pos: 11 },
  ] }]), [{ path: 'q.sql', line: 1, column: 9, endLine: 1, endColumn: 11, severity: 'error', message: "Expected only single space before '*'.", code: 'LT01' }]],
  ['swiftlint', JSON.stringify([
    { character: 7, file: '/w/Sources/A.swift', line: 4, reason: "Variable name 'x' should be between 3 and 40 characters long", rule_id: 'identifier_name', severity: 'Warning', type: 'Identifier Name' },
  ]), [{ path: '/w/Sources/A.swift', line: 4, column: 7, severity: 'warning', message: "Variable name 'x' should be between 3 and 40 characters long", code: 'identifier_name' }]],
  ['dart', `Analyzing app...\n${JSON.stringify({ version: 1, diagnostics: [
    { code: 'unused_import', severity: 'WARNING', type: 'STATIC_WARNING', location: { file: '/w/lib/a.dart', range: { start: { offset: 7, line: 1, column: 8 }, end: { offset: 20, line: 1, column: 21 } } }, problemMessage: "Unused import: 'dart:io'.", documentation: 'https://dart.dev/diagnostics/unused_import' },
  ] })}`, [{ path: '/w/lib/a.dart', line: 1, column: 8, endLine: 1, endColumn: 21, severity: 'warning', message: "Unused import: 'dart:io'.", code: 'unused_import' }]],
  ['credo', `Compiling 3 files (.ex)\n${JSON.stringify({ issues: [
    { category: 'readability', check: 'Credo.Check.Readability.ModuleDoc', column: 11, column_end: 21, filename: 'lib/a.ex', line_no: 1, message: 'Modules should have a @moduledoc tag.', priority: 1, scope: 'A', trigger: 'A' },
    { category: 'warning', check: 'Credo.Check.Warning.IoInspect', column: 5, column_end: null, filename: 'lib/a.ex', line_no: 4, message: 'There should be no calls to `IO.inspect/1`.', priority: 12, scope: 'A.f', trigger: 'IO.inspect' },
  ] })}`, [
    { path: 'lib/a.ex', line: 1, column: 11, endColumn: 21, severity: 'info', message: 'Modules should have a @moduledoc tag.', code: 'Credo.Check.Readability.ModuleDoc' },
    { path: 'lib/a.ex', line: 4, column: 5, severity: 'warning', message: 'There should be no calls to `IO.inspect/1`.', code: 'Credo.Check.Warning.IoInspect' },
  ]],
  ['ktlint', JSON.stringify([{ file: '/w/src/A.kt', errors: [{ line: 1, column: 1, message: "File name 'A.kt' should conform PascalCase", rule: 'standard:filename' }] }]),
    [{ path: '/w/src/A.kt', line: 1, column: 1, severity: 'warning', message: "File name 'A.kt' should conform PascalCase", code: 'standard:filename' }]],
];

test('each tool\'s report reads as diagnostics: 1-based, its severity mapped, its code kept, a report\'s leading lines skipped (#782)', () => {
  for (const [tool, output, expected] of CASES) assert.deepEqual(TOOL_PARSERS[tool](output, { file: '/w/src/a.lua' }), expected, tool);
});

test('an empty list reads as none; a report that does not parse, or a wrong shape, throws (#782)', () => {
  assert.deepEqual(TOOL_PARSERS.stylelint('[]', {}), []);
  assert.deepEqual(TOOL_PARSERS.selene('', {}), []);
  assert.throws(() => TOOL_PARSERS.stylelint('Error: No files matching the pattern', {}));
  assert.throws(() => TOOL_PARSERS.dart('{"version":1}', {}), /diagnostics is not an array/);
  assert.throws(() => jsonOf('no json here'), /no JSON/);
  assert.deepEqual(jsonLines('Success: no issues found\n{"a":1}\n'), [{ a: 1 }]);
  assert.deepEqual([severityOf('Error'), severityOf('fatal'), severityOf('WARN'), severityOf('convention'), severityOf(undefined), severityOf('', 'warning')], ['error', 'error', 'warning', 'info', 'error', 'warning']);
});
