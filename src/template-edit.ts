// Text edits of a template (#311, node 1.2 of #309): insert, replace and remove a chain, move a block, add a variable, set a variable's
// value. Each edits whole lines (or the header's yaml Document) and answers the new text with its parse and map, so the editor reloads
// from one place. Node-free, like src/template.ts.
import { type ChainSpec, chainMarkers } from './template-condition.js';
import { buildMap, type MapBlock, type TemplateMap } from './template-map.js';
import { type ParsedTemplate, parseTemplate, type TemplateError, type VariableValue } from './template.js';

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
