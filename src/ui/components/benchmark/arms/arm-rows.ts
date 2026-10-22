// The arms tab's rows (#462): what one override is (a stage's agent · model, the four skills, the four prompts, plugins, items, tasks, rules,
// worktree), read from an ArmSetup, written back and told apart from the base. The only module that knows which fields a row covers.
import { mergeArm } from '../../../../benchmark/arms.js';
import { byCodePoint, canonicalJson } from '../../../../benchmark/canonical.js';
import type { AgentId, ArmOverrides, ArmSetup, BenchRules, BenchStagePick, BenchStageRole, BenchTask } from '../../../../types.js';
import { type MessageKey, t } from '@/i18n';

export const ROLES: readonly BenchStageRole[] = ['spec', 'plan', 'build', 'pr'];
export interface AgentPick { agent: AgentId; model?: string } // no model: the agent's own default
export interface RowValues {
  spec: AgentPick; plan: AgentPick; build: AgentPick; pr: AgentPick;
  skills: Record<BenchStageRole, string>; prompts: Record<BenchStageRole, string>;
  plugins: string[]; items: Record<string, string>; tasks: BenchTask[]; rules: BenchRules; worktree: ArmSetup['worktree'];
}
export type RowKey = keyof RowValues;
export const ROW_KEYS: readonly RowKey[] = ['spec', 'plan', 'build', 'pr', 'skills', 'prompts', 'plugins', 'items', 'tasks', 'rules', 'worktree'];
export interface ArmRow { key: RowKey; label: MessageKey; value: string; was?: string; overridden: boolean }
type StageOverride = NonNullable<NonNullable<ArmOverrides['stages']>[BenchStageRole]>;

const isRole = (key: RowKey): key is BenchStageRole => (ROLES as readonly string[]).includes(key);
const perRole = <T>(of: (role: BenchStageRole) => T): Record<BenchStageRole, T> => ({ spec: of('spec'), plan: of('plan'), build: of('build'), pr: of('pr') });
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const pickOf = (setup: ArmSetup, role: BenchStageRole): AgentPick => {
  const { agent, model } = setup.stages[role];
  return model === undefined ? { agent } : { agent, model };
};
const withStages = (setup: ArmSetup, change: (role: BenchStageRole, pick: BenchStagePick) => BenchStagePick): ArmSetup =>
  ({ ...setup, stages: perRole((role) => change(role, setup.stages[role])) });
// '' is the model menu's default row: the agent's own default, no model
const withPick = (role: BenchStageRole) => (setup: ArmSetup, value: AgentPick): ArmSetup => withStages(setup, (r, pick) => {
  if (r !== role) return pick;
  const { model: _model, ...rest } = pick;
  return { ...rest, agent: value.agent, ...(value.model === undefined || value.model === '' ? {} : { model: value.model }) };
});

const READ: { [K in RowKey]: (setup: ArmSetup) => RowValues[K] } = {
  spec: (s) => pickOf(s, 'spec'), plan: (s) => pickOf(s, 'plan'), build: (s) => pickOf(s, 'build'), pr: (s) => pickOf(s, 'pr'),
  skills: (s) => perRole((r) => s.stages[r].skill), prompts: (s) => perRole((r) => s.stages[r].prompt),
  plugins: (s) => s.plugins, items: (s) => s.items, tasks: (s) => s.tasks, rules: (s) => s.rules, worktree: (s) => s.worktree,
};
const WRITE: { [K in RowKey]: (setup: ArmSetup, value: RowValues[K]) => ArmSetup } = {
  spec: withPick('spec'), plan: withPick('plan'), build: withPick('build'), pr: withPick('pr'),
  skills: (s, v) => withStages(s, (r, p) => ({ ...p, skill: v[r] })), prompts: (s, v) => withStages(s, (r, p) => ({ ...p, prompt: v[r] })),
  plugins: (s, v) => ({ ...s, plugins: v }), items: (s, v) => ({ ...s, items: v }), tasks: (s, v) => ({ ...s, tasks: v }),
  rules: (s, v) => ({ ...s, rules: v }), worktree: (s, v) => ({ ...s, worktree: v }),
};
export const readRow = <K extends RowKey>(setup: ArmSetup, key: K): RowValues[K] => READ[key](setup);
export const writeRow = <K extends RowKey>(setup: ArmSetup, key: K, value: RowValues[K]): ArmSetup => WRITE[key](setup, value);

// The fields a stage changes; a model the base names and the stage lacks is the agent's own default, said as null (mergeArm drops it)
function stageDiff(base: BenchStagePick, pick: BenchStagePick): StageOverride {
  const changed = Object.fromEntries(Object.entries(pick).filter(([field, v]) => v !== undefined && base[field as keyof BenchStagePick] !== v));
  return { ...changed, ...(base.model !== undefined && pick.model === undefined ? { model: null } : {}) } as StageOverride;
}

/** What `setup` changes of `base`, and nothing else: a field equal to the base's, an empty stage and an empty `stages` are dropped. */
export function diffOverrides(base: ArmSetup, setup: ArmSetup): ArmOverrides {
  const { stages: _stages, ...rest } = setup;
  const top = Object.fromEntries(Object.entries(rest).filter(([key, v]) => !same(base[key as keyof typeof rest], v))) as Partial<Omit<ArmSetup, 'stages'>>;
  const stages = Object.fromEntries(ROLES.map((r) => [r, stageDiff(base.stages[r], setup.stages[r])] as const).filter(([, d]) => Object.keys(d).length > 0));
  return Object.keys(stages).length === 0 ? top : { ...top, stages };
}
export const setRow = <K extends RowKey>(base: ArmSetup, overrides: ArmOverrides, key: K, value: RowValues[K]): ArmOverrides =>
  diffOverrides(base, writeRow(mergeArm(base, overrides), key, value));
export const resetRow = <K extends RowKey>(base: ArmSetup, overrides: ArmOverrides, key: K): ArmOverrides => setRow(base, overrides, key, readRow(base, key));

const filled = (list: readonly string[]): string[] => list.filter((entry) => entry.trim() !== '');
/** The setup as it is posted: the blank lines a list field or a blocked-by field leaves while being typed are not entries. */
export const cleanSetup = (s: ArmSetup): ArmSetup => ({
  ...s, plugins: filled(s.plugins), rules: { allow: filled(s.rules.allow), deny: filled(s.rules.deny) },
  tasks: s.tasks.map((task) => ({ ...task, blockedBy: filled(task.blockedBy) })),
});

export const plural = (n: number, one: MessageKey, other: MessageKey): string => (n === 1 ? t(one) : t(other, { n }));
export const countText = (n: number): string => plural(n, 'benchmark.arms.count.one', 'benchmark.arms.count.other');
const tasksCount = (tasks: readonly BenchTask[]): string => plural(tasks.length, 'benchmark.arms.value.tasks.one', 'benchmark.arms.value.tasks.other');
const tasksText = (tasks: readonly BenchTask[]): string =>
  `${tasksCount(tasks)} · ${plural(tasks.reduce((n, task) => n + task.blockedBy.length, 0), 'benchmark.arms.value.blockers.one', 'benchmark.arms.value.blockers.other')}`;
const pickText = (pick: BenchStagePick): string => (pick.model === undefined ? pick.agent : `${pick.agent} · ${pick.model}`);
const folderName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;
const lineCount = (text: string): number => text.split('\n').filter((line) => line.trim() !== '').length;

// The plugins the shown setup adds and removes against the other one, as the screen's `+ superpowers, ecc`
function pluginsText(shown: ArmSetup, other: ArmSetup): string {
  const added = shown.plugins.filter((p) => !other.plugins.includes(p)).map(folderName);
  const removed = other.plugins.filter((p) => !shown.plugins.includes(p)).map(folderName);
  const parts = [...(added.length > 0 ? [`+ ${added.join(', ')}`] : []), ...(removed.length > 0 ? [`− ${removed.join(', ')}`] : [])];
  return parts.join(' · ') || shown.plugins.map(folderName).join(', '); // the same plugins reordered: the list itself
}
// The stages whose prompt differs from the other setup's, each with its first line
const promptsText = (shown: ArmSetup, other: ArmSetup): string =>
  ROLES.filter((r) => shown.stages[r].prompt !== other.stages[r].prompt).map((r) => `${r}: ${shown.stages[r].prompt.split('\n')[0]}`).join(' · ');
function itemsText(items: Readonly<Record<string, string>>): string {
  const entries = Object.entries(items).sort(([a], [b]) => byCodePoint(a, b));
  return entries.length === 0 ? t('benchmark.arms.value.itemsOriginal') : entries.map(([id, version]) => `${id} → ${version}`).join(', ');
}

// was: null draws no struck base value (skills, plugins, as the screen); absent, the base shown against the arm
interface RowFormat { label: MessageKey; show(shown: ArmSetup, other: ArmSetup): string; was?: ((base: ArmSetup, arm: ArmSetup) => string) | null }
const stageFormat = (role: BenchStageRole): RowFormat => ({ label: `benchmark.arms.row.${role}`, show: (s) => pickText(s.stages[role]) });
const FORMAT: Record<RowKey, RowFormat> = {
  spec: stageFormat('spec'), plan: stageFormat('plan'), build: stageFormat('build'), pr: stageFormat('pr'),
  skills: { label: 'benchmark.arms.row.skills', show: (s) => ROLES.map((r) => s.stages[r].skill).join(' '), was: null },
  prompts: { label: 'benchmark.arms.row.prompts', show: promptsText },
  plugins: { label: 'benchmark.arms.row.plugins', show: pluginsText, was: null },
  items: { label: 'benchmark.arms.row.items', show: (s) => itemsText(s.items) },
  tasks: { label: 'benchmark.arms.row.tasks', show: (s) => tasksText(s.tasks), was: (b) => t('benchmark.arms.value.tasksOfBase', { tasks: tasksCount(b.tasks) }) },
  rules: { label: 'benchmark.arms.row.rules', show: (s) => t('benchmark.arms.value.rules', { allowed: s.rules.allow.length, denied: s.rules.deny.join(', ') || '0' }) },
  worktree: { label: 'benchmark.arms.row.worktree', show: (s) => t('benchmark.arms.value.worktree', { setup: lineCount(s.worktree.setup), teardown: lineCount(s.worktree.teardown) }) },
};
export const rowLabel = (key: RowKey): MessageKey => FORMAT[key].label;
export const rowText = (setup: ArmSetup, key: RowKey): string => FORMAT[key].show(setup, setup);

/** Every row of the arm, overridden when its merged value differs from the base's (canonical JSON). */
export function armRows(base: ArmSetup, overrides: ArmOverrides): ArmRow[] {
  const arm = mergeArm(base, overrides);
  return ROW_KEYS.map((key) => {
    const format = FORMAT[key];
    const was = format.was === null ? undefined : (format.was ?? ((b: ArmSetup, a: ArmSetup) => format.show(b, a)))(base, arm);
    return { key, label: format.label, value: format.show(arm, base), ...(was === undefined ? {} : { was }), overridden: !same(readRow(arm, key), readRow(base, key)) };
  });
}

/** The card's footer (decided with the user): the rows the arm leaves as the base has them, the four stages as `agentes` when none differs
 *  (the screen's A and D); the pinned plugin and the seed are not rows. */
export function sameRows(rows: readonly ArmRow[]): string {
  const kept = rows.filter((r) => !r.overridden);
  if (kept.length === rows.length) return t('benchmark.arms.footer.all');
  if (kept.length === 0) return t('benchmark.arms.footer.none');
  const isEveryStage = ROLES.every((role) => kept.some((r) => r.key === role));
  const labels = [...(isEveryStage ? [t('benchmark.arms.row.agents')] : []), ...kept.filter((r) => !(isEveryStage && isRole(r.key))).map((r) => t(r.label))];
  return t('benchmark.arms.footer.same', { rows: labels.join(', ') });
}
