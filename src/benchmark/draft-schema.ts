// benchmark_draft's input (#478): every field optional, each section checked by the routes' own schema, and the pure composition over a start.
// Kept apart from drafts.ts, which writes, and from schemas.ts, whose bodies are the routes'.
import { z } from 'zod';
import type { Arm, BenchIsolation, Experiment } from '../types.js';
import { LETTERS } from './arms.js';
import { ARM_OVERRIDES, ARM_SETUP, BLINDNESS, EVALUATION, ISOLATION, NAME, PACE, SEED } from './schemas.js';

const DRAFT_ARM = z.strictObject({ id: z.string().min(1).optional(), name: NAME, overrides: ARM_OVERRIDES });
const hasUniqueIds = (arms: readonly { id?: string }[]): boolean => {
  const ids = arms.flatMap((a) => (a.id === undefined ? [] : [a.id]));
  return new Set(ids).size === ids.length;
};

export const DRAFT = z.strictObject({
  id: z.string().min(1).optional(), from: z.string().min(1).optional(), workspace: z.string().min(1).optional(), name: NAME.optional(),
  base: ARM_SETUP.optional(), arms: z.array(DRAFT_ARM).min(1).max(LETTERS.length).refine(hasUniqueIds, 'an arm id appears twice').optional(),
  seed: SEED.optional(), pace: PACE.optional(), isolation: ISOLATION.optional(), blindness: BLINDNESS.optional(), evaluation: EVALUATION.optional(),
})
  .refine((d) => d.id === undefined || (d.from === undefined && d.workspace === undefined), { path: ['id'], message: 'a replace takes neither from nor workspace' })
  .refine((d) => d.id !== undefined || d.from !== undefined || d.workspace !== undefined, { path: ['workspace'], message: 'a new draft needs from or workspace' });
export type DraftInput = z.infer<typeof DRAFT>;

/** Every issue, so the agent fixes them all in one turn. */
export const zodIssues = (error: z.ZodError): string[] => error.issues.map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`);

// The arm list in the given order: a start's id is kept, none draws one against every id already taken, letters again from A
function draftArms(start: readonly Arm[], given: NonNullable<DraftInput['arms']>, newArmId: (taken: readonly string[]) => string): Arm[] {
  const made: Arm[] = [];
  given.forEach((a, i) => {
    const id = a.id ?? newArmId([...start.map((s) => s.id), ...made.map((m) => m.id)]);
    made.push({ id, letter: LETTERS[i], name: a.name, overrides: a.overrides });
  });
  return made;
}

export function composeDraft(start: Experiment, input: DraftInput, newArmId: (taken: readonly string[]) => string): Experiment | string[] {
  const { id: _id, from: _from, workspace: _workspace, arms, ...sections } = input;
  const unknown = (arms ?? []).flatMap((a, i) => (a.id === undefined || start.arms.some((s) => s.id === a.id) ? [] : [`arms.${i}.id: no arm ${a.id} in the experiment`]));
  if (unknown.length > 0) return unknown;
  return { ...start, ...sections, arms: arms === undefined ? start.arms : draftArms(start.arms, arms, newArmId) };
}

const ISOLATION_ROWS = ['environment', 'network', 'permissionMode', 'allowedTools', 'deniedTools', 'limits', 'env', 'betweenRounds'] as const satisfies readonly (keyof BenchIsolation)[];
const RESULT = z.object({ base: ARM_SETUP, arms: z.array(z.object({ overrides: ARM_OVERRIDES })).min(1), seed: SEED, pace: PACE, isolation: ISOLATION, blindness: BLINDNESS, evaluation: EVALUATION });

/** The whole result as the routes would accept it, plus the arm-id rule the isolation rows' perArm keys follow. */
export function resultIssues(experiment: Experiment): string[] {
  const parsed = RESULT.safeParse(experiment);
  const ids = experiment.arms.map((a) => a.id);
  const perArm = ISOLATION_ROWS.flatMap((row) => Object.keys(experiment.isolation[row].perArm ?? {}).filter((key) => !ids.includes(key)).map((key) => `isolation.${row}.perArm: ${key} is no arm of the draft`));
  const seed = experiment.seed.workspace === experiment.workspace ? [] : ['seed.workspace: an experiment keeps the workspace it was created in'];
  return [...(parsed.success ? [] : zodIssues(parsed.error)), ...perArm, ...seed];
}
