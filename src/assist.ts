// Ask the agent (#330): the prompt, the check of the agent's answer, and the proposal as the new text and one diff hunk. Pure: the run is
// headless-run.ts's, the route server-assist.ts's. Lines are whole lines, 1-based, as the editor numbers them.
import { z } from 'zod';
import type { TemplateVariable } from './template.js';
import type { CatalogueItem, DiffHunk, DiffLine, ItemKind } from './types.js';

export interface AssistTarget { start: number; end: number } // inclusive; end = start - 1 only for an empty file
export interface Proposal { from: number; to: number; text: string }
/** POST /api/items/:id/assist's 200 answer (#330): server-assist.ts builds it, the editor's footer reads it (#331). */
export interface AssistAnswer { proposal: Proposal; hunk: DiffHunk; text: string; changed: boolean }
export interface AssistInput {
  request: string;
  path: string;
  kind: ItemKind;
  text: string; // what the editor shows, saved or not
  target: AssistTarget;
  variables: readonly TemplateVariable[];
  catalogue: readonly Pick<CatalogueItem, 'id' | 'kind' | 'name' | 'description'>[];
}

/** The answer's JSON Schema, handed to the model by both CLIs. It is a request: parseProposal is the guarantee. Codex's strict schemas need
 * every property required and no other. */
export const ASSIST_SCHEMA = {
  type: 'object',
  properties: { from: { type: 'integer' }, to: { type: 'integer' }, text: { type: 'string' } },
  required: ['from', 'to', 'text'],
  additionalProperties: false,
} as const;

const PROPOSAL = z.object({ from: z.number().int(), to: z.number().int(), text: z.string() });
export const KIND_WORDS: Record<ItemKind, string> = { skill: 'skill', specialist: 'subagent' }; // Claude Code's words, which the model knows

const ASSIST_INSTRUCTIONS = [
  'You edit one file of a Claude Code skill or subagent at the user\'s request. You cannot run tools; you only answer.',
  'Answer only a JSON object {"from": integer, "to": integer, "text": string}: lines from..to of the file (1-based, inclusive) are replaced',
  'by text, its lines joined with \\n and no trailing newline. to = from - 1 inserts text before line from. An empty text deletes the lines.',
  'Stay inside the lines the request may change: from >= its first line, to <= its last. Replace the fewest lines that do the request.',
  'Keep the Liquid valid: every {{ }} and {% %} closed, every block ended.',
  'Use only the declared variables below, or the built-in `workspace`. Name only items of the catalogue below.',
].join('\n');

/** A file's lines: a final newline ends the last line, it does not open an empty one. */
export function fileLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.slice(0, -1) : lines;
}

// ponytail: '' is a deletion, so a single empty line cannot be proposed; the prompt says so
const proposalLines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** The range a request may change: the selection, or the whole file without one; undefined for a selection outside the text. */
export function targetOf(text: string, selection?: { startLine: number; endLine: number }): AssistTarget | undefined {
  const count = fileLines(text).length;
  if (selection === undefined) return { start: 1, end: count };
  const { startLine, endLine } = selection;
  return startLine >= 1 && startLine <= endLine && endLine <= count ? { start: startLine, end: endLine } : undefined;
}

// #328: the template reviewer shows a file and its context the same way
export const numbered = (text: string): string => fileLines(text).map((line, i) => `${i + 1}| ${line}`).join('\n') || '(empty file)';

export const variablesBlock = (variables: readonly TemplateVariable[]): string =>
  variables.length === 0 ? '(none)' : JSON.stringify(variables.map(({ name, kind, values, default: value, required, workspaces }) =>
    ({ name, kind, values, default: value, required, workspaces })), null, 2);

export const catalogueBlock = (items: AssistInput['catalogue']): string =>
  items.map((item) => `- ${item.id} (${KIND_WORDS[item.kind]} ${item.name}): ${item.description}`).join('\n') || '(none)';

/** The whole prompt, on the run's stdin. */
export function assistPrompt(input: AssistInput): string {
  return [
    ASSIST_INSTRUCTIONS,
    `## Request\n${input.request}`,
    `## File\n${input.path}, a ${KIND_WORDS[input.kind]}. Only lines ${input.target.start}..${input.target.end} may change.`,
    `## Text\n${numbered(input.text)}`,
    `## Declared variables\n${variablesBlock(input.variables)}`,
    `## Catalogue\n${catalogueBlock(input.catalogue)}`,
  ].join('\n\n');
}

/** An agent's answer as JSON `schema` accepts, or why it is not: ask the agent's proposal and the template reviewer's annotations (#328). */
export function parseAnswer<T>(answer: string, schema: z.ZodType<T>): { data: T } | { reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(answer);
  } catch {
    return { reason: 'not JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { data: parsed.data };
  const issue = parsed.error.issues[0];
  return { reason: `not the expected JSON: ${issue?.path.join('.') || 'answer'}: ${issue?.message ?? 'invalid'}` };
}

/** The agent's answer as a proposal inside the target, or why it is refused. */
export function parseProposal(answer: string, target: AssistTarget): { proposal: Proposal } | { reason: string } {
  const parsed = parseAnswer(answer, PROPOSAL);
  if ('reason' in parsed) return parsed;
  const { from, to } = parsed.data;
  if (from > to + 1) return { reason: `from ${from} is past to ${to} + 1` };
  if (from < target.start || to > target.end) return { reason: `lines ${from}..${to} are outside ${target.start}..${target.end}` };
  return { proposal: parsed.data };
}

/** The whole file with the proposal applied, keeping its final newline. */
export function applyProposal(text: string, proposal: Proposal): string {
  const lines = fileLines(text);
  const next = [...lines.slice(0, proposal.from - 1), ...proposalLines(proposal.text), ...lines.slice(proposal.to)];
  const body = next.join('\n');
  return text.endsWith('\n') && next.length > 0 ? `${body}\n` : body;
}

const sharedHead = (a: string[], b: string[]): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
};
const sharedTail = (a: string[], b: string[]): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
};
const hunkStart = (from: number, count: number): number => (count === 0 ? from - 1 : from); // git's: an empty side names the line before

/** The proposal as one hunk in the diff pane's shape (#270): the lines both sides share at the range's edges are context. */
export function proposalHunk(text: string, proposal: Proposal): DiffHunk {
  const { from } = proposal;
  const before = fileLines(text).slice(from - 1, proposal.to);
  const after = proposalLines(proposal.text);
  const head = sharedHead(before, after);
  const tail = sharedTail(before.slice(head), after.slice(head));
  const lines: DiffLine[] = [
    ...before.slice(0, head).map((line, i): DiffLine => ({ kind: 'context', text: line, old: from + i, new: from + i })),
    ...before.slice(head, before.length - tail).map((line, k): DiffLine => ({ kind: 'del', text: line, old: from + head + k })),
    ...after.slice(head, after.length - tail).map((line, k): DiffLine => ({ kind: 'add', text: line, new: from + head + k })),
    ...before.slice(before.length - tail).map((line, k): DiffLine =>
      ({ kind: 'context', text: line, old: from + before.length - tail + k, new: from + after.length - tail + k })),
  ];
  return { header: `@@ -${hunkStart(from, before.length)},${before.length} +${hunkStart(from, after.length)},${after.length} @@`, lines };
}
