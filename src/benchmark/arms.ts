// The arm routes' rules (#459), pure: which letter a new arm takes, what it copies, and the 404 / 409 an arm route answers. A 27th arm is
// not a real case, so the letters stop at Z.
import { commandFirst } from '../stage-agent.js';
import type { Arm, ArmOverrides, ArmSetup, BenchStage, BenchStagePick, BenchStageRole, Experiment, StageOverride as BenchStageOverride } from '../types.js';

/** The fields a stage override may hold (#536), mergeArm's, the dialog's diff's and flowIssues' one list. */
export const STAGE_OVERRIDE_FIELDS = ['agent', 'model', 'prompt', 'skill', 'commands', 'judge', 'threshold'] as const satisfies readonly (keyof BenchStageOverride)[];

/** The call a stage makes (#536, generalised from #459's per role): a skill stage's /hive:<skill>; a prompt stage's opening slash command
 *  (commandFirst), else the first /hive:<name> or /hive-<name> its prompt holds. Undefined for a stage that runs no agent. */
export function stageCall(stage: Pick<BenchStage, 'action' | 'prompt' | 'skill'>): string | undefined {
  if (stage.action === 'skill') return stage.skill === undefined ? undefined : `/hive:${stage.skill}`;
  if (stage.action !== undefined) return undefined;
  return commandFirst(stage.prompt ?? '')?.command.split(/\s/)[0] ?? stage.prompt?.match(/\/hive(?::|-)[\w-]+/)?.[0];
}

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

export interface ArmRefusal { status: 404 | 409; error: 'unknown_arm' | 'last_arm' | 'no_letter'; message: string }
export const isArmRefusal = (value: Arm | ArmRefusal): value is ArmRefusal => 'status' in value;
const unknownArm = (armId: string): ArmRefusal => ({ status: HTTP_NOT_FOUND, error: 'unknown_arm', message: `no arm ${armId}` });

// A running round reads the config: a change mid-round would make the runs of one pair differ
export const isLocked = (experiment: Experiment): boolean => experiment.status === 'running' || experiment.status === 'sleeping';

export const nextLetter = (arms: readonly Arm[]): string | undefined => [...LETTERS].find((letter) => !arms.some((a) => a.letter === letter));
export const armName = (letter: string): string => `Arm ${letter}`;

export function checkArm(experiment: Experiment, armId: string): Arm | ArmRefusal {
  return experiment.arms.find((a) => a.id === armId) ?? unknownArm(armId);
}

/** A new arm from the base (no overrides) or from another arm (its overrides, tasks included), on the next free letter. */
export function armFrom(experiment: Experiment, from: string, id: string): Arm | ArmRefusal {
  const source = from === 'base' ? undefined : checkArm(experiment, from);
  if (source !== undefined && isArmRefusal(source)) return source;
  const letter = nextLetter(experiment.arms);
  if (letter === undefined) return { status: HTTP_CONFLICT, error: 'no_letter', message: 'an experiment holds at most 26 arms' };
  return { id, letter, name: armName(letter), overrides: source?.overrides ?? {} };
}

export function checkRemove(experiment: Experiment, armId: string): ArmRefusal | undefined {
  const found = checkArm(experiment, armId);
  if (isArmRefusal(found)) return found;
  return experiment.arms.length === 1 ? { status: HTTP_CONFLICT, error: 'last_arm', message: 'an experiment keeps at least one arm' } : undefined;
}

export function checkTargets(experiment: Experiment, to: readonly string[]): ArmRefusal | undefined {
  const missing = to.find((armId) => !experiment.arms.some((a) => a.id === armId));
  return missing === undefined ? undefined : unknownArm(missing);
}

// ponytail: the per-role shape of #462; Task 12 replaces it with types.ts StageOverride
type StageOverride = NonNullable<NonNullable<ArmOverrides['stages']>[BenchStageRole]>;

/** An arm's setup (#462): each stage field the arm sets over the base's same field, every other key whole. An arm that changes build's agent
 *  still follows a later base edit of spec, of build's model, or of any field it never set. A null model is the agent's own default: the
 *  merged pick has none. Pure, so the dashboard merges as the runs do. */
export function mergeArm(base: ArmSetup, overrides: ArmOverrides): ArmSetup {
  const { stages, ...rest } = overrides;
  const pick = (role: BenchStageRole): BenchStagePick => {
    const { model, ...fields }: StageOverride = stages?.[role] ?? {};
    const { model: baseModel, ...kept } = { ...base.stages[role], ...fields };
    const merged = model === null ? undefined : (model ?? baseModel);
    return merged === undefined ? kept : { ...kept, model: merged };
  };
  return { ...base, ...rest, stages: { spec: pick('spec'), plan: pick('plan'), build: pick('build'), pr: pick('pr') } };
}
