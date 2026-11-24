// The variables form's state and what a save writes (#321, #621): the declaration and its overrides go into the header, each workspace value
// through its route. Pure, so the form only wires controls to it.
import type { TemplateVariable, VariableKind, VariableValue } from '../../../template';
import { addVariable, type EditResult, setVariableValue, updateVariable, type VariableFields } from '../../../template-edit';
import type { WorkspaceVariables } from '../../../types';
import { rawOf, valueOfRaw } from '@/components/plugins/ChoiceSelect';
import { type MessageKey, t } from '@/i18n';

export type Raws = Readonly<Record<string, string>>;
/** The form's state as the controls hold it: raw strings, '' for none. `overrides` counts only while `hasOverrides`: "remover" closes it. */
export interface Draft {
  name: string; kind: VariableKind; values: string; fallback: string; required: boolean;
  shared: Raws; overrides: Raws; hasOverrides: boolean;
}
export interface WorkspaceWrite { workspace: string; value: VariableValue | undefined }

const NULL_SHOWN = 'null';

export const valuesOf = (draft: Draft): string[] => draft.values.split('\n').map((value) => value.trim()).filter((value) => value !== '');
// The declaration's keys in the order the shipped templates write them: the type's, then default or required, then workspaces
const KIND_FIELDS: Record<VariableKind, (draft: Draft) => VariableFields> = {
  text: () => ({}),
  list: (draft) => ({ values: valuesOf(draft) }),
  boolean: () => ({ type: 'boolean' }),
};

const ownOf = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const rawsOf = (workspaces: readonly string[], read: (workspace: string) => VariableValue | undefined): Raws =>
  Object.fromEntries(workspaces.map((w) => [w, rawOf(read(w))]));

export function draftOf(variable: TemplateVariable | undefined, workspaces: readonly string[], values: WorkspaceVariables): Draft {
  if (variable === undefined) {
    return { name: '', kind: 'text', values: '', fallback: '', required: false, shared: {}, overrides: {}, hasOverrides: false };
  }
  return {
    name: variable.name, kind: variable.kind, values: (variable.values ?? []).join('\n'), fallback: rawOf(variable.default), required: variable.required,
    shared: rawsOf(workspaces, (w) => ownOf(ownOf(values, w) ?? {}, variable.name)),
    overrides: rawsOf(workspaces, (w) => ownOf(variable.workspaces, w)),
    hasOverrides: workspaces.some((w) => Object.hasOwn(variable.workspaces, w)),
  };
}

/** A raw value as the form shows it in italics where a field is empty: null, yes / no, or the text. */
export function shownOf(kind: VariableKind, raw: string): string {
  if (raw === '') return NULL_SHOWN;
  if (kind === 'boolean') return t(raw === 'true' ? 'plugins.variables.yes' : 'plugins.variables.no');
  return raw;
}
/** What an empty workspace value falls back to: the default (null for a required variable, which has none). */
export const defaultShown = (draft: Draft): string => shownOf(draft.kind, draft.required ? '' : draft.fallback);
/** What an empty override falls back to: the workspace value, else the default. */
export const effectiveShown = (draft: Draft, workspace: string): string =>
  ((draft.shared[workspace] ?? '') === '' ? defaultShown(draft) : shownOf(draft.kind, draft.shared[workspace] ?? ''));

const overrideRaw = (draft: Draft, workspace: string): string => (draft.hasOverrides ? draft.overrides[workspace] ?? '' : '');

// Decision 14: an empty default is null; required writes no default, as the parser refuses both; an empty override writes no entry
function declarationOf(draft: Draft): VariableFields {
  const presence: VariableFields = draft.required ? { required: true } : { default: valueOfRaw(draft.kind, draft.fallback) ?? null };
  return { ...KIND_FIELDS[draft.kind](draft), ...presence };
}
function fieldsOf(draft: Draft, workspaces: readonly string[]): VariableFields {
  const entries = workspaces.flatMap((w): [string, VariableValue][] => {
    const value = valueOfRaw(draft.kind, overrideRaw(draft, w));
    return value === undefined ? [] : [[w, value]];
  });
  return { ...declarationOf(draft), ...(entries.length > 0 ? { workspaces: Object.fromEntries(entries) } : {}) };
}

// Each edit on the text the one before answered; the first refusal stops the chain
function chain(text: string, steps: readonly ((text: string) => EditResult)[]): EditResult | undefined {
  return steps.reduce<EditResult | undefined>((result, step) => (result !== undefined && !result.ok ? result : step(result?.text ?? text)), undefined);
}

// Decision 7: a changed declaration is rewritten in place. updateVariable keeps every entry the fields do not name, so a configured workspace
// whose override was emptied loses its entry first. An unchanged declaration only splices its changed entries, so a version whose only change
// was an override comes back equal to its base once the override goes (#621, decision 9)
function editOf(text: string, draft: Draft, before: Draft, workspaces: readonly string[], variable: TemplateVariable): EditResult | undefined {
  const changed = workspaces.filter((w) => overrideRaw(draft, w) !== overrideRaw(before, w));
  const set = (w: string) => (current: string): EditResult => setVariableValue(current, variable.name, w, valueOfRaw(draft.kind, overrideRaw(draft, w)));
  if (JSON.stringify(declarationOf(draft)) === JSON.stringify(declarationOf(before))) return chain(text, changed.map(set));
  const fields = fieldsOf(draft, workspaces);
  const given = fields.workspaces ?? {};
  const emptied = workspaces.filter((w) => Object.hasOwn(variable.workspaces, w) && !Object.hasOwn(given, w));
  const cleared = (w: string) => (current: string): EditResult => setVariableValue(current, variable.name, w, undefined);
  return chain(text, [...emptied.map(cleared), (current) => updateVariable(current, variable.name, fields)]);
}

/** The header edit a save makes, a refusal's copy, or undefined when neither the declaration nor an override changed. */
export function headerEdit(text: string, draft: Draft, before: Draft, workspaces: readonly string[], variable: TemplateVariable | undefined): EditResult | MessageKey | undefined {
  if (draft.kind === 'list' && valuesOf(draft).length === 0) return 'plugins.variables.form.noValues';
  if (variable === undefined) return addVariable(text, { name: draft.name.trim(), ...fieldsOf(draft, workspaces) });
  return editOf(text, draft, before, workspaces, variable);
}

/** The workspace values a save sends through the route: each changed field, an emptied one as a removal. */
export const workspaceWrites = (draft: Draft, before: Draft, workspaces: readonly string[]): WorkspaceWrite[] =>
  workspaces
    .filter((w) => (draft.shared[w] ?? '') !== (before.shared[w] ?? ''))
    .map((w) => ({ workspace: w, value: valueOfRaw(draft.kind, draft.shared[w] ?? '') }));
