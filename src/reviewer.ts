// The template reviewer (#328): its answer's schema, its prompt and the check of its answer. Pure: the run is headless-run.ts's, the route
// server-template-review.ts's, the instructions the template-reviewer item's. Lines are whole lines, 1-based, as the editor numbers them.
import { z } from 'zod';
import { type AssistInput, catalogueBlock, KIND_WORDS, numbered, parseAnswer, variablesBlock } from './assist.js';
import type { TemplateVariable } from './template.js';
import type { Severity } from './template-lint.js';
import type { ItemKind } from './types.js';

export const REVIEWER_NAME = 'template-reviewer';
export const REVIEWER_ID = `hive:${REVIEWER_NAME}`; // an item id is <origin>:<name> (item-sources.ts): the shipped plugin's specialist

/** One problem the agent found (#328): the root design's annotation, `source` keying it apart from the lint's (4.1). No fix: rewriting is #330's. */
export interface AgentAnnotation { line: number; severity: Severity; title: string; body: string; source: 'agent' }
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

/** The answer's JSON Schema, handed to the model by both CLIs. It is a request: parseAnnotations is the guarantee. Codex's strict schemas need
 * every property required and no other, at every level. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { line: { type: 'integer' }, severity: { type: 'string', enum: SEVERITIES }, title: { type: 'string' }, body: { type: 'string' } },
        required: ['line', 'severity', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['annotations'],
  additionalProperties: false,
} as const;

// zod drops a key the schema does not name, so a fix the agent adds anyway never reaches the page
const ANSWER = z.object({
  annotations: z.array(z.object({ line: z.number().int(), severity: z.enum(SEVERITIES), title: z.string().min(1), body: z.string().min(1) })),
});

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

/** The agent's annotations, each on a line of the open text, or why the whole answer is refused: one line outside the text means the agent
 * misread the file, so none of its lines are trusted (decision 9). */
export function parseAnnotations(answer: string, lineCount: number): { annotations: AgentAnnotation[] } | { reason: string } {
  const parsed = parseAnswer(answer, ANSWER);
  if ('reason' in parsed) return parsed;
  const outside = parsed.data.annotations.find((note) => note.line < 1 || note.line > lineCount);
  if (outside !== undefined) return { reason: `line ${outside.line} is outside 1..${lineCount}` };
  return { annotations: parsed.data.annotations.map((note): AgentAnnotation => ({ ...note, source: 'agent' })) };
}
