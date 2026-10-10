import type { CheckDiagnostic } from './types.js';

// The command-line checkers' reports (#782), the helpers and the second half of the parsers (checker-parse.ts holds the first half and
// parseCheck). Each parser is a few lines over JSON.parse; it throws on a report it cannot read, and parseCheck turns the throw into the run's
// failure. Paths stay as the tool wrote them: parseCheck resolves them against the activity's folder. Pure.

/** What a parser knows besides the report (#782): the checked file, absolute, for a tool whose report names no path. */
export interface ParseAt { file?: string }
export type Parser = (output: string, at: ParseAt) => CheckDiagnostic[];
type Severity = CheckDiagnostic['severity'];

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} is not an object`);
  return value;
}
export function arrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}
export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
/** A 0-based number as 1-based; undefined when the tool gave none. */
export const next = (value: unknown): number | undefined => { const n = num(value); return n === undefined ? undefined : n + 1; };

/** A tool's severity word as the Hive's (#782): error and fatal, warning, and every softer one (note, info, convention, refactor, help) as info. */
export function severityOf(word: unknown, fallback: Severity = 'error'): Severity {
  const w = typeof word === 'string' ? word.toLowerCase() : '';
  if (w === '') return fallback;
  if (w === 'error' || w === 'fatal') return 'error';
  return w === 'warning' || w === 'warn' ? 'warning' : 'info';
}

/** One finding (#782), its optional parts left out when the tool gave none; a line or column under 1 reads as 1. */
export function finding(path: string, line: number, column: number | undefined, severity: Severity, message: string, extra: { code?: unknown; endLine?: unknown; endColumn?: unknown } = {}): CheckDiagnostic {
  const code = extra.code === undefined || extra.code === null || extra.code === '' ? undefined : String(extra.code);
  const endLine = num(extra.endLine);
  const endColumn = num(extra.endColumn);
  return {
    path, line: Math.max(1, line), column: Math.max(1, column ?? 1), severity, message,
    ...(code === undefined ? {} : { code }), ...(endLine === undefined ? {} : { endLine }), ...(endColumn === undefined ? {} : { endColumn }),
  };
}

/** The JSON a report holds, from its first { or [: mix prints its compile lines first, dart its "Analyzing" line. */
export function jsonOf(output: string): unknown {
  const start = output.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in the report');
  return JSON.parse(output.slice(start));
}

/** Each line that is a JSON object (#782), the others skipped: the one-object-per-line tools print a summary line of words too. */
export const jsonLines = (output: string): Record<string, unknown>[] =>
  output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).map((line) => recordOf(JSON.parse(line), 'a line'));

// selene's json2: spans 0-based; no file name in the current output, so the checked file's (a filename key wins when there is one)
const selene: Parser = (output, { file = '' }) => jsonLines(output).filter((d) => d.type === 'Diagnostic').map((d) => {
  const label = recordOf(d.primary_label, 'primary_label');
  const span = recordOf(label.span, 'span');
  return finding(str(label.filename) ?? str(d.filename) ?? file, (num(span.start_line) ?? 0) + 1, next(span.start_column), severityOf(d.severity), str(d.message) ?? '',
    { code: d.code, endLine: next(span.end_line), endColumn: next(span.end_column) });
});

const stylelint: Parser = (output) => arrayOf(jsonOf(output), 'the results').flatMap((r) => {
  const result = recordOf(r, 'a result');
  return arrayOf(result.warnings, 'warnings').map((w) => {
    const x = recordOf(w, 'a warning');
    return finding(str(result.source) ?? '', num(x.line) ?? 1, num(x.column), severityOf(x.severity, 'warning'), str(x.text) ?? '', { code: x.rule, endLine: x.endLine, endColumn: x.endColumn });
  });
});

const htmlhint: Parser = (output) => arrayOf(jsonOf(output), 'the files').flatMap((f) => {
  const file = recordOf(f, 'a file');
  return arrayOf(file.messages, 'messages').map((m) => {
    const x = recordOf(m, 'a message');
    return finding(str(file.file) ?? '', num(x.line) ?? 1, num(x.col), severityOf(x.type, 'warning'), str(x.message) ?? '', { code: isRecord(x.rule) ? x.rule.id : undefined });
  });
});

// markdownlint's every rule is a style rule: a warning unless the report says otherwise
const markdownlint: Parser = (output) => arrayOf(jsonOf(output), 'the results').map((r) => {
  const x = recordOf(r, 'a result');
  const names = Array.isArray(x.ruleNames) ? x.ruleNames : [];
  const range = Array.isArray(x.errorRange) ? x.errorRange : [];
  const detail = str(x.errorDetail);
  const description = str(x.ruleDescription) ?? '';
  return finding(str(x.fileName) ?? '', num(x.lineNumber) ?? 1, num(range[0]), severityOf(x.severity, 'warning'), detail ? `${description} [${detail}]` : description, { code: names[0] });
});

// sqlfluff 3 names start_line_no / start_line_pos; older releases line_no / line_pos
const sqlfluff: Parser = (output) => arrayOf(jsonOf(output), 'the files').flatMap((f) => {
  const file = recordOf(f, 'a file');
  return arrayOf(file.violations, 'violations').map((v) => {
    const x = recordOf(v, 'a violation');
    return finding(str(file.filepath) ?? '', num(x.start_line_no) ?? num(x.line_no) ?? 1, num(x.start_line_pos) ?? num(x.line_pos), x.warning === true ? 'warning' : 'error',
      str(x.description) ?? '', { code: x.code, endLine: x.end_line_no, endColumn: x.end_line_pos });
  });
});

const swiftlint: Parser = (output) => arrayOf(jsonOf(output), 'the violations').map((v) => {
  const x = recordOf(v, 'a violation');
  return finding(str(x.file) ?? '', num(x.line) ?? 1, num(x.character), severityOf(x.severity, 'warning'), str(x.reason) ?? '', { code: x.rule_id });
});

const dart: Parser = (output) => arrayOf(recordOf(jsonOf(output), 'the report').diagnostics, 'diagnostics').map((d) => {
  const x = recordOf(d, 'a diagnostic');
  const location = recordOf(x.location, 'location');
  const range = recordOf(location.range, 'range');
  const start = recordOf(range.start, 'start');
  const end = isRecord(range.end) ? range.end : {};
  return finding(str(location.file) ?? '', num(start.line) ?? 1, num(start.column), severityOf(x.severity), str(x.problemMessage) ?? '', { code: x.code, endLine: end.line, endColumn: end.column });
});

// credo's categories are style but for warning
const credo: Parser = (output) => arrayOf(recordOf(jsonOf(output), 'the report').issues, 'issues').map((i) => {
  const x = recordOf(i, 'an issue');
  return finding(str(x.filename) ?? '', num(x.line_no) ?? 1, num(x.column), x.category === 'warning' ? 'warning' : 'info', str(x.message) ?? '', { code: x.check, endColumn: x.column_end });
});

// ktlint reports style violations only, with no severity of their own
const ktlint: Parser = (output) => arrayOf(jsonOf(output), 'the files').flatMap((f) => {
  const file = recordOf(f, 'a file');
  return arrayOf(file.errors, 'errors').map((e) => {
    const x = recordOf(e, 'an error');
    return finding(str(file.file) ?? '', num(x.line) ?? 1, num(x.column), 'warning', str(x.message) ?? '', { code: x.rule });
  });
});

/** The parsers of this half (#782), by CheckFormat. */
export const TOOL_PARSERS = { selene, stylelint, htmlhint, markdownlint, sqlfluff, swiftlint, dart, credo, ktlint } satisfies Record<string, Parser>;
