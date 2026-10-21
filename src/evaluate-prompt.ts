import { z } from 'zod';
import { parseAnswer } from './assist.js';
import type { JudgeScore, ReviewFinding } from './types.js';

// What an evaluate stage's reviewers and judge are told and answer (#877): the prompts, the answers' JSON Schemas, their zod checks and the
// patch's cut. Pure. The schemas name every property as required with no extra one and no numeric bound, the shape Codex's strict output schema
// takes; zod holds the bounds.

/** The most of the patch a prompt carries (#877, decision 14), in characters; the agents read the files for the rest. */
export const PATCH_MAX = 60_000; // ponytail: fixed; a stage setting if a large diff ever needs more of it

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: ['integer', 'null'] }, finding: { type: 'string' } }, required: ['file', 'line', 'finding'], additionalProperties: false } } },
  required: ['findings'], additionalProperties: false,
} as const;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: { scores: { type: 'array', items: { type: 'object', properties: { dimension: { type: 'string' }, score: { type: 'integer' }, evidence: { type: 'string' } }, required: ['dimension', 'score', 'evidence'], additionalProperties: false } } },
  required: ['scores'], additionalProperties: false,
} as const;

const FINDINGS = z.object({ findings: z.array(z.object({ file: z.string().min(1), line: z.number().int().positive().nullable(), finding: z.string().min(1) })) });
const SCORES = z.object({ scores: z.array(z.object({ dimension: z.string(), score: z.number().int().min(0).max(10), evidence: z.string().min(1) })) });

export const cutPatch = (patch: string): string =>
  (patch.length <= PATCH_MAX ? patch : `${patch.slice(0, PATCH_MAX)}\n[patch cut at ${PATCH_MAX} characters: read the files for the rest]`);

/** The task and its changes as every run reads them (#877): the item's title and body, the base, the stat and the patch, already cut. */
export interface Work { id: string; title: string; body: string; base: string; stat: string; patch: string }

const workText = (w: Work): string =>
  [`Task ${w.id}: ${w.title}`, w.body, `Changes against ${w.base}:`, w.stat, w.patch].filter((part) => part.trim() !== '').join('\n\n');
const withInstructions = (instructions: string | undefined, text: string): string => (instructions === undefined ? text : `${instructions}\n\n${text}`);

/** A reviewer's prompt (#877): its specialized agent's body first, then the read-only frame, its focus and the work. */
export function reviewerPrompt(work: Work, focus: string, instructions?: string): string {
  return withInstructions(instructions, [
    'You review the work of a task in the repository at your current folder. Read any file you need; you cannot change anything.',
    `Your focus: ${focus}`, workText(work),
    'List every finding with its evidence: the file, the line when there is one, and what is wrong or missing. No finding: an empty list.',
  ].join('\n\n'));
}

const findingText = (f: ReviewFinding): string => `- ${f.file}${f.line === undefined ? '' : `:${f.line}`} ${f.finding}`;

/** The judge's prompt (#877): the dimensions numbered in the rubric's order, every reviewer's findings, then the work. */
export function judgePrompt(work: Work, dimensions: readonly string[], findings: readonly { who: string; findings: ReviewFinding[] }[], instructions?: string): string {
  const read = findings.length === 0 ? 'No reviewer ran: read the work yourself.' : findings.map((r) => [r.who, ...(r.findings.length === 0 ? ['- no finding'] : r.findings.map(findingText))].join('\n')).join('\n\n');
  return withInstructions(instructions, [
    'You judge the work of a task in the repository at your current folder against a rubric. Read any file you need; you cannot change anything.',
    `The rubric, one dimension per line:\n${dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
    `The reviewers' findings:\n\n${read}`, workText(work),
    `Give exactly ${dimensions.length} scores, one per dimension in this order: an integer from 0 to 10 and the evidence for it (files and lines).`,
  ].join('\n\n'));
}

export function parseFindings(answer: string): { findings: ReviewFinding[] } | { reason: string } {
  const parsed = parseAnswer(answer, FINDINGS);
  if ('reason' in parsed) return parsed;
  return { findings: parsed.data.findings.map(({ file, line, finding }) => ({ file, ...(line === null ? {} : { line }), finding })) };
}

/** The judge's scores (#877, decision 4): one per dimension, each named by the rubric's rendered line, never by the judge's own words. */
export function parseScores(answer: string, dimensions: readonly string[]): { scores: JudgeScore[] } | { reason: string } {
  const parsed = parseAnswer(answer, SCORES);
  if ('reason' in parsed) return parsed;
  const { scores } = parsed.data;
  if (scores.length !== dimensions.length) return { reason: `${scores.length} scores for ${dimensions.length} dimensions` };
  return { scores: scores.map((s, i) => ({ dimension: dimensions[i] ?? s.dimension, score: s.score, evidence: s.evidence })) };
}
