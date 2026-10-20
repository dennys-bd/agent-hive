// The skill editor's look of a template (#319): what Monaco hides, marks and puts in the conditions column, in edit mode and in the "view as"
// preview. Pure: TemplateText turns a look into Monaco's calls, so the rules are tested without an editor.
import { type Catalogue, findReferences, type MapBranch, type TemplateMap } from '../../template-map.js';
import { chainsOf, type Preview } from '../../template-preview.js';
import type { ParsedTemplate } from '../../template.js';

export type EditorMode = 'visual' | 'text';
export interface LineRange { from: number; to: number } // 1-based, inclusive
export type LookClass = 'template-pill' | 'template-ref' | 'template-marker' | 'template-branch' | 'template-dim' | 'template-annotation-yellow' | 'template-annotation-red' | 'template-proposal-old' | 'template-proposal-new'; // index.css
/** A mark on a line: columns from..to (1-based, to exclusive), or the whole line's text; a background spans the line's width. */
export interface Decoration { line: number; from?: number; to?: number; className: LookClass; isBackground?: boolean }
export interface Chip { line: number; label: string }
/** dimmed: the source lines of the branches that do not hold (the map dims them); lineOf: a source line's line in the editor. */
export interface TextLook { text: string; hidden: LineRange[]; decorations: Decoration[]; chips: Chip[]; dimmed: ReadonlySet<number>; lineOf(source: number): number }
interface LookArgs { text: string; parsed: ParsedTemplate; map: TemplateMap; catalogue: Catalogue; mode: EditorMode; isHeaderShown?: boolean }

const NONE: ReadonlySet<number> = new Set();
const MARKDOWN = /\.md(\.liquid)?$/;
// {{ name }} and {{ name | filter }}; a pill only for a name the header declares, or the built-in workspace
const OUTPUT = /\{\{-?\s*([A-Za-z_][A-Za-z0-9_]*)[^}]*\}\}/g;
const BUILT_IN = 'workspace';

/** Only a markdown body has headings and Liquid blocks (decision 14). */
export const isMarkdown = (path: string): boolean => MARKDOWN.test(path);

/** A branch as its chip and map row read it; the Liquid words stay in English in every language (handoff). */
export const branchLabel = ({ marker, conditionText }: MapBranch): string =>
  marker === 'else' ? 'else' : `${marker === 'elsif' ? 'else if' : marker} ${conditionText}`;

const markerLines = (map: TemplateMap): number[] => chainsOf(map.blocks).flatMap((c) => [...c.branches.map((b) => b.line), c.endLine]);
const span = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

// Lines as ranges, consecutive ones merged: one hidden area per run
function rangesOf(lines: readonly number[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of [...lines].sort((x, y) => x - y)) {
    const last = ranges.at(-1);
    if (last !== undefined && line <= last.to + 1) last.to = Math.max(last.to, line);
    else ranges.push({ from: line, to: line });
  }
  return ranges;
}

/** Where a click on a hidden line lands (decision 19): the first line after its hidden run. */
export function visibleLine(line: number, hidden: readonly LineRange[]): number {
  const range = hidden.find((r) => line >= r.from && line <= r.to);
  return range === undefined ? line : range.to + 1;
}

function pillsOf(source: string, line: number, names: ReadonlySet<string>): Decoration[] {
  return [...source.matchAll(OUTPUT)]
    .filter((match) => names.has(match[1] ?? ''))
    .map((match) => ({ line, from: (match.index ?? 0) + 1, to: (match.index ?? 0) + match[0].length + 1, className: 'template-pill' }));
}

// findReferences answers names, not columns: each is found after the previous one, as the recogniser reads the line left to right
function refsOf(source: string, line: number, catalogue: Catalogue): Decoration[] {
  return findReferences(source, line, catalogue).reduce<{ at: number; marks: Decoration[] }>((found, ref) => {
    const start = source.indexOf(ref.name, found.at);
    if (start < 0) return found;
    return { at: start + ref.name.length, marks: [...found.marks, { line, from: start + 1, to: start + ref.name.length + 1, className: 'template-ref' }] };
  }, { at: 0, marks: [] }).marks;
}

function decorationsOf({ text, parsed, map, catalogue, mode }: LookArgs): Decoration[] {
  const names = new Set([...parsed.variables.map((v) => v.name), BUILT_IN]);
  const branches = chainsOf(map.blocks).flatMap((c) => span(c.line, c.endLine)).map((line): Decoration => ({ line, className: 'template-branch', isBackground: true }));
  const greys = mode === 'text' ? markerLines(map).map((line): Decoration => ({ line, className: 'template-marker' })) : [];
  const body = text.split('\n').flatMap((source, index) => (index + 1 < parsed.bodyLine ? [] : [...pillsOf(source, index + 1, names), ...refsOf(source, index + 1, catalogue)]));
  return [...branches, ...greys, ...body];
}

/** The template being edited (decisions 15–17): visual hides the header and the markers, text shows every line with the markers grey. A
 * specialist's header has no field form, so visual keeps it in the text (#323). */
export function templateLook(args: LookArgs): TextLook {
  const header = args.isHeaderShown ? [] : span(1, args.parsed.bodyLine - 1);
  const hidden = args.mode === 'text' ? [] : rangesOf([...header, ...markerLines(args.map)]);
  const chips = chainsOf(args.map.blocks).flatMap((c) => c.branches.map((b) => ({ line: b.line, label: branchLabel(b) })));
  return { text: args.text, hidden, decorations: decorationsOf(args), chips, dimmed: NONE, lineOf: (line) => visibleLine(line, hidden) };
}

/** The read-only preview (decision 23): the delivered header and the resolved lines, the markers hidden, a branch that does not hold at .35. */
export function previewLook(preview: Extract<Preview, { ok: true }>): TextLook {
  const offset = preview.header === '' ? 0 : preview.header.split('\n').length - 1; // the header ends with its fence's newline
  const at = (index: number): number => offset + index + 1;
  const hidden = rangesOf(preview.lines.flatMap((l, i) => (l.isMarker ? [at(i)] : [])));
  const decorations = preview.lines.flatMap((l, i): Decoration[] => (l.holds ? [] : [{ line: at(i), className: 'template-dim' }]));
  const lineOfSource = new Map(preview.lines.map((l, i) => [l.line, at(i)]));
  return {
    text: preview.header + preview.lines.map((l) => l.text).join('\n'),
    hidden, decorations, chips: [],
    dimmed: new Set(preview.lines.filter((l) => !l.holds).map((l) => l.line)),
    lineOf: (line) => visibleLine(lineOfSource.get(line) ?? line, hidden),
  };
}

/** A file with no map (decision 14): its text as it is. */
export const plainLook = (text: string): TextLook => ({ text, hidden: [], decorations: [], chips: [], dimmed: NONE, lineOf: (line) => line });
