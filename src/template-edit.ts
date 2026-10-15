// Text edits of a template (#311, node 1.2 of #309): insert, replace and remove a chain, move a block, add a variable, set a variable's
// value. Each edits whole lines (or the header's yaml Document) and answers the new text with its parse and map, so the editor reloads
// from one place. Node-free, like src/template.ts.
import { type Document, parseDocument } from 'yaml';
import { type ChainSpec, chainMarkers } from './template-condition.js';
import { buildMap, type MapBlock, type TemplateMap } from './template-map.js';
import { type ParsedTemplate, parseTemplate, splitHeader, type TemplateError, type VariableValue } from './template.js';

export type EditResult = { ok: true; text: string; parsed: ParsedTemplate; map: TemplateMap } | { ok: false; error: TemplateError };

export interface VariableDeclaration {
  name: string;
  type?: 'boolean';
  values?: string[];
  default?: VariableValue;
  required?: boolean;
  workspaces?: Record<string, VariableValue>;
}

type ChainBlock = Extract<MapBlock, { kind: 'chain' }>;

interface Source {
  text: string;
  lines: string[]; // a final newline leaves an empty last element, which no block owns
  eol: string;
  parsed: ParsedTemplate;
  map: TemplateMap;
}

type Change = (source: Source) => string | string[] | TemplateError;

const LINE_BREAK = /\r?\n/;
const NO_LINE = 1; // an error with no line of its own points at the file's start
const FENCE = '---';

// Edits read structure only, so the map is built without a catalogue.
function answer(text: string): EditResult {
  const parsed = parseTemplate(text);
  const map = buildMap(parsed);
  const [error] = [...parsed.errors, ...map.errors];
  return error === undefined ? { ok: true, text, parsed, map } : { ok: false, error };
}

function load(text: string): Source | TemplateError {
  const loaded = answer(text);
  if (!loaded.ok) return loaded.error;
  return { text, lines: text.split(LINE_BREAK), eol: text.includes('\r\n') ? '\r\n' : '\n', parsed: loaded.parsed, map: loaded.map };
}

// One path for every edit: refuse a text with errors, change it, refuse a result with errors, never throw.
function edit(text: string, change: Change): EditResult {
  const source = load(text);
  if ('message' in source) return { ok: false, error: source };
  try {
    const changed = change(source);
    if (Array.isArray(changed)) return answer(changed.join(source.eol));
    return typeof changed === 'string' ? answer(changed) : { ok: false, error: changed };
  } catch (err) {
    // yaml's setIn throws on a path through a scalar; an edit answers an error instead
    return { ok: false, error: { line: NO_LINE, message: err instanceof Error ? err.message : String(err) } };
  }
}

// Lines from..to (1-based, inclusive) replaced by the given ones; to = from - 1 inserts before from.
const splice = (lines: string[], from: number, to: number, inserted: string[]): string[] => [
  ...lines.slice(0, from - 1),
  ...inserted,
  ...lines.slice(to),
];

const lastLine = (source: Source): number => source.lines.length - (source.lines[source.lines.length - 1] === '' ? 1 : 0);

function childLists(block: MapBlock): MapBlock[][] {
  if (block.kind === 'heading') return [block.children];
  return block.kind === 'chain' ? block.branches.map((branch) => branch.children) : [];
}

// The block starting at line, with its siblings: the movable blocks that share its parent (the introduction never moves).
function findBlock(blocks: MapBlock[], line: number): { block: MapBlock; siblings: MapBlock[] } | undefined {
  const siblings = blocks.filter((block) => block.kind !== 'introduction');
  const block = siblings.find((candidate) => candidate.line === line);
  if (block !== undefined) return { block, siblings };
  for (const list of siblings.flatMap(childLists)) {
    const found = findBlock(list, line);
    if (found !== undefined) return found;
  }
  return undefined;
}

function chainAt(source: Source, line: number): ChainBlock | TemplateError {
  const block = findBlock(source.map.blocks, line)?.block;
  return block?.kind === 'chain' ? block : { line, message: `no chain starts at line ${line}` };
}

function chainProblem(chain: ChainSpec): string | undefined {
  if (chain.branches.length === 0) return 'a chain needs at least one condition';
  return chain.branches.some((condition) => condition.terms.length === 0) ? 'a condition needs at least one term' : undefined;
}

/** An empty chain, its markers only, before line; the line after the body's last appends. */
export function insertChain(text: string, line: number, chain: ChainSpec): EditResult {
  return edit(text, (source) => {
    const first = source.parsed.bodyLine;
    const after = lastLine(source) + 1;
    if (line < first || line > after) return { line, message: `a chain goes before a body line, ${first} to ${after}` };
    const problem = chainProblem(chain);
    return problem === undefined ? splice(source.lines, line, line - 1, chainMarkers(chain)) : { line, message: problem };
  });
}

/** The chain's marker lines go; every branch's text stays, in order. */
export function removeChain(text: string, line: number): EditResult {
  return edit(text, (source) => {
    const chain = chainAt(source, line);
    if ('message' in chain) return chain;
    const markers = new Set([...chain.branches.map((branch) => branch.line), chain.endLine]);
    return source.lines.filter((_, index) => !markers.has(index + 1));
  });
}

interface HeldBranch {
  line: number;
  marker: string;
  body: string[];
}

// What each branch holds: the lines between its marker and the next one.
function heldBranches(lines: string[], chain: ChainBlock): HeldBranch[] {
  return chain.branches.map((branch, index) => {
    const next = index + 1 < chain.branches.length ? chain.branches[index + 1].line : chain.endLine;
    return { line: branch.line, marker: branch.marker, body: lines.slice(branch.line, next - 1) };
  });
}

function rewriteChain(lines: string[], chain: ChainBlock, spec: ChainSpec): string[] | TemplateError {
  const held = heldBranches(lines, chain);
  const conditional = held.filter((branch) => branch.marker !== 'else');
  const otherwise = held.find((branch) => branch.marker === 'else');
  const dropped = [...conditional.slice(spec.branches.length), ...(spec.else || otherwise === undefined ? [] : [otherwise])];
  // dropping text the user wrote is data loss: they empty the branch first
  const holding = dropped.find((branch) => branch.body.some((text) => text.trim() !== ''));
  if (holding !== undefined) {
    return { line: holding.line, message: `the {% ${holding.marker} %} branch holds text: empty it before removing it` };
  }
  const markers = chainMarkers(spec);
  const kept = spec.branches.flatMap((_, index) => [markers[index], ...(index < conditional.length ? conditional[index].body : [])]);
  const elseLines = spec.else ? [markers[spec.branches.length], ...(otherwise?.body ?? [])] : [];
  return [...kept, ...elseLines, markers[markers.length - 1]];
}

/** The chain's markers rewritten for new conditions, added elsif branches and the else toggled; no branch's text is lost. */
export function replaceChain(text: string, line: number, chain: ChainSpec): EditResult {
  return edit(text, (source) => {
    const found = chainAt(source, line);
    if ('message' in found) return found;
    const problem = chainProblem(chain);
    if (problem !== undefined) return { line, message: problem };
    const rewritten = rewriteChain(source.lines, found, chain);
    return Array.isArray(rewritten) ? splice(source.lines, found.line, found.endLine, rewritten) : rewritten;
  });
}

// Siblings trade slots; the lines between two siblings (a parent's own text after a chain) stay where they are, so a move down then up
// answers the input. Joining the lines moves the final line ending: a block leaving the end takes one, the new last one gives its own.
function reorder(lines: string[], siblings: MapBlock[], order: MapBlock[]): string[] {
  const span = (block: MapBlock): string[] => lines.slice(block.line - 1, block.endLine);
  const gap = (index: number): string[] =>
    index + 1 < siblings.length ? lines.slice(siblings[index].endLine, siblings[index + 1].line - 1) : [];
  const first = siblings[0].line;
  const last = siblings[siblings.length - 1].endLine;
  return [...lines.slice(0, first - 1), ...order.flatMap((block, index) => [...span(block), ...gap(index)]), ...lines.slice(last)];
}

/** The block starting at line moves to index among its siblings, under the same parent; its level never changes. */
export function moveBlock(text: string, line: number, index: number): EditResult {
  return edit(text, (source) => {
    const found = findBlock(source.map.blocks, line);
    if (found === undefined) return { line, message: `no heading or chain starts at line ${line}` };
    const { block, siblings } = found;
    if (!Number.isInteger(index) || index < 0 || index >= siblings.length) {
      return { line, message: `index ${index} is not a position among ${siblings.length} siblings` };
    }
    const others = siblings.filter((sibling) => sibling !== block);
    return reorder(source.lines, siblings, [...others.slice(0, index), block, ...others.slice(index)]);
  });
}

// The header rewritten through a fresh Document (never the parse's own), so comments, flow style and key order survive; the fences stay
// as written and the body is the text's own suffix. A text with no header gets one.
function writeHeader(source: Source, change: (doc: Document.Parsed) => void): string {
  const { header, body, bodyLine } = splitHeader(source.text);
  const doc = parseDocument(header);
  change(doc);
  // lineWidth 0: yaml would otherwise fold a long description or break a flow declaration at 80 columns
  const yamlLines = doc.toString({ lineWidth: 0 }).split('\n').slice(0, -1);
  const hasHeader = bodyLine > 1;
  const open = hasHeader ? source.lines[0] : FENCE;
  const close = hasHeader ? source.lines[bodyLine - 2] : FENCE;
  return [open, ...yamlLines, close, ''].join(source.eol) + body;
}

/** name: { … } at the end of the header's variables:, validated by the parse of the new text. */
export function addVariable(text: string, declaration: VariableDeclaration): EditResult {
  return edit(text, (source) => {
    const { name, ...fields } = declaration;
    const existing = source.parsed.variables.find((variable) => variable.name === name);
    if (existing !== undefined) return { line: existing.line, variable: name, message: `variable "${name}" is already declared` };
    // flow style, as the shipped templates write a declaration: one line per variable
    return writeHeader(source, (doc) => doc.setIn(['variables', name], doc.createNode(fields, { flow: true })));
  });
}

/** workspaces.<workspace> of a declared variable; undefined removes it, so the workspace falls back to the default. */
export function setVariableValue(text: string, name: string, workspace: string, value: VariableValue | undefined): EditResult {
  return edit(text, (source) => {
    if (!source.parsed.variables.some((variable) => variable.name === name)) {
      return { line: NO_LINE, variable: name, message: `variable "${name}" is not declared` };
    }
    const path = ['variables', name, 'workspaces', workspace];
    // nothing to remove is a success that leaves the text byte for byte as it was (deleteIn would throw on the missing parent)
    if (value === undefined && !parseDocument(splitHeader(source.text).header).hasIn(path)) return source.text;
    return writeHeader(source, (doc) => {
      if (value === undefined) doc.deleteIn(path);
      else doc.setIn(path, value);
    });
  });
}
