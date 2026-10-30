// The arms tab's rows (#462, #536): one per stage of the copied flow, by name, then plugins, items, tasks, the two rules lists and the
// worktree; read from an ArmSetup, written back and told apart from the base. The only module that knows which fields a row covers.
import { mergeArm, STAGE_OVERRIDE_FIELDS, stageCall } from '../../../../benchmark/arms.js';
import { byCodePoint, canonicalJson } from '../../../../benchmark/canonical.js';
import { runsAgent } from '../../../../stage-agent.js';
import { type ArmOverrides, type ArmSetup, type BenchFlow, type BenchStage, type BenchTask, DEFAULT_AGENT, type StageOverride } from '../../../../types.js';
import { type MessageKey, t } from '@/i18n';
import { executorLine } from '@/lib/flow-labels';

export type StageKey = `stage:${string}`;
export type FixedKey = 'flow' | 'plugins' | 'items' | 'tasks' | 'rules.allow' | 'rules.deny' | 'worktree';
export type RowKey = FixedKey | StageKey;
export interface FixedValues {
  flow: BenchFlow; plugins: string[]; items: Record<string, string>; tasks: BenchTask[]; 'rules.allow': string[]; 'rules.deny': string[]; worktree: ArmSetup['worktree'];
}
export interface ArmRow { key: RowKey; label: string; value: string; was?: string; overridden: boolean }

const STAGE_PREFIX = 'stage:';
const FIXED_ROWS: readonly Exclude<FixedKey, 'flow'>[] = ['plugins', 'items', 'tasks', 'rules.allow', 'rules.deny', 'worktree'];
const NONE = '—';

export const stageKey = (name: string): StageKey => `${STAGE_PREFIX}${name}`;
export const isStageKey = (key: RowKey): key is StageKey => key.startsWith(STAGE_PREFIX);
export const stageNameOf = (key: StageKey): string => key.slice(STAGE_PREFIX.length);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Every row of a setup: each stage in flow order, then the fixed ones; the flow itself is the base's alone, never a row of an arm. */
export const armRowKeys = (setup: ArmSetup): RowKey[] => [...setup.flow.stages.map((s) => stageKey(s.name)), ...FIXED_ROWS];

const READ: { [K in FixedKey]: (setup: ArmSetup) => FixedValues[K] } = {
  flow: (s) => s.flow, plugins: (s) => s.plugins, items: (s) => s.items, tasks: (s) => s.tasks,
  'rules.allow': (s) => s.rules.allow, 'rules.deny': (s) => s.rules.deny, worktree: (s) => s.worktree,
};
const WRITE: { [K in FixedKey]: (setup: ArmSetup, value: FixedValues[K]) => ArmSetup } = {
  flow: (s, v) => ({ ...s, flow: v }), plugins: (s, v) => ({ ...s, plugins: v }), items: (s, v) => ({ ...s, items: v }), tasks: (s, v) => ({ ...s, tasks: v }),
  'rules.allow': (s, v) => ({ ...s, rules: { ...s.rules, allow: v } }), 'rules.deny': (s, v) => ({ ...s, rules: { ...s.rules, deny: v } }),
  worktree: (s, v) => ({ ...s, worktree: v }),
};
export const readRow = <K extends FixedKey>(setup: ArmSetup, key: K): FixedValues[K] => READ[key](setup);
export const writeRow = <K extends FixedKey>(setup: ArmSetup, key: K, value: FixedValues[K]): ArmSetup => WRITE[key](setup, value);

/** A stage of the setup's flow by name; rows are built from that flow, so a name it lacks is a caller's bug. */
export function readStage(setup: ArmSetup, name: string): BenchStage {
  const stage = setup.flow.stages.find((s) => s.name === name);
  if (stage === undefined) throw new Error(`no stage ${name} in the flow`);
  return stage;
}
export const writeStage = (setup: ArmSetup, stage: BenchStage): ArmSetup =>
  ({ ...setup, flow: { ...setup.flow, stages: setup.flow.stages.map((s) => (s.name === stage.name ? stage : s)) } });

// The override fields a stage changes; a model the base names and the stage lacks is the agent's own default, said as null (mergeArm drops it)
function stageDiff(base: BenchStage, stage: BenchStage): StageOverride {
  const changed = STAGE_OVERRIDE_FIELDS.flatMap((field): [string, unknown][] => {
    if (field !== 'model') return stage[field] !== undefined && !same(stage[field], base[field]) ? [[field, stage[field]]] : [];
    if (base.model !== undefined && stage.model === undefined) return [[field, null]];
    return stage.model !== undefined && stage.model !== base.model ? [[field, stage.model]] : [];
  });
  return Object.fromEntries(changed) as StageOverride;
}

/** What `setup` changes of `base`, and nothing else: a field equal to the base's, an empty stage and an empty `stages` are dropped. */
export function diffOverrides(base: ArmSetup, setup: ArmSetup): ArmOverrides {
  const { flow, ...rest } = setup;
  const top = Object.fromEntries(Object.entries(rest).filter(([key, v]) => !same(base[key as keyof typeof rest], v))) as Partial<Omit<ArmSetup, 'flow'>>;
  const stages = Object.fromEntries(base.flow.stages.flatMap((b) => {
    const shown = flow.stages.find((s) => s.name === b.name);
    const diff = shown === undefined ? {} : stageDiff(b, shown);
    return Object.keys(diff).length === 0 ? [] : [[b.name, diff] as const];
  }));
  return Object.keys(stages).length === 0 ? top : { ...top, stages };
}
export const setRow = <K extends FixedKey>(base: ArmSetup, overrides: ArmOverrides, key: K, value: FixedValues[K]): ArmOverrides =>
  diffOverrides(base, writeRow(mergeArm(base, overrides), key, value));
export const setStage = (base: ArmSetup, overrides: ArmOverrides, stage: BenchStage): ArmOverrides => diffOverrides(base, writeStage(mergeArm(base, overrides), stage));
export function resetRow(base: ArmSetup, overrides: ArmOverrides, key: RowKey): ArmOverrides {
  return isStageKey(key) ? setStage(base, overrides, readStage(base, stageNameOf(key))) : setRow(base, overrides, key, readRow(base, key));
}

const filled = (list: readonly string[]): string[] => list.filter((entry) => entry.trim() !== '');
/** The setup as it is posted: the blank lines a list field or a blocked-by field leaves while being typed are not entries. */
export const cleanSetup = (s: ArmSetup): ArmSetup => ({
  ...s, plugins: filled(s.plugins), rules: { allow: filled(s.rules.allow), deny: filled(s.rules.deny) },
  tasks: s.tasks.map((task) => ({ ...task, blockedBy: filled(task.blockedBy) })),
});

export const plural = (n: number, one: MessageKey, other: MessageKey): string => (n === 1 ? t(one) : t(other, { n }));
export const countText = (n: number): string => plural(n, 'benchmark.arms.count.one', 'benchmark.arms.count.other');
const tasksCount = (tasks: readonly BenchTask[]): string => plural(tasks.length, 'benchmark.arms.value.tasks.one', 'benchmark.arms.value.tasks.other');
export const tasksText = (tasks: readonly BenchTask[]): string =>
  `${tasksCount(tasks)} · ${plural(tasks.reduce((n, task) => n + task.blockedBy.length, 0), 'benchmark.arms.value.blockers.one', 'benchmark.arms.value.blockers.other')}`;
export const pickText = (agent: string | undefined, model: string | undefined): string => [agent ?? DEFAULT_AGENT, ...(model === undefined ? [] : [model])].join(' · ');
const folderName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;
const lineCount = (text: string): number => text.split('\n').filter((line) => line.trim() !== '').length;
const listText = (list: readonly string[]): string => (list.length === 0 ? NONE : list.join(', '));

/** A stage as one line against another (#536): an agent stage's agent · model, or its call when only its prompt or skill differs; an
 *  evaluation's judge and threshold; a commands stage's commands; any other its executor line. */
export function stageText(shown: BenchStage, other: BenchStage): string {
  if (runsAgent(shown)) {
    const isPickSame = shown.agent === other.agent && shown.model === other.model;
    const isCallChanged = shown.prompt !== other.prompt || shown.skill !== other.skill;
    if (isPickSame && isCallChanged) return stageCall(shown) ?? (shown.prompt ?? '').split('\n')[0];
    return pickText(shown.agent, shown.model);
  }
  if (shown.action === 'evaluate') return t('benchmark.arms.value.judge', { who: pickText(shown.judge?.agent, shown.judge?.model), n: shown.threshold ?? '' });
  if (shown.action === 'commands') return listText(shown.commands ?? []);
  return executorLine({ ...shown, from: {} });
}

// The plugins the shown setup adds and removes against the other one, as the screen's `+ superpowers, ecc`
function pluginsText(shown: ArmSetup, other: ArmSetup): string {
  const added = shown.plugins.filter((p) => !other.plugins.includes(p)).map(folderName);
  const removed = other.plugins.filter((p) => !shown.plugins.includes(p)).map(folderName);
  const parts = [...(added.length > 0 ? [`+ ${added.join(', ')}`] : []), ...(removed.length > 0 ? [`− ${removed.join(', ')}`] : [])];
  return parts.join(' · ') || shown.plugins.map(folderName).join(', '); // the same plugins reordered: the list itself
}
function itemsText(items: Readonly<Record<string, string>>): string {
  const entries = Object.entries(items).sort(([a], [b]) => byCodePoint(a, b));
  return entries.length === 0 ? t('benchmark.arms.value.itemsOriginal') : entries.map(([id, version]) => `${id} → ${version}`).join(', ');
}

// was: null draws no struck base value (plugins, as the screen); absent, the base shown against the arm
interface RowFormat { label: MessageKey; show(shown: ArmSetup, other: ArmSetup): string; was?: ((base: ArmSetup, arm: ArmSetup) => string) | null }
const FORMAT: Record<Exclude<FixedKey, 'flow'>, RowFormat> = {
  plugins: { label: 'benchmark.arms.row.plugins', show: pluginsText, was: null },
  items: { label: 'benchmark.arms.row.items', show: (s) => itemsText(s.items) },
  tasks: { label: 'benchmark.arms.row.tasks', show: (s) => tasksText(s.tasks), was: (b) => t('benchmark.arms.value.tasksOfBase', { tasks: tasksCount(b.tasks) }) },
  'rules.allow': { label: 'benchmark.arms.row.allow', show: (s) => listText(s.rules.allow) },
  'rules.deny': { label: 'benchmark.arms.row.deny', show: (s) => listText(s.rules.deny) },
  worktree: { label: 'benchmark.arms.row.worktree', show: (s) => t('benchmark.arms.value.worktree', { setup: lineCount(s.worktree.setup), teardown: lineCount(s.worktree.teardown) }) },
};
/** A row's label: a stage's own name, or the fixed row's translated one. */
export const rowLabel = (key: RowKey): string => (isStageKey(key) ? stageNameOf(key) : key === 'flow' ? t('benchmark.arms.row.flow') : t(FORMAT[key].label));
export const rowText = (setup: ArmSetup, key: Exclude<FixedKey, 'flow'>): string => FORMAT[key].show(setup, setup);

function stageRow(base: ArmSetup, arm: ArmSetup, key: StageKey): ArmRow {
  const name = stageNameOf(key);
  const [shown, was] = [readStage(arm, name), readStage(base, name)];
  return { key, label: name, value: stageText(shown, was), was: stageText(was, shown), overridden: !same(shown, was) };
}

/** Every row of the arm, overridden when its merged value differs from the base's (canonical JSON). */
export function armRows(base: ArmSetup, overrides: ArmOverrides): ArmRow[] {
  const arm = mergeArm(base, overrides);
  return armRowKeys(base).map((key) => {
    if (isStageKey(key)) return stageRow(base, arm, key);
    const format = FORMAT[key as Exclude<FixedKey, 'flow'>];
    const was = format.was === null ? undefined : (format.was ?? ((b: ArmSetup, a: ArmSetup) => format.show(b, a)))(base, arm);
    return { key, label: t(format.label), value: format.show(arm, base), ...(was === undefined ? {} : { was }), overridden: !same(readRow(arm, key as FixedKey), readRow(base, key as FixedKey)) };
  });
}

/** The card's footer (decided with the user): the rows the arm leaves as the base has them, every stage as `etapas` when none differs and the
 *  two rules lists as `regras` when both are kept; the pinned plugin and the seed are not rows. */
export function sameRows(rows: readonly ArmRow[]): string {
  const kept = rows.filter((r) => !r.overridden);
  if (kept.length === rows.length) return t('benchmark.arms.footer.all');
  if (kept.length === 0) return t('benchmark.arms.footer.none');
  const stages = rows.filter((r) => isStageKey(r.key));
  const keptStages = kept.filter((r) => isStageKey(r.key));
  const isEveryStage = keptStages.length === stages.length;
  const isBothRules = kept.some((r) => r.key === 'rules.allow') && kept.some((r) => r.key === 'rules.deny');
  const labels = [
    ...(isEveryStage ? [t('benchmark.arms.row.stages')] : keptStages.map((r) => r.label)),
    ...kept.filter((r) => !isStageKey(r.key)).flatMap((r) => {
      if (!isBothRules || (r.key !== 'rules.allow' && r.key !== 'rules.deny')) return [r.label];
      return r.key === 'rules.allow' ? [t('benchmark.arms.row.rules')] : [];
    }),
  ];
  return t('benchmark.arms.footer.same', { rows: labels.join(', ') });
}
