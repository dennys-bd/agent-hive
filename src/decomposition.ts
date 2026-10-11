// A decomposition's file (#865, #936): decomposition.md read into its goal, its label, its root design and its nodes; the bodies its issues get; and what a
// task's result says of its write. Pure, no Node import: the UI reads decompositionPending through task-state.ts.
import { BODY_MAX, checkNodes, labelProblems, type NodeLines, type ParsedNode } from './decomposition-check.js';
import { overlapWarnings } from './decomposition-overlap.js';
import type { Decomposition, DecompositionNode, DecompositionProblem } from './types.js';

/** The keys of result.decompositionIssues besides node ids (#865): a local goal's root issue, a GitHub goal's design comment (the goal's
 * number), and the write's end (the root epic's number), which tells a written tree from one halfway. */
export const ROOT_KEY = 'root';
export const DESIGN_KEY = 'design';
export const DONE_KEY = 'done';

/** What parseDecomposition reads (#865): the tree only when it has no problem; the count of `## Suggestions` items, which never become issues;
 * the overlap warnings (#936), only when there is no problem. */
export interface ParsedDecomposition { decomposition?: Decomposition; problems: DecompositionProblem[]; suggestions: number; warnings: DecompositionProblem[] }

interface Line { n: number; text: string; fenced: boolean } // n: 1-based; fenced: inside a fenced block, its fences included
interface Part { heading: string; n: number; lines: Line[] }
type Subsection = 'scope' | 'design' | 'openPoints' | 'criteria';
type Marker = 'delivers' | 'consumes' | 'blockedBy' | 'touches';

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const NODE_HEADING = /^(\d+(?:\.\d+)*)(?:\s+(.*))?$/;
const MARKERS: readonly (readonly [string, Marker])[] = [['Delivers:', 'delivers'], ['Consumes:', 'consumes'], ['Blocked by:', 'blockedBy'], ['Touches:', 'touches']];
const LABEL = 'Label:';
const SUBSECTIONS: Readonly<Record<string, Subsection>> = { Scope: 'scope', Design: 'design', 'Open points': 'openPoints', 'Acceptance criteria': 'criteria' };

// The file's lines with their numbers: a fenced block's lines are marked, so no heading or marker is read inside one; the first mermaid
// block is dropped whole (a view the Hive never reads); a fence left open is a problem
function scan(text: string): { lines: Line[]; problems: DecompositionProblem[] } {
  const lines: Line[] = [];
  let open: { mark: string; n: number; dropped: boolean } | undefined;
  let mermaidSeen = false;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const fence = FENCE.exec(raw.trim());
    const closes = open !== undefined && fence !== null && fence[2].trim() === '' && fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length;
    if (open === undefined && fence !== null) {
      const dropped: boolean = !mermaidSeen && fence[2].trim() === 'mermaid';
      mermaidSeen ||= dropped;
      open = { mark: fence[1], n: i + 1, dropped };
    }
    if (!open?.dropped) lines.push({ n: i + 1, text: raw, fenced: open !== undefined });
    if (closes) open = undefined;
  }
  return { lines, problems: open === undefined ? [] : [{ line: open.n, message: 'fenced block left open' }] };
}

const headingOf = (line: Line, marks: string): string | undefined =>
  (!line.fenced && line.text.startsWith(`${marks} `) ? line.text.slice(marks.length + 1).trim() : undefined);

const tidy = (lines: Line[]): string => lines.map((l) => l.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();

// The lines up to the first `## ` heading (the goal), then one part per `## ` heading
function partsOf(lines: Line[]): { head: Line[]; parts: Part[] } {
  const head: Line[] = [];
  const parts: Part[] = [];
  for (const line of lines) {
    const heading = headingOf(line, '##');
    if (heading !== undefined) parts.push({ heading, n: line.n, lines: [] });
    else (parts.at(-1)?.lines ?? head).push(line);
  }
  return { head, parts };
}

// A marker's comma-separated list, which may be empty; an id named twice is a problem
function listOf(raw: string, label: string, n: number, problems: DecompositionProblem[]): string[] {
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => id !== '');
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) problems.push({ line: n, message: `"${twice}" repeated in "${label}"` });
  return ids;
}

// The node's marker lines, wherever they sit, taken out of the text they sit in so they never repeat in a section; a missing one is empty
function takeMarkers(lines: Line[], problems: DecompositionProblem[]): { lists: Record<Marker, string[]>; at: NodeLines; rest: Line[] } {
  const lists: Record<Marker, string[]> = { delivers: [], consumes: [], blockedBy: [], touches: [] };
  const at: NodeLines = {};
  const rest: Line[] = [];
  for (const line of lines) {
    const found = line.fenced ? undefined : MARKERS.find(([label]) => line.text.trim().startsWith(label));
    if (found === undefined) {
      rest.push(line);
      continue;
    }
    const [label, key] = found;
    if (at[key] !== undefined) problems.push({ line: line.n, message: `"${label}" repeated` });
    at[key] = line.n;
    lists[key] = listOf(line.text.trim().slice(label.length), label, line.n, problems);
  }
  return { lists, at, rest };
}

// The node's text before its first `### ` (its body) and each known subsection; an unknown or a repeated one is a problem
function subsectionsOf(lines: Line[], problems: DecompositionProblem[]): { body: Line[]; subs: Map<Subsection, Part> } {
  const body: Line[] = [];
  const subs = new Map<Subsection, Part>();
  let current: Part | undefined;
  for (const line of lines) {
    const heading = headingOf(line, '###');
    if (heading === undefined) {
      (current?.lines ?? body).push(line);
      continue;
    }
    const key = Object.hasOwn(SUBSECTIONS, heading) ? SUBSECTIONS[heading] : undefined;
    current = { heading, n: line.n, lines: [] };
    if (key === undefined) problems.push({ line: line.n, message: `unknown subsection "### ${heading}"` });
    else if (subs.has(key)) problems.push({ line: line.n, message: `"### ${heading}" repeated` });
    else subs.set(key, current);
  }
  return { body, subs };
}

// An `Open points` or `Acceptance criteria` list: `- ` items; the first other non-blank line ends it, and is a problem
function itemsOf(part: Part | undefined, problems: DecompositionProblem[]): string[] {
  if (part === undefined) return [];
  const items: string[] = [];
  for (const line of part.lines) {
    if (line.text.trim() === '') continue;
    if (line.fenced || !line.text.startsWith('- ')) {
      problems.push({ line: line.n, message: `text after the list in "### ${part.heading}"` });
      break;
    }
    items.push(line.text.slice(2).trim());
  }
  return items;
}

function nodeOf(id: string, title: string, part: Part, problems: DecompositionProblem[]): ParsedNode {
  const { lists, at, rest } = takeMarkers(part.lines, problems);
  const { body, subs } = subsectionsOf(rest, problems);
  const design = subs.get('design');
  const node: DecompositionNode = {
    id, title, body: tidy(body), scope: tidy(subs.get('scope')?.lines ?? []), ...(design === undefined ? {} : { design: tidy(design.lines) }),
    openPoints: itemsOf(subs.get('openPoints'), problems), criteria: itemsOf(subs.get('criteria'), problems), ...lists,
    touches: lists.touches.map((path) => path.replace(/\/+$/, '')), // #936: `src/` and `src` are one folder
  };
  return { node, line: part.n, at: { ...at, design: design?.n, openPoints: subs.get('openPoints')?.n, criteria: subs.get('criteria')?.n } };
}

// The `## ` parts after the goal: the root's design, the suggestions (counted, never kept) and the nodes; any other heading is a problem
function readParts(parts: Part[], problems: DecompositionProblem[]): { design?: string; suggestions: number; nodes: ParsedNode[] } {
  let design: string | undefined;
  let suggestions = 0;
  const nodes: ParsedNode[] = [];
  for (const part of parts) {
    const id = NODE_HEADING.exec(part.heading);
    if (part.heading === 'Design') {
      if (design !== undefined) problems.push({ line: part.n, message: '"## Design" repeated' });
      design = tidy(part.lines);
    } else if (part.heading === 'Suggestions') suggestions += part.lines.filter((l) => !l.fenced && l.text.startsWith('- ')).length;
    else if (id === null) problems.push({ line: part.n, message: `unknown section "## ${part.heading}"` });
    else nodes.push(nodeOf(id[1], (id[2] ?? '').trim(), part, problems));
  }
  return { ...(design ? { design } : {}), suggestions, nodes };
}

// The goal's `Label:` line (#936): in its head, outside a fence, at most once; taken out of the goal's text. `line` is where a problem with
// it is reported
function takeLabel(head: Line[], problems: DecompositionProblem[]): { label?: string; line: number; rest: Line[] } {
  const found = head.filter((line) => !line.fenced && line.text.trim().startsWith(LABEL));
  for (const again of found.slice(1)) problems.push({ line: again.n, message: `"${LABEL}" repeated` });
  const [first] = found;
  const rest = head.filter((line) => !found.includes(line));
  return first === undefined ? { line: 1, rest } : { label: first.text.trim().slice(LABEL.length).trim(), line: first.n, rest };
}

/** decomposition.md as the Hive reads it (#865): the goal (the `# ` title and its text, the first mermaid block dropped), `## Design`, the
 * nodes in file order and the count of `## Suggestions`, with every problem at its line. The tree comes back only when there is no problem. */
export function parseDecomposition(text: string): ParsedDecomposition {
  const scanned = scan(text);
  const problems = [...scanned.problems];
  const { head: lines, parts } = partsOf(scanned.lines);
  const { label, line: labelLine, rest: head } = takeLabel(lines, problems);
  const titleLine = head.find((line) => headingOf(line, '#') !== undefined);
  const title = titleLine === undefined ? '' : headingOf(titleLine, '#') ?? '';
  if (title === '') problems.push({ line: titleLine?.n ?? 1, message: 'the goal has no "# " title' }); // a local goal's root issue needs one
  const { design, suggestions, nodes } = readParts(parts, problems);
  problems.push(...checkNodes(nodes), ...labelProblems(label, labelLine));
  const goal = tidy(head.filter((line) => line !== titleLine));
  const decomposition: Decomposition = { title, goal, ...(label === undefined ? {} : { label }), ...(design ? { design } : {}), nodes: nodes.map((p) => p.node) };
  problems.push(...bodyProblems(decomposition, nodes, { title: titleLine?.n ?? 1, design: parts.find((p) => p.heading === 'Design')?.n ?? 1 }));
  if (problems.length > 0) return { problems: problems.sort((a, b) => a.line - b.line), suggestions, warnings: [] };
  return { decomposition, problems: [], suggestions, warnings: overlapWarnings(nodes) };
}

// A `## ` section of an issue body, or nothing when its text is empty
const sectionOf = (title: string, text: string | undefined): string[] => (text ? [`## ${title}\n\n${text}`] : []);
const listText = (items: string[]): string => items.map((item) => `- ${item}`).join('\n');
const joined = (parts: string[]): string => parts.filter((p) => p !== '').join('\n\n');

/** A node's issue body (#865): its free text, then Scope, Design (inner) or Open points (leaf), Acceptance criteria (leaf) and Contracts,
 * each only when the node has it. Blocked by is GitHub's relation, not text. */
export function issueBody(node: DecompositionNode): string {
  const contracts = [node.delivers.length > 0 ? `Delivers: ${node.delivers.join(', ')}` : '', node.consumes.length > 0 ? `Consumes: ${node.consumes.join(', ')}` : ''];
  return joined([
    node.body, ...sectionOf('Scope', node.scope), ...sectionOf('Design', node.design), ...sectionOf('Open points', listText(node.openPoints)),
    ...sectionOf('Acceptance criteria', listText(node.criteria)), ...sectionOf('Contracts', contracts.filter((l) => l !== '').join('\n')),
  ]);
}

/** A local goal's root issue body (#865): the goal's text, then its `## Design`. */
export const rootBody = (d: Decomposition): string => joined([d.goal, ...sectionOf('Design', d.design)]);

/** A GitHub goal's design comment (#865), headed `## Design`: the goal's own text stays its issue's body. */
export const designComment = (d: Decomposition): string => joined(sectionOf('Design', d.design));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The steps a decomposition's write recorded (#865): result.decompositionIssues, integer numbers only. */
export function recordedIssues(result: Record<string, unknown> | undefined): Record<string, number> {
  const issues = result?.decompositionIssues;
  if (!isRecord(issues)) return {};
  return Object.fromEntries(Object.entries(issues).filter((entry): entry is [string, number] => Number.isInteger(entry[1])));
}

/** Whether the write reached its end (#865): `done` is recorded. */
export const decompositionWritten = (result: Record<string, unknown> | undefined): boolean => recordedIssues(result)[DONE_KEY] !== undefined;

/** Whether the task's result holds a decomposition not on GitHub yet (#865): criar issues replaces aprovar while it does. */
export const decompositionPending = (result: Record<string, unknown> | undefined): boolean =>
  typeof result?.decomposition === 'string' && !decompositionWritten(result);

// GitHub refuses a body over its limit: caught here so no write stops halfway. The design comment is part of the root body, so the root's
// is checked only when the comment fits
function bodyProblems(d: Decomposition, nodes: ParsedNode[], at: { title: number; design: number }): DecompositionProblem[] {
  const over = (line: number, what: string): DecompositionProblem[] => [{ line, message: `${what} is over ${BODY_MAX} characters` }];
  const tooBig = (text: string): boolean => text.length > BODY_MAX;
  const root = tooBig(designComment(d)) ? over(at.design, 'the design comment') : tooBig(rootBody(d)) ? over(at.title, 'the goal issue body') : [];
  return [...root, ...nodes.filter((p) => tooBig(issueBody(p.node))).flatMap((p) => over(p.line, 'the issue body'))];
}
