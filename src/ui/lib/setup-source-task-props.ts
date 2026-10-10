// A source row's task properties in the settings form (#688): the defaults and the rules, each property's derived mode, what a new rule sets and
// the checks. Out of settings-form.ts, which it would push toward 400 lines. Pure: no DOM, so node:test covers it.
import { TASK_PROPS, type RuleOp, type SourceTaskProps, type TaskProp, type TaskProps } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';

/** One rule block (#688); id is its React key, never sent. */
export interface TaskRuleDraft { id: string; field: string; op: RuleOp; value: string; set: Partial<TaskProps> }
/** The defaults as edited (#688): workspace '' = no workspace. */
export interface TaskDefaultsDraft { workspace: string; auto: boolean }
export interface SourceTaskPropsDraft { defaults: TaskDefaultsDraft; rules: TaskRuleDraft[] }
/** A property's value as the form edits it: a workspace name ('' = none) or auto's on / off. */
export type PropValue = string | boolean;
/** fixed when no rule sets the property, else how many rules do (#688): derived, never stored. */
export type PropMode = 'fixed' | number;

export const PROP_LABEL: Record<TaskProp, MessageKey> = { workspace: 'settings.taskProps.prop.workspace', auto: 'settings.taskProps.prop.auto' };
export const PROP_NOTE: Record<TaskProp, MessageKey> = { workspace: 'settings.taskProps.note.workspace', auto: 'settings.taskProps.note.auto' };

const NEW_RULE_OP: RuleOp = 'icontains'; // the issue's own example: a tag anywhere in the title, whatever its case

/** A new row's (#688): `workspace` as its default, auto on, no rules. */
export const emptyTaskProps = (workspace = ''): SourceTaskPropsDraft => ({ defaults: { workspace, auto: true }, rules: [] });

export function taskPropsDraft(saved: SourceTaskProps): SourceTaskPropsDraft {
  return { defaults: { workspace: saved.defaults.workspace ?? '', auto: saved.defaults.auto }, rules: saved.rules.map((r) => ({ id: crypto.randomUUID(), ...r })) };
}

/** Rules in order with field and value trimmed, no id; validateSettings ran first and the server parses again. */
export function taskPropsFrom({ defaults, rules }: SourceTaskPropsDraft): SourceTaskProps {
  const { workspace, auto } = defaults;
  return {
    defaults: workspace === '' ? { auto } : { workspace, auto },
    rules: rules.map((r) => ({ field: r.field.trim(), op: r.op, value: r.value.trim(), set: r.set })),
  };
}

export function propMode({ rules }: SourceTaskPropsDraft, prop: TaskProp): PropMode {
  const count = rules.filter((r) => r.set[prop] !== undefined).length;
  return count === 0 ? 'fixed' : count;
}

/** `target` with `prop` at `value`, as a new object (#688): the defaults and a rule's set share it. */
export function withProp<T extends Partial<TaskProps>>(target: T, prop: TaskProp, value: PropValue): T {
  return prop === 'auto' ? { ...target, auto: value === true } : { ...target, workspace: String(value) };
}

/** `set` without `prop`: a chip's ×. */
export function withoutProp(set: Partial<TaskProps>, prop: TaskProp): Partial<TaskProps> {
  const { [prop]: _gone, ...rest } = set;
  return rest;
}

/** What a property starts at in a new rule or chip (#688): its default; for workspace, the Comb's first one when the default is empty. */
export const propDefault = ({ defaults }: SourceTaskPropsDraft, prop: TaskProp, workspaces: readonly string[]): PropValue =>
  prop === 'auto' ? defaults.auto : defaults.workspace || (workspaces[0] ?? '');

/** A new rule is never empty (#688): it sets the first property no rule sets yet, or workspace when every one is set somewhere. */
export function newTaskRule(draft: SourceTaskPropsDraft, workspaces: readonly string[]): TaskRuleDraft {
  const prop = TASK_PROPS.find((p) => propMode(draft, p) === 'fixed') ?? 'workspace';
  return { id: crypto.randomUUID(), field: '', op: NEW_RULE_OP, value: '', set: withProp<Partial<TaskProps>>({}, prop, propDefault(draft, prop, workspaces)) };
}

/** The first problem of one source's task properties against the workspace rows' names, as the text to show; undefined when there is none.
 * A workspace removed in Settings is refused, never dropped: dropping it would change routing without the user seeing it (#293). */
export function sourceTaskPropsProblem(source: string, draft: SourceTaskPropsDraft, workspaces: readonly string[]): string | undefined {
  const { defaults, rules } = draft;
  const nth = (bad: (r: TaskRuleDraft) => boolean): number => rules.findIndex(bad) + 1; // 0: no such rule
  const blank = nth((r) => r.field.trim() === '' || r.value.trim() === '');
  if (blank > 0) return t('settings.error.workspaceRuleBlank', { source, n: blank });
  const empty = nth((r) => Object.keys(r.set).length === 0);
  if (empty > 0) return t('settings.error.taskRuleEmpty', { source, n: empty });
  if (defaults.workspace !== '' && !workspaces.includes(defaults.workspace)) return t('settings.error.sourceWorkspace', { source });
  const gone = nth((r) => r.set.workspace !== undefined && !workspaces.includes(r.set.workspace));
  if (gone > 0) return t('settings.error.workspaceRuleGone', { source, n: gone });
  const placed = defaults.workspace !== '' || propMode(draft, 'workspace') !== 'fixed';
  return placed ? undefined : t('settings.error.taskPropsNoWorkspace', { source });
}
