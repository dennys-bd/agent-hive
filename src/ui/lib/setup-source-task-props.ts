// A source row's task properties in the settings form (#688): the defaults and the rules, each property's derived mode, what a new rule sets and
// the checks. Out of settings-form.ts, which it would push toward 400 lines. Pure: no DOM, so node:test covers it.
import { TASK_PROPS, type RuleOp, type SourceTaskProps, type TaskEntry, type TaskProp, type TaskProps } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import type { FlowDraft, StageDraft } from './settings-form.js';

/** One rule block (#688); id is its React key, never sent. */
export interface TaskRuleDraft { id: string; field: string; op: RuleOp; value: string; set: TaskSetDraft }
/** A rule's set as edited (#670): entry travels as an EntryDraft. */
export type TaskSetDraft = Omit<Partial<TaskProps>, 'entry'> & { entry?: EntryDraft };
/** The defaults as edited (#688): workspace '' = no workspace. */
export interface TaskDefaultsDraft { workspace: string; auto: boolean; entry: EntryDraft }
export interface SourceTaskPropsDraft { defaults: TaskDefaultsDraft; rules: TaskRuleDraft[] }
/** A property's value as the form edits it: a workspace name ('' = none) or auto's on / off. */
export type PropValue = string | boolean | EntryDraft;
/** fixed when no rule sets the property, else how many rules do (#688): derived, never stored. */
export type PropMode = 'fixed' | number;

export const PROP_LABEL: Record<TaskProp, MessageKey> = { workspace: 'settings.taskProps.prop.workspace', auto: 'settings.taskProps.prop.auto', entry: 'settings.taskProps.prop.entry' };
export const PROP_NOTE: Record<TaskProp, MessageKey> = { workspace: 'settings.taskProps.note.workspace', auto: 'settings.taskProps.note.auto', entry: 'settings.taskProps.note.entry' };

const NEW_RULE_OP: RuleOp = 'icontains'; // the issue's own example: a tag anywhere in the title, whatever its case

/** A new row's (#688): `workspace` as its default, auto on, entering at `flowId` (#670: '' when none is given, which shows as a problem), no rules. */
export const emptyTaskProps = (workspace = '', flowId = ''): SourceTaskPropsDraft => ({ defaults: { workspace, auto: true, entry: { flowId } }, rules: [] });

const setDraft = ({ entry, ...rest }: Partial<TaskProps>, scope: FlowScope): TaskSetDraft => (entry === undefined ? rest : { ...rest, entry: entryDraft(entry, scope) });

export function taskPropsDraft(saved: SourceTaskProps, scope: FlowScope): SourceTaskPropsDraft {
  const { workspace, auto, entry } = saved.defaults;
  return {
    defaults: { workspace: workspace ?? '', auto, entry: entryDraft(entry, scope) },
    rules: saved.rules.map((r) => ({ id: crypto.randomUUID(), field: r.field, op: r.op, value: r.value, set: setDraft(r.set, scope) })),
  };
}

const setFrom = ({ entry, ...rest }: TaskSetDraft, scope: FlowScope): Partial<TaskProps> => (entry === undefined ? rest : { ...rest, entry: entryFrom(entry, scope) });

/** Rules in order with field and value trimmed, no id; validateSettings ran first and the server parses again. */
export function taskPropsFrom({ defaults, rules }: SourceTaskPropsDraft, scope: FlowScope): SourceTaskProps {
  const { workspace, auto, entry } = defaults;
  return {
    defaults: { ...(workspace === '' ? {} : { workspace }), auto, entry: entryFrom(entry, scope) },
    rules: rules.map((r) => ({ field: r.field.trim(), op: r.op, value: r.value.trim(), set: setFrom(r.set, scope) })),
  };
}

export function propMode({ rules }: SourceTaskPropsDraft, prop: TaskProp): PropMode {
  const count = rules.filter((r) => r.set[prop] !== undefined).length;
  return count === 0 ? 'fixed' : count;
}

/** `target` with `prop` at `value`, as a new object (#688): the defaults and a rule's set share it. */
export function withProp<T extends TaskSetDraft>(target: T, prop: TaskProp, value: PropValue): T {
  if (prop === 'entry') return typeof value === 'object' ? { ...target, entry: value } : target;
  return prop === 'auto' ? { ...target, auto: value === true } : { ...target, workspace: String(value) };
}

/** `set` without `prop`: a chip's ×. */
export function withoutProp(set: TaskSetDraft, prop: TaskProp): TaskSetDraft {
  const { [prop]: _gone, ...rest } = set;
  return rest;
}

/** What a property starts at in a new rule or chip (#688): its default; for workspace, the Comb's first one when the default is empty. */
export function propDefault({ defaults }: SourceTaskPropsDraft, prop: TaskProp, workspaces: readonly string[]): PropValue {
  if (prop === 'entry') return defaults.entry;
  return prop === 'auto' ? defaults.auto : defaults.workspace || (workspaces[0] ?? '');
}

/** A new rule is never empty (#688): it sets the first property no rule sets yet, or workspace when every one is set somewhere. */
export function newTaskRule(draft: SourceTaskPropsDraft, workspaces: readonly string[]): TaskRuleDraft {
  const prop = TASK_PROPS.find((p) => propMode(draft, p) === 'fixed') ?? 'workspace';
  return { id: crypto.randomUUID(), field: '', op: NEW_RULE_OP, value: '', set: withProp<TaskSetDraft>({}, prop, propDefault(draft, prop, workspaces)) };
}

/** The first problem of one source's task properties against the workspace rows' names, as the text to show; undefined when there is none.
 * A workspace removed in Settings is refused, never dropped: dropping it would change routing without the user seeing it (#293). */
export function sourceTaskPropsProblem(source: string, draft: SourceTaskPropsDraft, workspaces: readonly string[], scope: FlowScope): string | undefined {
  const { defaults, rules } = draft;
  const nth = (bad: (r: TaskRuleDraft) => boolean): number => rules.findIndex(bad) + 1; // 0: no such rule
  const blank = nth((r) => r.field.trim() === '' || r.value.trim() === '');
  if (blank > 0) return t('settings.error.workspaceRuleBlank', { source, n: blank });
  const empty = nth((r) => Object.keys(r.set).length === 0);
  if (empty > 0) return t('settings.error.taskRuleEmpty', { source, n: empty });
  if (defaults.workspace !== '' && !workspaces.includes(defaults.workspace)) return t('settings.error.sourceWorkspace', { source });
  const gone = nth((r) => r.set.workspace !== undefined && !workspaces.includes(r.set.workspace));
  if (gone > 0) return t('settings.error.workspaceRuleGone', { source, n: gone });
  if (entryGone(defaults.entry, scope)) return t('settings.error.entryGone', { source }); // #670: refused, never dropped, as a removed workspace is
  const lost = nth((r) => r.set.entry !== undefined && entryGone(r.set.entry, scope));
  if (lost > 0) return t('settings.error.entryRuleGone', { source, n: lost });
  const placed = defaults.workspace !== '' || propMode(draft, 'workspace') !== 'fixed';
  return placed ? undefined : t('settings.error.taskPropsNoWorkspace', { source });
}

/** The entry as the form edits it (#670): flow and stage by their draft ids, so a rename in Settings needs no rewrite (as #861 does for stages);
 * null = outside the flow. An id no draft has is a removed flow or stage: entryGone. */
export type EntryDraft = { flowId: string; stageId?: string } | null;
/** The flow and stage drafts an entry resolves against. */
export interface FlowScope { flows: readonly FlowDraft[]; stages: readonly StageDraft[] }

/** A saved entry as its draft; a name no draft has resolves to '' and entryGone flags it, so a bad value is shown, never changed. */
export function entryDraft(entry: TaskEntry, { flows, stages }: FlowScope): EntryDraft {
  if (entry === null) return null;
  const flowId = flows.find((f) => f.name.trim() === entry.flow)?.id ?? '';
  if (entry.stage === undefined) return { flowId };
  return { flowId, stageId: stages.find((s) => s.flow === flowId && s.name.trim() === entry.stage)?.id ?? '' };
}

/** The entry toSettingsBody sends: the drafts' current names; validateSettings refused a gone one first. */
export function entryFrom(entry: EntryDraft, { flows, stages }: FlowScope): TaskEntry {
  if (entry === null) return null;
  const flow = flows.find((f) => f.id === entry.flowId)?.name.trim() ?? '';
  return entry.stageId === undefined ? { flow } : { flow, stage: stages.find((s) => s.id === entry.stageId)?.name.trim() ?? '' };
}

export const entryGone = (entry: EntryDraft, { flows, stages }: FlowScope): boolean =>
  entry !== null && (!flows.some((f) => f.id === entry.flowId) || (entry.stageId !== undefined && !stages.some((s) => s.id === entry.stageId && s.flow === entry.flowId)));

/** What the trigger, a rule's chip and the sources summary show (#670): outside the flow, `<flow>` or `<flow> · <stage>`. */
export function entryLabel(entry: EntryDraft, scope: FlowScope): string {
  if (entry === null) return t('start.destination.none');
  const named = entryFrom(entry, scope);
  return named === null || named.stage === undefined ? (named?.flow ?? '') : `${named.flow} · ${named.stage}`;
}
