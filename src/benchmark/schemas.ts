// The shape checks of the experiment routes' bodies (#459), each typed against src/types.ts so tsc refuses a schema that drifts from it.
// Kept apart from server-benchmark.ts for the 400-line rule.
import { z } from 'zod';
import { isVersionName, safeFilePath } from '../custom-versions.js';
import { parseItemId } from '../item-sources.js';
import { COMMIT } from '../state-guards.js';
import { SCORE_MAX, SKILL_NAME } from '../stage-agent.js';
import { isFlow } from '../benchmark-guards.js';
import { AGENT_IDS, type ArmOverrides, type ArmSetup, type BenchBlindness, type BenchFlow, type BenchEvaluation, type BenchIsolation, type BenchPace, type BenchSeed, ENV_NAME, type EvaluateRow, type StageOverride } from '../types.js';
import { UPLOAD_NAME, UPLOAD_PREFIX } from './store.js';

const NAME_MAX = 120;
const MAX_PERCENT = 100;
export const NAME = z.string().trim().min(1).max(NAME_MAX);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const positive = z.number().int().positive();

const TASK = z.strictObject({ key: z.string().min(1), title: z.string(), body: z.string(), blockedBy: z.array(z.string()) });
const SETUP_FIELDS = {
  plugins: z.array(z.string().min(1)),
  rules: z.strictObject({ allow: z.array(z.string()), deny: z.array(z.string()) }), tasks: z.array(TASK),
  items: z.record(z.string().refine((id) => parseItemId(id) !== undefined, 'an item id'), z.string().refine(isVersionName, 'a version name')), worktree: z.strictObject({ setup: z.string(), teardown: z.string() }),
};
// The flow's shape is the guard's; what a patch may change of it is flowIssues', against the experiment's own copy
export const ARM_SETUP: z.ZodType<ArmSetup> = z.strictObject({ flow: z.custom<BenchFlow>(isFlow, 'a copied flow'), ...SETUP_FIELDS });

// A repo path (a file or a folder at the commit, no trailing slash) or upload:<name>
const isSeedEntry = (entry: string): boolean => (entry.startsWith(UPLOAD_PREFIX) ? UPLOAD_NAME.test(entry.slice(UPLOAD_PREFIX.length)) : safeFilePath(entry) !== undefined);
const ENTRY = z.string().refine(isSeedEntry, 'a repository path or upload:<name>');
export const SEED: z.ZodType<BenchSeed> = z.strictObject({
  workspace: z.string(), commit: z.string().regex(COMMIT), reference: z.array(ENTRY),
  sample: z.strictObject({ command: z.string(), url: z.string(), files: z.array(ENTRY) }),
  scenarios: z.array(z.strictObject({ id: z.string().min(1), title: z.string(), text: z.string() })),
});

const row = <T extends z.ZodType>(value: T) => z.strictObject({ all: value, perArm: z.record(z.string(), value).optional() });
export const ISOLATION: z.ZodType<BenchIsolation> = z.strictObject({
  environment: row(z.literal('local')), network: row(z.array(z.string())), permissionMode: row(z.string().min(1)),
  allowedTools: row(z.array(z.string())), deniedTools: row(z.array(z.string())),
  limits: row(z.strictObject({ turns: positive.optional(), ms: positive.optional() })),
  env: row(z.record(z.string().regex(ENV_NAME), z.string())), betweenRounds: row(z.literal('fresh-worktree')),
});
export const PACE: z.ZodType<BenchPace> = z.strictObject({
  pairs: positive, until: z.string().regex(HHMM).optional(), runTimeoutMs: positive, workersPerArm: positive,
  cap: z.strictObject({ tokens: positive.optional(), planPercent: z.number().min(0).max(MAX_PERCENT).optional() }),
});
export const BLINDNESS: z.ZodType<BenchBlindness> = z.strictObject({ on: z.boolean(), forbiddenWords: z.array(z.string().min(1)) });
const EVALUATE_ROW: z.ZodType<EvaluateRow> = z.strictObject({ agent: z.enum(AGENT_IDS), model: z.string().min(1).optional(), specializedAgent: z.string().min(1).optional(), focus: z.string().optional() });
// The record key refuses __proto__: z.record assigns, and that key would set the prototype
export const STAGE_OVERRIDE: z.ZodType<StageOverride> = z.strictObject({
  agent: z.enum(AGENT_IDS), model: z.string().min(1).nullable(), prompt: z.string().min(1), skill: z.string().regex(SKILL_NAME),
  commands: z.array(z.string().min(1)).min(1), judge: EVALUATE_ROW, threshold: z.number().min(0).max(SCORE_MAX),
}).partial();
export const STAGE_NAME = z.string().min(1).refine((name) => name !== '__proto__', 'a stage name');
// An arm's stage holds only the fields it sets (#462), by stage name (#536); strict, so an unknown field, or a flow, is a 400
export const ARM_OVERRIDES: z.ZodType<ArmOverrides> = z.strictObject({ ...SETUP_FIELDS, stages: z.record(STAGE_NAME, STAGE_OVERRIDE) }).partial();
export const EVALUATION: z.ZodType<BenchEvaluation> = z.strictObject({ collectors: z.array(EVALUATE_ROW), dynamic: z.boolean(), tester: EVALUATE_ROW, scenarioWalks: z.number().int().min(1), judge: EVALUATE_ROW, rubric: z.string() });

export const CREATE = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('empty'), workspace: z.string(), name: NAME.optional() }),
  z.strictObject({ kind: z.literal('duplicate'), of: z.string() }),
]);
export const PATCH = z.strictObject({
  name: NAME.optional(), archived: z.boolean().optional(), base: ARM_SETUP.optional(), seed: SEED.optional(),
  pace: PACE.optional(), isolation: ISOLATION.optional(), blindness: BLINDNESS.optional(), evaluation: EVALUATION.optional(),
});
export type PatchBody = z.infer<typeof PATCH>;
export const UPLOAD = z.strictObject({ content: z.base64() });
export const NEW_ARM = z.strictObject({ from: z.string().min(1) });
export const ARM_PATCH = z.strictObject({ name: NAME.optional(), overrides: ARM_OVERRIDES.optional() });
export const COPY = z.strictObject({ what: z.enum(['overrides', 'tasks']), to: z.array(z.string()).min(1) });
