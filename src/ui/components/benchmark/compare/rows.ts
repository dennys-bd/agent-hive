// The compare tab's pure parts (#464): every arm's effective setup set against the base, row by row, and the overrides a copy posts. No React,
// tested without rendering.
import type { Arm, ArmOverrides, ArmSetup, BenchIsolation, BenchStagePick, BenchStageRole, Experiment } from '../../../../types';
import { isLocked, mergeArm } from '../../../../benchmark/arms';
import { diffOverrides } from '@/components/benchmark/arms/arm-rows';
import { t, tPlural } from '@/i18n';

export type SetupRowId =
  | `${BenchStageRole}.prompt` | `${BenchStageRole}.agent` | 'plugins' | 'rules.allow' | 'rules.deny' | 'items' | 'worktree.setup' | 'worktree.teardown' | 'tasks';
export type RowId = SetupRowId | `isolation.${keyof BenchIsolation}`;
/** One arm's cell: its rendered value, whether it equals the base's, and whether a click may copy it to another arm. */
export interface CompareCell { armId: string; value: string; isSame: boolean; isCopyable: boolean }
export interface CompareRow { id: RowId; label: string; base: string; cells: CompareCell[] }

// One setup row: its label, the value the cells compare (deep), the text a cell shows, and the setup `to` becomes with this row's value from `from`
interface SetupRow { id: SetupRowId; label(): string; valueOf(setup: ArmSetup): unknown; text(setup: ArmSetup): string; copy(from: ArmSetup, to: ArmSetup): ArmSetup }

const STAGES: readonly BenchStageRole[] = ['spec', 'plan', 'build', 'pr'];
const NONE = '—';
const HASH_CHARS = 4;

/** Deep equality on the state's JSON values, key order ignored: two records built in another order hold the same value. */
export function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && isSameValue(left[key], right[key]));
}

const listText = (values: readonly string[]): string => (values.length === 0 ? NONE : values.join(', '));
const blankText = (value: string): string => (value.trim() === '' ? NONE : value);
const agentText = (pick: BenchStagePick): string => (pick.model === undefined ? pick.agent : `${pick.agent} · ${pick.model}`);
// Sorted by item id, so the text does not depend on the order the record was built in
const itemsText = ({ items }: ArmSetup): string =>
  listText(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)).map(([item, version]) => `${item}@${version}`));
function tasksText({ tasks }: ArmSetup): string {
  const blockers = tasks.reduce((sum, task) => sum + task.blockedBy.length, 0);
  return tPlural('benchmark.compare.tasks', blockers, { n: tasks.length, k: blockers });
}

const withPick = (setup: ArmSetup, stage: BenchStageRole, pick: BenchStagePick): ArmSetup => ({ ...setup, stages: { ...setup.stages, [stage]: pick } });
// The source's agent and model on the target's pick, with no model key when the source has none, so the pick can equal a base pick without one
const withAgent = (to: BenchStagePick, from: BenchStagePick): BenchStagePick =>
  ({ agent: from.agent, ...(from.model === undefined ? {} : { model: from.model }), skill: to.skill, prompt: to.prompt });

const stageRows = (stage: BenchStageRole): SetupRow[] => [
  {
    id: `${stage}.prompt`, label: () => t('benchmark.compare.row.prompt', { stage }),
    valueOf: (s) => s.stages[stage].skill, text: (s) => s.stages[stage].skill,
    copy: (from, to) => withPick(to, stage, { ...to.stages[stage], skill: from.stages[stage].skill }),
  },
  {
    id: `${stage}.agent`, label: () => t('benchmark.compare.row.agent', { stage }),
    valueOf: (s) => [s.stages[stage].agent, s.stages[stage].model ?? null], text: (s) => agentText(s.stages[stage]),
    copy: (from, to) => withPick(to, stage, withAgent(to.stages[stage], from.stages[stage])),
  },
];

// The spec's order: two rows per stage, then the rest as the screen draws them. The stage's prompt text is not a row
const SETUP_ROWS: readonly SetupRow[] = [
  ...STAGES.flatMap(stageRows),
  { id: 'plugins', label: () => t('benchmark.compare.row.plugins'), valueOf: (s) => s.plugins, text: (s) => listText(s.plugins), copy: (from, to) => ({ ...to, plugins: from.plugins }) },
  {
    id: 'rules.allow', label: () => t('benchmark.compare.row.allow'), valueOf: (s) => s.rules.allow, text: (s) => listText(s.rules.allow),
    copy: (from, to) => ({ ...to, rules: { ...to.rules, allow: from.rules.allow } }),
  },
  {
    id: 'rules.deny', label: () => t('benchmark.compare.row.deny'), valueOf: (s) => s.rules.deny, text: (s) => listText(s.rules.deny),
    copy: (from, to) => ({ ...to, rules: { ...to.rules, deny: from.rules.deny } }),
  },
  { id: 'items', label: () => t('benchmark.compare.row.items'), valueOf: (s) => s.items, text: itemsText, copy: (from, to) => ({ ...to, items: from.items }) },
  {
    id: 'worktree.setup', label: () => t('benchmark.compare.row.setup'), valueOf: (s) => s.worktree.setup, text: (s) => blankText(s.worktree.setup),
    copy: (from, to) => ({ ...to, worktree: { ...to.worktree, setup: from.worktree.setup } }),
  },
  {
    id: 'worktree.teardown', label: () => t('benchmark.compare.row.teardown'), valueOf: (s) => s.worktree.teardown, text: (s) => blankText(s.worktree.teardown),
    copy: (from, to) => ({ ...to, worktree: { ...to.worktree, teardown: from.worktree.teardown } }),
  },
  // Compared by the task array, not the text: two lists with the same counts are still different tasks
  { id: 'tasks', label: () => t('benchmark.compare.row.tasks'), valueOf: (s) => s.tasks, text: tasksText, copy: (from, to) => ({ ...to, tasks: from.tasks }) },
];

/** What an arm runs: each stage field it sets over the base's, every other key whole (#462's mergeArm, as the runs merge it). */
export const effectiveSetup = (experiment: Experiment, arm: Arm): ArmSetup => mergeArm(experiment.base, arm.overrides);

function setupRow(row: SetupRow, experiment: Experiment, isOpen: boolean): CompareRow {
  const { base } = experiment;
  const cells = experiment.arms.map((arm): CompareCell => {
    const setup = effectiveSetup(experiment, arm);
    const isSame = isSameValue(row.valueOf(setup), row.valueOf(base));
    return { armId: arm.id, value: row.text(setup), isSame, isCopyable: isOpen && !isSame };
  });
  // The state holds only the base's tasks hash; an arm's cell goes without one (spec, closed decisions)
  const baseText = row.id === 'tasks' ? `${row.text(base)} · t·${experiment.tasksHash.slice(0, HASH_CHARS)}` : row.text(base);
  return { id: row.id, label: row.label(), base: baseText, cells };
}

const ISOLATION_KEYS: readonly (keyof BenchIsolation)[] = ['environment', 'network', 'permissionMode', 'allowedTools', 'deniedTools', 'limits', 'env', 'betweenRounds'];

// An isolation value on one line: a list comma-joined, a record as key=value pairs, — when either is empty
function valueText(value: unknown): string {
  if (Array.isArray(value)) return listText(value.map(String));
  if (typeof value === 'object' && value !== null) return listText(Object.entries(value).map(([key, v]) => `${key}=${String(v)}`));
  return String(value);
}

// Read only (the user, round 1): isolation is edited in the config tab, so no cell is copyable
function isolationRow(experiment: Experiment, key: keyof BenchIsolation): CompareRow | undefined {
  const { all, perArm } = experiment.isolation[key];
  const cells = experiment.arms.map((arm): CompareCell => {
    const own: unknown = perArm?.[arm.id];
    return { armId: arm.id, value: valueText(own ?? all), isSame: own === undefined || isSameValue(own, all), isCopyable: false };
  });
  if (cells.every((cell) => cell.isSame)) return undefined;
  return { id: `isolation.${key}`, label: t(`benchmark.compare.isolation.${key}`), base: valueText(all), cells };
}

/** The table's rows: every setup row in the spec's order, then the isolation rows that vary. Nothing is copyable while the routes would
 *  answer 409. */
export function compareRows(experiment: Experiment): CompareRow[] {
  const isOpen = !isLocked(experiment);
  const isolation = ISOLATION_KEYS.flatMap((key) => isolationRow(experiment, key) ?? []);
  return [...SETUP_ROWS.map((row) => setupRow(row, experiment, isOpen)), ...isolation];
}

export const isEqualRow = (row: CompareRow): boolean => row.cells.every((cell) => cell.isSame);
/** The rows só diferenças hides. */
export const hiddenCount = (rows: readonly CompareRow[]): number => rows.filter(isEqualRow).length;

export const isSetupRowId = (id: RowId): id is SetupRowId => !id.startsWith('isolation.');

// SetupRowId names exactly the rows of SETUP_ROWS, so the throw is unreachable from typed callers
function setupRowOf(id: SetupRowId): SetupRow {
  const row = SETUP_ROWS.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no compare row ${id}`);
  return row;
}

/** The target's new overrides after a copy (spec, "What a copy posts"). The route replaces overrides whole, so this is the whole object; the
 *  arms tab's diff keeps only what differs from the base, field by field in a stage, so an equal field never counts in N sobreposições. */
export const copiedOverrides = (experiment: Experiment, rowId: SetupRowId, from: Arm, to: Arm): ArmOverrides =>
  diffOverrides(experiment.base, setupRowOf(rowId).copy(effectiveSetup(experiment, from), effectiveSetup(experiment, to)));

/** Whether two arms already hold the same value on the row: copiar para lists such a target disabled. */
export function holdsSame(experiment: Experiment, rowId: SetupRowId, a: Arm, b: Arm): boolean {
  const row = setupRowOf(rowId);
  return isSameValue(row.valueOf(effectiveSetup(experiment, a)), row.valueOf(effectiveSetup(experiment, b)));
}
