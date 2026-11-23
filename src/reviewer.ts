// The template reviewer (#328): its answer's schema, its prompt and the check of its answer. Pure: the run is headless-run.ts's, the route
// server-template-review.ts's, the instructions the template-reviewer item's. Lines are whole lines, 1-based, as the editor numbers them.
// #981: a finding is a fix (the exact text to replace and its replacement) or an advice; the page imports spanAt to apply a fix.
import { z } from 'zod';
import { type AssistInput, catalogueBlock, fileLines, KIND_WORDS, numbered, parseAnswer, variablesBlock } from './assist.js';
import type { TemplateVariable } from './template.js';
import type { Severity } from './template-lint.js';
import type { ItemKind } from './types.js';

export const REVIEWER_NAME = 'template-reviewer';
export const REVIEWER_ID = `hive:${REVIEWER_NAME}`; // an item id is <origin>:<name> (item-sources.ts): the shipped plugin's specialist

export type FindingKind = 'fix' | 'advice';
interface AgentFinding { line: number; severity: Severity; title: string; body: string; source: 'agent' }
/** One problem the agent found (#328): the root design's annotation, `source` keying it apart from the lint's (4.1). #981: an advice, or a
 * fix carrying the exact text to replace (`span`, starting on `line`) and its `replacement`; parseAnnotations never yields a fix without both. */
export type AgentAnnotation = (AgentFinding & { kind: 'advice' }) | (AgentFinding & { kind: 'fix'; span: string; replacement: string });
export type AgentFix = Extract<AgentAnnotation, { kind: 'fix' }>;
export interface ReviewInput {
  instructions: string; // the reviewer's rendered body
  path: string;
  kind: ItemKind;
  text: string; // the open file as the editor shows it, saved or not
  others: readonly { path: string; text: string }[]; // the item's other files: context, never annotated
  variables: readonly TemplateVariable[];
  catalogue: AssistInput['catalogue'];
}

const SEVERITIES = ['yellow', 'red'] as const satisfies readonly Severity[];
const KINDS = ['fix', 'advice'] as const satisfies readonly FindingKind[];
const NULLABLE_STRING = { type: ['string', 'null'] } as const;

/** The answer's JSON Schema, handed to the model by both CLIs. It is a request: parseAnnotations is the guarantee. Codex's strict schemas need
 * every property required and no other, at every level, so an advice's span and replacement are null rather than absent. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' }, severity: { type: 'string', enum: SEVERITIES }, title: { type: 'string' }, body: { type: 'string' },
          kind: { type: 'string', enum: KINDS }, span: NULLABLE_STRING, replacement: NULLABLE_STRING,
        },
        required: ['line', 'severity', 'title', 'body', 'kind', 'span', 'replacement'],
        additionalProperties: false,
      },
    },
  },
  required: ['annotations'],
  additionalProperties: false,
} as const;

// zod drops a key the schema does not name. kind, span and replacement are optional here though the schema requires them: a user's own
// version of the reviewer still answers the old shape, which reads as advice (#981)
const ANSWER = z.object({
  annotations: z.array(z.object({
    line: z.number().int(), severity: z.enum(SEVERITIES), title: z.string().min(1), body: z.string().min(1),
    kind: z.enum(KINDS).optional(), span: z.string().nullish(), replacement: z.string().nullish(),
  })),
});
type Note = z.infer<typeof ANSWER>['annotations'][number];
interface Read { annotation: AgentAnnotation; demoted?: string }

const othersBlock = (others: ReviewInput['others']): string => others.map((file) => `### ${file.path}\n${file.text}`).join('\n\n') || '(none)';

/** The whole prompt, on the run's stdin: the reviewer's own instructions first, then the data they speak of. */
export function reviewPrompt(input: ReviewInput): string {
  return [
    input.instructions,
    `## File to review\n${input.path}, a ${KIND_WORDS[input.kind]}. Annotate only this file, on the line numbers below.`,
    `## Text\n${numbered(input.text)}`,
    `## Other files of the item (context only)\n${othersBlock(input.others)}`,
    `## Declared variables\n${variablesBlock(input.variables)}`,
    `## Catalogue\n${catalogueBlock(input.catalogue)}`,
  ].join('\n\n');
}

/** Where a fix's span sits (#981): the offset of its first occurrence at or after the start of `line`, when that occurrence starts on
 * `line`; undefined otherwise. Text, not columns: a model copies text reliably and miscounts columns, and a wrong column would change the
 * wrong text silently. */
export function spanAt(text: string, line: number, span: string): number | undefined {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const start = lines.slice(0, line - 1).reduce((offset, before) => offset + before.length + 1, 0);
  const at = text.indexOf(span, start);
  return at < 0 || text.slice(start, at).includes('\n') ? undefined : at;
}

// One note as the page gets it (#981): without kind fix, an advice; a fix that cannot be applied, an advice too, with why. The finding is
// still worth reading; only its fix is untrusted
function readNote({ line, severity, title, body, kind, span, replacement }: Note, text: string): Read {
  const advice: AgentAnnotation = { line, severity, title, body, source: 'agent', kind: 'advice' };
  if (kind !== 'fix') return { annotation: advice };
  const demote = (why: string): Read => ({ annotation: advice, demoted: `line ${line}: ${why}` });
  if (span === undefined || span === null || span === '') return demote('no span');
  if (replacement === undefined || replacement === null) return demote('no replacement'); // '' is a deletion, a valid fix
  if (span === replacement) return demote('the replacement is the span');
  if (spanAt(text, line, span) === undefined) return demote('the span is not on its line');
  return { annotation: { line, severity, title, body, source: 'agent', kind: 'fix', span, replacement } };
}

/** The agent's annotations, each on a line of the open text, and why each fix read as advice; or why the whole answer is refused: one line
 * outside the text means the agent misread the file, so none of its lines are trusted (decision 9). */
export function parseAnnotations(answer: string, text: string): { annotations: AgentAnnotation[]; demoted: string[] } | { reason: string } {
  const parsed = parseAnswer(answer, ANSWER);
  if ('reason' in parsed) return parsed;
  const lineCount = fileLines(text).length;
  const outside = parsed.data.annotations.find((note) => note.line < 1 || note.line > lineCount);
  if (outside !== undefined) return { reason: `line ${outside.line} is outside 1..${lineCount}` };
  const read = parsed.data.annotations.map((note) => readNote(note, text));
  return { annotations: read.map((r) => r.annotation), demoted: read.flatMap((r) => (r.demoted === undefined ? [] : [r.demoted])) };
}
