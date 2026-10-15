// The block map of a template's body (#311, node 1.2 of #309): heading blocks, conditional chains, the references each block makes,
// start lines and the collapse structure. Node-free, like src/template.ts: the editor's outline and the server read the same map.
import { type Condition, parseCondition } from './template-condition.js';
import type { ParsedTemplate, TemplateError } from './template.js';

export type ReferenceKind = 'skill' | 'agent' | 'skill-or-agent' | 'script';

export interface Reference {
  kind: ReferenceKind;
  name: string;
  line: number;
}

export interface Catalogue {
  skills: string[];
  agents: string[];
}

export type MapBlock =
  | { kind: 'introduction'; line: number; endLine: number; references: Reference[] }
  | {
      kind: 'heading';
      level: 2 | 3;
      title: string;
      line: number;
      endLine: number;
      references: Reference[];
      children: MapBlock[];
      count: number;
    }
  | { kind: 'chain'; tag: 'if' | 'unless'; line: number; endLine: number; branches: MapBranch[] };

export interface MapBranch {
  marker: 'if' | 'unless' | 'elsif' | 'else';
  conditionText: string; // '' for else
  condition: Condition | null; // null for else and for a condition the model cannot hold
  line: number; // the marker's line
  references: Reference[];
  children: MapBlock[];
}

export interface TemplateMap {
  blocks: MapBlock[];
  errors: TemplateError[];
}

const NAME = '[a-z0-9][a-z0-9-]*';
// A word starts at the line's start, after whitespace or after one of ( [ ` " ' — so src/ui, /Users/me/x and me@mail.com hold none.
const WORD_START = '(?<=^|[\\s(\\[`"\'])';
// A name ends where no path (/), longer name (-) or file extension (.x) goes on: /x/y and p:x//url are not calls.
// A name followed by :x is the head of a p:x name that failed further on, so it is no name either.
const WORD_END = '(?![\\w/-]|\\.\\w|:[a-z0-9])';
const WORD = new RegExp(`${WORD_START}(\\\\?)([/@]?)((?:${NAME}:)?${NAME})${WORD_END}`, 'g');
// Prose names such as Node.js and Next.js are no scripts: a bare file name is lowercase, only a path may use any case.
const EXTENSION = '\\.(?:py|sh|js|mjs|ts)';
const SCRIPT = new RegExp(
  `${WORD_START}((?:[\\w.-]+/)+[\\w-][\\w.-]*${EXTENSION}|[a-z0-9_-]+${EXTENSION})${WORD_END}`,
  'g',
);

function nameKind(sigil: string, name: string, catalogue?: Catalogue): ReferenceKind | undefined {
  if (sigil === '/') return 'skill';
  if (sigil === '@') return 'agent';
  if (catalogue?.skills.includes(name)) return 'skill';
  if (catalogue?.agents.includes(name)) return 'agent';
  // p:x names a plugin's skill or agent; a bare word without the catalogue would turn prose into chips
  return name.includes(':') ? 'skill-or-agent' : undefined;
}

export function findReferences(line: string, lineNumber: number, catalogue?: Catalogue): Reference[] {
  const names = [...line.matchAll(WORD)].flatMap((match) => {
    const kind = match[1] === '' ? nameKind(match[2], match[3], catalogue) : undefined; // \/x and \@x are literal
    return kind === undefined ? [] : [{ at: match.index ?? 0, reference: { kind, name: match[3], line: lineNumber } }];
  });
  const scripts = [...line.matchAll(SCRIPT)].map((match) => ({
    at: match.index ?? 0,
    reference: { kind: 'script' as const, name: match[1], line: lineNumber },
  }));
  return [...names, ...scripts].sort((a, b) => a.at - b.at).map((found) => found.reference);
}

const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MARKER_TAGS: readonly string[] = ['if', 'unless', 'elsif', 'else', 'endif', 'endunless'];
const MARKER_OPEN = /^\s*\{%-?\s*/;
const TAG_WORD = /^[a-z]+/;

// A marker alone on its line; an inline {% if %}…{% endif %} is text. Read with indexOf and trims, not one regex: whitespace runs
// matched by overlapping \s* and a lazy condition backtrack quadratically or worse on a long line (ReDoS).
function readMarker(text: string): { tag: MarkerTag; condition: string } | null {
  const open = MARKER_OPEN.exec(text);
  const close = text.indexOf('%}');
  // the first %} closes the tag: a condition never holds one, and anything after it makes the marker inline
  if (open === null || close < open[0].length || text.slice(close + 2).trim() !== '') return null;
  const inner = text.slice(open[0].length, close).trimEnd();
  const content = (inner.endsWith('-') ? inner.slice(0, -1) : inner).trimEnd();
  const tag = TAG_WORD.exec(content)?.[0] ?? '';
  const rest = content.slice(tag.length);
  if (!MARKER_TAGS.includes(tag) || (rest !== '' && !/^\s/.test(rest))) return null;
  return { tag: tag as MarkerTag, condition: rest.trim() };
}
const LITERAL_TAG = /\{%-?\s*(raw|endraw|comment|endcomment)\s*-?%\}/g;

type ChainTag = 'if' | 'unless';
type MarkerTag = ChainTag | 'elsif' | 'else' | 'endif' | 'endunless';

interface Container {
  references: Reference[];
  children: MapBlock[];
}
interface RootFrame extends Container {
  kind: 'root';
}
interface HeadingFrame extends Container {
  kind: 'heading';
  level: 2 | 3;
  title: string;
  line: number;
}
interface OpenChain {
  tag: ChainTag;
  line: number;
  branches: MapBranch[];
}
interface BranchFrame extends Container {
  kind: 'branch';
  chain: OpenChain;
  marker: MapBranch['marker'];
  conditionText: string;
  line: number;
}
type Frame = RootFrame | HeadingFrame | BranchFrame;

// Local to one buildMap call: its frames are filled in place and handed out as the map; the parse is never touched.
interface Builder {
  root: RootFrame;
  stack: Frame[];
  errors: TemplateError[];
  introduction: number | null; // the introduction's first line
  catalogue?: Catalogue;
}

interface ScanState {
  fence: string | null; // the run that opened the markdown fence the scan is in
  literal: 'raw' | 'comment' | null; // inside {% raw %} or {% comment %}, markers are not tags
}

type LineKind = 'text' | 'title' | 'fenced';

// Every consumer of the map walks it recursively: the cap keeps a hostile text from overflowing the stack.
const MAX_CHAIN_DEPTH = 100;

const START: ScanState = { fence: null, literal: null };

const top = (b: Builder): Frame => b.stack[b.stack.length - 1];

// First occurrence of each kind and name, in order; a Set keeps it linear on a line that names thousands.
function dedupe(references: Reference[]): Reference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}\0${reference.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const headingBlock = (frame: HeadingFrame, endLine: number): MapBlock => ({
  kind: 'heading',
  level: frame.level,
  title: frame.title,
  line: frame.line,
  endLine,
  references: dedupe(frame.references),
  children: frame.children,
  count: frame.children.length,
});

function branchCondition(marker: MapBranch['marker'], text: string): Condition | null {
  if (marker === 'else') return null;
  const condition = parseCondition(text);
  if (marker !== 'unless') return condition;
  // unless v is "v is no"; any other unless negates a whole condition, which the model cannot hold
  const term = condition?.terms.length === 1 ? condition.terms[0] : undefined;
  return term?.op === 'hasValue' ? { connective: 'and', terms: [{ variable: term.variable, op: 'isNo' }] } : null;
}

const branchOf = (frame: BranchFrame): MapBranch => ({
  marker: frame.marker,
  conditionText: frame.conditionText,
  condition: branchCondition(frame.marker, frame.conditionText),
  line: frame.line,
  references: dedupe(frame.references),
  children: frame.children,
});

const chainBlock = (chain: OpenChain, endLine: number): MapBlock => ({
  kind: 'chain',
  tag: chain.tag,
  line: chain.line,
  endLine,
  branches: chain.branches,
});

const branchFrame = (chain: OpenChain, marker: MapBranch['marker'], conditionText: string, line: number): BranchFrame => ({
  kind: 'branch',
  chain,
  marker,
  conditionText,
  line,
  references: [],
  children: [],
});

// Closes the innermost frame at endLine and hands its block to the frame under it; the root is never closed.
function closeTop(b: Builder, endLine: number): void {
  const frame = top(b);
  if (frame.kind === 'root') return;
  b.stack.pop();
  if (frame.kind === 'heading') top(b).children.push(headingBlock(frame, endLine));
  else frame.chain.branches.push(branchOf(frame));
}

function nearestBranch(b: Builder): BranchFrame | undefined {
  for (let index = b.stack.length - 1; index >= 0; index--) {
    const frame = b.stack[index];
    if (frame.kind === 'branch') return frame;
  }
  return undefined;
}

function closeThrough(b: Builder, frame: Frame, endLine: number): void {
  while (b.stack.includes(frame)) closeTop(b, endLine);
}

// Answers false when the marker has no chain to belong to: the line is then text, with an error at it.
function onMarker(b: Builder, tag: MarkerTag, conditionText: string, line: number): boolean {
  if (tag === 'if' || tag === 'unless') {
    if (b.stack.filter((frame) => frame.kind === 'branch').length >= MAX_CHAIN_DEPTH) {
      b.errors.push({ line, message: `chains nest ${MAX_CHAIN_DEPTH} deep at most` });
      return false;
    }
    b.stack.push(branchFrame({ tag, line, branches: [] }, tag, conditionText, line));
    return true;
  }
  const branch = nearestBranch(b);
  if (branch === undefined) {
    b.errors.push({ line, message: `{% ${tag} %} with no open {% if %} or {% unless %}` });
    return false;
  }
  // a later marker closes everything opened inside the branch: headings never outlive it
  closeThrough(b, branch, line - 1);
  const { chain } = branch;
  if (tag === 'elsif' || tag === 'else') {
    b.stack.push(branchFrame(chain, tag, tag === 'else' ? '' : conditionText, line));
    return true;
  }
  if (tag !== `end${chain.tag}`) b.errors.push({ line, message: `{% ${tag} %} closes an {% ${chain.tag} %}` });
  top(b).children.push(chainBlock(chain, line));
  return true;
}

// A heading closes the open headings of its level or deeper, never past an open branch.
function openHeading(b: Builder, level: 2 | 3, title: string, line: number): void {
  for (let frame = top(b); frame.kind === 'heading' && frame.level >= level; frame = top(b)) closeTop(b, line - 1);
  b.stack.push({ kind: 'heading', level, title, line, references: [], children: [] });
}

function onText(b: Builder, text: string, line: number, kind: LineKind): void {
  const frame = top(b);
  // the introduction is the root's text before its first block: root text after a block belongs to no block
  if (frame.kind === 'root' && frame.children.length > 0) return;
  if (frame.kind === 'root' && b.introduction === null && kind !== 'title' && text.trim() !== '') b.introduction = line;
  // a loop, not push(...): spreading a line of hundreds of thousands of references overflows the call stack
  if (kind === 'text') for (const reference of findReferences(text, line, b.catalogue)) frame.references.push(reference);
}

function lineKind(state: ScanState, level: number): LineKind {
  if (state.fence !== null) return 'fenced';
  return level === 1 ? 'title' : 'text';
}

function nextFence(fence: string | null, text: string): string | null {
  const match = FENCE.exec(text);
  if (match === null) return fence;
  if (fence === null) return match[1];
  // a fence closes with a run of its own character at least as long, with nothing after it
  const closes = match[1][0] === fence[0] && match[1].length >= fence.length && text.trim() === match[1];
  return closes ? null : fence;
}

function nextLiteral(literal: ScanState['literal'], text: string): ScanState['literal'] {
  return [...text.matchAll(LITERAL_TAG)].reduce<ScanState['literal']>((open, match) => {
    const tag = match[1];
    if (open === null) return tag === 'raw' || tag === 'comment' ? tag : null;
    return tag === `end${open}` ? null : open;
  }, literal);
}

function scanLine(b: Builder, state: ScanState, raw: string, line: number): ScanState {
  const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  // markers count inside a markdown fence (Liquid renders them there), not inside raw or comment
  const marker = state.literal === null ? readMarker(text) : null;
  if (marker !== null && onMarker(b, marker.tag, marker.condition, line)) return state;
  const heading = state.fence === null ? HEADING.exec(text) : null;
  const level = heading === null ? 0 : heading[1].length;
  if (level === 2 || level === 3) openHeading(b, level, (heading?.[2] ?? '').trim(), line);
  onText(b, text, line, lineKind(state, level));
  return { fence: nextFence(state.fence, text), literal: nextLiteral(state.literal, text) };
}

// A final newline ends the last line instead of opening an empty one.
function bodyLines(body: string): string[] {
  if (body === '') return [];
  const lines = body.split('\n');
  return body.endsWith('\n') ? lines.slice(0, -1) : lines;
}

// What is still open at the end closes at the last line; an open chain is also an error at its first marker.
function closeAll(b: Builder, lastLine: number): void {
  for (let frame = top(b); frame.kind !== 'root'; frame = top(b)) {
    closeTop(b, lastLine);
    if (frame.kind !== 'branch') continue;
    b.errors.push({ line: frame.chain.line, message: `{% ${frame.chain.tag} %} is never closed` });
    top(b).children.push(chainBlock(frame.chain, lastLine));
  }
}

function introduction(b: Builder, lastLine: number): MapBlock[] {
  if (b.introduction === null) return [];
  const endLine = b.root.children.length > 0 ? b.root.children[0].line - 1 : lastLine;
  return [{ kind: 'introduction', line: b.introduction, endLine, references: dedupe(b.root.references) }];
}

export function buildMap(parsed: ParsedTemplate, catalogue?: Catalogue): TemplateMap {
  const root: RootFrame = { kind: 'root', references: [], children: [] };
  const b: Builder = { root, stack: [root], errors: [], introduction: null, catalogue };
  const lines = bodyLines(parsed.body);
  let state = START;
  for (const [index, text] of lines.entries()) state = scanLine(b, state, text, parsed.bodyLine + index);
  const lastLine = parsed.bodyLine + lines.length - 1;
  closeAll(b, lastLine);
  return { blocks: [...introduction(b, lastLine), ...root.children], errors: [...b.errors].sort((x, y) => x.line - y.line) };
}
