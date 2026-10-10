import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arrayOf, finding, isRecord, jsonLines, jsonOf, next, num, type ParseAt, type Parser, recordOf, severityOf, str, TOOL_PARSERS } from './checker-parse-tools.js';
import type { CheckFormat } from './checkers.js';
import type { CheckDiagnostic } from './types.js';

// The command-line checkers' reports (#782), the first half of the parsers and parseCheck (checker-parse-tools.ts holds the helpers and the
// second half). A line format skips the lines it does not read (tsc's related info, zig's source excerpt); a run that exits non-zero with no
// finding is check-run.ts's failure. Pure.

// Each line of `output` that `pattern` reads, the others skipped
const matched = (output: string, pattern: RegExp, read: (m: RegExpExecArray) => CheckDiagnostic): CheckDiagnostic[] =>
  output.split('\n').flatMap((line) => { const m = pattern.exec(line.trimEnd()); return m ? [read(m)] : []; });

// tsc --pretty false: `path(line,col): error TS2304: text`; the code stored as its number, as typescript-language-server's
const TSC = /^(.+)\((\d+),(\d+)\): (error|warning|message) TS(\d+): (.*)$/;
const tsc: Parser = (output) => matched(output, TSC, (m) => finding(m[1], Number(m[2]), Number(m[3]), m[4] === 'message' ? 'info' : severityOf(m[4]), m[6], { code: m[5] }));

// luacheck's plain (`a.lua:1:7-9: (W211) text`), yamllint's parsable (`a.yaml:1:1: [warning] text (rule)`), zig's (`a.zig:3:5: error: text`);
// no severity is an error, a luacheck W code a warning
const GNU = /^(.+?):(\d+):(\d+)(?:-(\d+))?: (?:\[(\w+)\] |(error|warning|note): )?(?:\(([A-Z]\d+)\) )?(.*)$/;
const gnu: Parser = (output) => matched(output, GNU, (m) => {
  const code = m[7];
  const word = m[5] ?? m[6] ?? (code?.startsWith('W') ? 'warning' : undefined);
  const range = m[4] === undefined ? {} : { endLine: Number(m[2]), endColumn: Number(m[4]) + 1 };
  return finding(m[1], Number(m[2]), Number(m[3]), severityOf(word), m[8], { code, ...range });
});

// mypy -O json: one object per line, its column 0-based (-1 for none); its last line of words is skipped
const mypy: Parser = (output) => jsonLines(output).map((d) => finding(str(d.file) ?? '', num(d.line) ?? 1, next(d.column), severityOf(d.severity), str(d.message) ?? '', { code: d.code }));

const pylint: Parser = (output) => arrayOf(recordOf(jsonOf(output), 'the report').messages, 'messages').map((m) => {
  const x = recordOf(m, 'a message');
  return finding(str(x.absolutePath) ?? str(x.path) ?? '', num(x.line) ?? 1, next(x.column), severityOf(x.type), str(x.message) ?? '', { code: x.symbol, endLine: x.endLine, endColumn: next(x.endColumn) });
});

// golangci-lint v2: Issues is null when there are none; an issue with no severity is a warning, as its linters report style and bugs alike
const golangci: Parser = (output) => arrayOf(recordOf(jsonOf(output), 'the report').Issues ?? [], 'Issues').map((i) => {
  const x = recordOf(i, 'an issue');
  const pos = recordOf(x.Pos, 'Pos');
  return finding(str(pos.Filename) ?? '', num(pos.Line) ?? 1, num(pos.Column), severityOf(x.Severity, 'warning'), str(x.Text) ?? '', { code: x.FromLinter });
});

const staticcheck: Parser = (output) => jsonLines(output).map((d) => {
  const location = recordOf(d.location, 'location');
  const end = isRecord(d.end) ? d.end : {};
  return finding(str(location.file) ?? '', num(location.line) ?? 1, num(location.column), severityOf(d.severity, 'warning'), str(d.message) ?? '', { code: d.code, endLine: end.line, endColumn: end.column });
});

// cargo's compiler messages at their primary span; one with no span (the "generated 1 warning" summary) is no finding. Its JSON names no
// workspace root, so a relative file_name resolves against the run's folder: a clippy run from a nested crate of a workspace maps to the wrong path
const cargo: Parser = (output) => jsonLines(output).filter((d) => d.reason === 'compiler-message').flatMap((d) => {
  const message = recordOf(d.message, 'message');
  const span = (Array.isArray(message.spans) ? message.spans : []).find((s) => isRecord(s) && s.is_primary === true);
  if (!isRecord(span)) return [];
  return [finding(str(span.file_name) ?? '', num(span.line_start) ?? 1, num(span.column_start), severityOf(message.level, 'info'), str(message.message) ?? '',
    { code: isRecord(message.code) ? message.code.code : undefined, endLine: span.line_end, endColumn: span.column_end })];
});

// SARIF 2.1.0 (detekt): the first location's physical place; a file:// URI as its path
function sarifResult(raw: unknown): CheckDiagnostic[] {
  const x = recordOf(raw, 'a result');
  const place = Array.isArray(x.locations) && isRecord(x.locations[0]) ? x.locations[0].physicalLocation : undefined;
  const uri = isRecord(place) && isRecord(place.artifactLocation) ? str(place.artifactLocation.uri) : undefined;
  if (!isRecord(place) || uri === undefined) return [];
  const region = isRecord(place.region) ? place.region : {};
  const path = uri.startsWith('file:') ? fileURLToPath(uri) : decodeURIComponent(uri);
  return [finding(path, num(region.startLine) ?? 1, num(region.startColumn), severityOf(x.level, 'warning'), isRecord(x.message) ? str(x.message.text) ?? '' : '',
    { code: x.ruleId, endLine: region.endLine, endColumn: region.endColumn })];
}
const sarif: Parser = (output) => arrayOf(recordOf(jsonOf(output), 'the report').runs, 'runs').flatMap((run) => arrayOf(recordOf(run, 'a run').results ?? [], 'results').flatMap(sarifResult));

const PARSERS: Record<CheckFormat, Parser> = { tsc, gnu, mypy, pylint, golangci, staticcheck, cargo, sarif, ...TOOL_PARSERS };

// A reported path as the activity names it: relative to the folder; undefined outside it, which the pane could not open
function inside(folder: string, path: string): string | undefined {
  const rel = relative(folder, resolve(folder, path));
  return rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel) ? undefined : rel;
}

/** A command-line checker's report as diagnostics (#782), each path relative to `folder` (a finding outside it dropped), or why the report
 * does not read. `at.file` is the checked file, for a tool whose report names none. */
export function parseCheck(format: CheckFormat, output: string, folder: string, at: ParseAt = {}): CheckDiagnostic[] | { error: string } {
  try {
    return PARSERS[format](output, at).flatMap((d) => { const path = inside(folder, d.path); return path === undefined ? [] : [{ ...d, path }]; });
  } catch (err) {
    return { error: `${format} output does not read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
