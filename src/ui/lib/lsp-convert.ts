// LSP's shapes as Monaco's (#780): positions, completion items, hovers, definitions, diagnostics and quick fixes. Pure: Monaco's enum values
// come in from the caller, so a test passes plain numbers.
import type { editor, IMarkdownString, IRange, languages } from 'monaco-editor';
import type { CodeAction, Command, CompletionItem, Diagnostic, Hover, InsertReplaceEdit, Location, LocationLink, MarkupContent, Position, Range, TextEdit } from 'vscode-languageserver-protocol';
import type { Problem, Severity } from '@/lib/problems';
import { pathOfUri } from '../../lsp-uri';

/** The Monaco enum values the mappings need (#780): read off monaco.languages and monaco.MarkerSeverity. */
export interface MonacoEnums {
  kinds: Readonly<Record<string, number>>; // languages.CompletionItemKind by name
  snippet: number; // languages.CompletionItemInsertTextRule.InsertAsSnippet
  severity: { Error: number; Warning: number; Info: number; Hint: number }; // MarkerSeverity
}

export const toRange = (r: Range): IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
export const toLspPosition = (p: { lineNumber: number; column: number }): Position => ({ line: p.lineNumber - 1, character: p.column - 1 });
export const toLspRange = (r: IRange): Range => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });

// LSP's CompletionItemKind, 1-based, as Monaco's enum names
const KIND_NAMES = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
const SNIPPET_FORMAT = 2; // InsertTextFormat.Snippet

export function toDocumentation(doc: string | MarkupContent | undefined): string | IMarkdownString | undefined {
  if (doc === undefined || typeof doc === 'string') return doc;
  return doc.kind === 'markdown' ? { value: doc.value } : doc.value;
}

function rangeOf(edit: TextEdit | InsertReplaceEdit | undefined, word: IRange): languages.CompletionItem['range'] {
  if (edit === undefined) return word;
  return 'range' in edit ? toRange(edit.range) : { insert: toRange(edit.insert), replace: toRange(edit.replace) };
}

/** A completion item as Monaco's (#780): its textEdit's range, else the word's; a snippet keeps its placeholders. */
export function toSuggestion(item: CompletionItem, word: IRange, enums: MonacoEnums): languages.CompletionItem {
  const documentation = toDocumentation(item.documentation);
  return {
    label: item.label, kind: enums.kinds[KIND_NAMES[(item.kind ?? 1) - 1] ?? 'Text'] ?? enums.kinds.Text,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label, range: rangeOf(item.textEdit, word),
    ...(item.insertTextFormat === SNIPPET_FORMAT ? { insertTextRules: enums.snippet } : {}),
    ...(item.detail === undefined ? {} : { detail: item.detail }), ...(documentation === undefined ? {} : { documentation }),
    ...(item.sortText === undefined ? {} : { sortText: item.sortText }), ...(item.filterText === undefined ? {} : { filterText: item.filterText }),
  };
}

const markedOf = (part: string | { language: string; value: string }): IMarkdownString =>
  (typeof part === 'string' ? { value: part } : { value: `\`\`\`${part.language}\n${part.value}\n\`\`\`` });

/** A hover's contents as markdown blocks (#780): a { language, value } part fenced. */
export function toMarkdown(contents: Hover['contents']): IMarkdownString[] {
  if (Array.isArray(contents)) return contents.map(markedOf);
  if (typeof contents === 'object' && 'kind' in contents) return [{ value: contents.value }];
  return [markedOf(contents)];
}

/** A definition's targets (#780): a Location, a list of them, or LocationLinks. */
export function locationsOf(result: Location | Location[] | LocationLink[] | null | undefined): { uri: string; range: Range }[] {
  if (!result) return [];
  const list: (Location | LocationLink)[] = Array.isArray(result) ? [...result] : [result];
  return list.map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange } : { uri: l.uri, range: l.range }));
}

function severityOf(severity: number | undefined, enums: MonacoEnums): number {
  if (severity === 2) return enums.severity.Warning;
  if (severity === 3) return enums.severity.Info;
  return severity === 4 ? enums.severity.Hint : enums.severity.Error; // none given: the client decides, and an error is the safe read
}

export function toMarker(d: Diagnostic, enums: MonacoEnums): editor.IMarkerData {
  return { ...toRange(d.range), message: typeof d.message === 'string' ? d.message : d.message.value, severity: severityOf(d.severity, enums), ...(d.source ? { source: d.source } : {}), ...(d.code === undefined ? {} : { code: String(d.code) }) };
}

/** A marker back as the diagnostic a codeAction request names (#780). */
export function markerToDiagnostic(m: editor.IMarkerData, enums: MonacoEnums): Diagnostic {
  const severity = ({ [enums.severity.Error]: 1, [enums.severity.Warning]: 2, [enums.severity.Info]: 3, [enums.severity.Hint]: 4 } as Record<number, 1 | 2 | 3 | 4>)[m.severity];
  const code = typeof m.code === 'object' ? m.code.value : m.code;
  return { range: toLspRange(m), message: m.message, ...(severity ? { severity } : {}), ...(m.source ? { source: m.source } : {}), ...(code === undefined ? {} : { code }) };
}

const SEVERITY: Partial<Record<number, Severity>> = { 1: 'error', 2: 'warning', 3: 'info' };

/** A server's diagnostics as the store's problems (#782): 1-based, the code as text (tsc's checker stores its number the same way); a hint is no
 * problem, as it never counts, and none given reads as an error. */
export function toProblems(path: string, diagnostics: Diagnostic[], source: string): Problem[] {
  return diagnostics.flatMap((d) => {
    const severity = d.severity === undefined ? 'error' : SEVERITY[d.severity];
    if (severity === undefined) return [];
    const range = toRange(d.range);
    const message = typeof d.message === 'string' ? d.message : d.message.value;
    return [{
      path, line: range.startLineNumber, column: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn, severity, message,
      ...(d.code === undefined ? {} : { code: String(d.code) }), source, fromServer: true,
    }];
  });
}

// Two URIs of one file: a server may escape ( ) ' ! * where the page did not, so they compare as the paths they decode to
const sameFile = (a: string, b: string): boolean => a === b || (pathOfUri(a) !== undefined && pathOfUri(a) === pathOfUri(b));

/** A quick fix's edits when the pane may offer it (#780): an action of kind quickfix (or none) whose edit touches only `uri`; a bare command,
 * an action with no edit or one editing another file is undefined. */
export function quickFixEdits(action: Command | CodeAction, uri: string): TextEdit[] | undefined {
  if (!('edit' in action) || action.edit === undefined) return undefined;
  if (action.kind !== undefined && !action.kind.startsWith('quickfix')) return undefined;
  const changes = Object.entries(action.edit.changes ?? {});
  const documents = action.edit.documentChanges ?? [];
  if (changes.some(([target]) => !sameFile(target, uri))) return undefined;
  if (documents.some((c) => !('textDocument' in c) || !sameFile(c.textDocument.uri, uri))) return undefined;
  const edits = [...changes.flatMap(([, list]) => list), ...documents.flatMap((c) => ('edits' in c ? c.edits.filter((e): e is TextEdit => 'range' in e && 'newText' in e) : []))];
  return edits.length === 0 ? undefined : edits;
}

/** Monaco's completion context as LSP's (#780): Monaco counts trigger kinds from 0, LSP from 1. */
export function toCompletionContext(context: languages.CompletionContext): { triggerKind: number; triggerCharacter?: string } {
  return { triggerKind: context.triggerKind + 1, ...(context.triggerCharacter === undefined ? {} : { triggerCharacter: context.triggerCharacter }) };
}
