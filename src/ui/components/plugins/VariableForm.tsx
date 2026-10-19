import { type FormEvent, type ReactNode, useState } from 'react';
import type { TemplateVariable, VariableKind, VariableValue } from '../../../template';
import { addVariable, type EditResult, setVariableValue, updateVariable, type VariableFields } from '../../../template-edit';
import { ChoiceSelect, rawOf, valueOfRaw } from '@/components/plugins/ChoiceSelect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { type MessageKey, t } from '@/i18n';

/** The form's state as the controls hold it: raw strings, '' for none. */
interface Draft { name: string; kind: VariableKind; values: string; fallback: string; required: boolean; perWorkspace: Readonly<Record<string, string>> }
interface DeclarationProps { draft: Draft; isEditing: boolean; update(patch: Partial<Draft>): void }
interface WorkspaceProps { draft: Draft; workspaces: readonly string[]; update(patch: Partial<Draft>): void }
interface DraftValueProps { kind: VariableKind; values: readonly string[]; raw: string; label: string; emptyLabel: string; isDisabled?: boolean; onChange(raw: string): void }
export interface VariableFormProps {
  text: string; workspaces: readonly string[]; variable?: TemplateVariable;
  onApply(result: EditResult): MessageKey | undefined; onClose(): void;
}

const MONO_INPUT = 'h-7 px-2 font-mono text-xs';
const KINDS: readonly [VariableKind, MessageKey][] = [['text', 'plugins.variables.form.text'], ['list', 'plugins.variables.form.list'], ['boolean', 'plugins.variables.form.boolean']];

const valuesOf = (draft: Draft): string[] => draft.values.split('\n').map((value) => value.trim()).filter((value) => value !== '');
// The declaration's keys in the order the shipped templates write them: the type's, then default or required, then workspaces
const KIND_FIELDS: Record<VariableKind, (draft: Draft) => VariableFields> = {
  text: () => ({}),
  list: (draft) => ({ values: valuesOf(draft) }),
  boolean: () => ({ type: 'boolean' }),
};

function draftOf(variable: TemplateVariable | undefined, workspaces: readonly string[]): Draft {
  if (variable === undefined) return { name: '', kind: 'text', values: '', fallback: '', required: false, perWorkspace: {} };
  const perWorkspace = Object.fromEntries(workspaces.map((w) => [w, rawOf(Object.hasOwn(variable.workspaces, w) ? variable.workspaces[w] : undefined)]));
  return { name: variable.name, kind: variable.kind, values: (variable.values ?? []).join('\n'), fallback: rawOf(variable.default), required: variable.required, perWorkspace };
}

// Decision 14: an empty default is null; required writes no default, as the parser refuses both; an empty workspace writes no entry
function fieldsOf(draft: Draft, workspaces: readonly string[]): VariableFields {
  const entries = workspaces.flatMap((w): [string, VariableValue][] => {
    const value = valueOfRaw(draft.kind, draft.perWorkspace[w] ?? '');
    return value === undefined ? [] : [[w, value]];
  });
  const presence: VariableFields = draft.required ? { required: true } : { default: valueOfRaw(draft.kind, draft.fallback) ?? null };
  return { ...KIND_FIELDS[draft.kind](draft), ...presence, ...(entries.length > 0 ? { workspaces: Object.fromEntries(entries) } : {}) };
}

// Decision 7: an edit rewrites the declaration in place. updateVariable keeps every entry the fields do not name, so a configured workspace
// whose value was emptied loses its entry first; then a declaration left with none is written with no workspaces: key at all
function editOf(text: string, draft: Draft, workspaces: readonly string[], variable: TemplateVariable | undefined): EditResult | MessageKey {
  if (draft.kind === 'list' && valuesOf(draft).length === 0) return 'plugins.variables.form.noValues';
  const fields = fieldsOf(draft, workspaces);
  if (variable === undefined) return addVariable(text, { name: draft.name.trim(), ...fields });
  const given = fields.workspaces ?? {};
  const emptied = workspaces.filter((w) => Object.hasOwn(variable.workspaces, w) && !Object.hasOwn(given, w));
  const cleared = emptied.reduce<EditResult | undefined>((result, w) => {
    if (result !== undefined && !result.ok) return result;
    return setVariableValue(result?.text ?? text, variable.name, w, undefined);
  }, undefined);
  if (cleared !== undefined && !cleared.ok) return cleared;
  return updateVariable(cleared?.text ?? text, variable.name, fields);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] text-muted-foreground">{label}</span>{children}</div>;
}

// A text is an input whose empty means the empty label; a list or yes/no is the shared select
function DraftValue({ kind, values, raw, label, emptyLabel, isDisabled = false, onChange }: DraftValueProps) {
  if (kind !== 'text') return <ChoiceSelect kind={kind} values={values} raw={raw} label={label} emptyLabel={emptyLabel} isDisabled={isDisabled} className="h-7 w-full" onChange={onChange} />;
  return <Input aria-label={label} value={raw} placeholder={emptyLabel} disabled={isDisabled} onChange={(event) => onChange(event.target.value)} className={MONO_INPUT} />;
}

function KindPicker({ kind, onKind }: { kind: VariableKind; onKind(kind: VariableKind): void }) {
  return (
    <div role="group" aria-label={t('plugins.variables.form.type')} className="flex gap-0.5 rounded-md border p-0.5">
      {KINDS.map(([k, key]) => (
        <Button key={k} type="button" size="xs" variant={k === kind ? 'secondary' : 'ghost'} aria-pressed={k === kind} className="flex-1" onClick={() => onKind(k)}>{t(key)}</Button>
      ))}
    </div>
  );
}

// Name (read-only when editing: a rename would leave the body's uses undeclared), type, a list's values, default and required; required
// clears and disables the default (decision 14). A new type clears the values typed for the old one
function DeclarationFields({ draft, isEditing, update }: DeclarationProps) {
  return (
    <>
      <Field label={t('plugins.variables.form.name')}>
        <Input aria-label={t('plugins.variables.form.name')} value={draft.name} readOnly={isEditing} onChange={(event) => update({ name: event.target.value })} className={MONO_INPUT} />
      </Field>
      <Field label={t('plugins.variables.form.type')}><KindPicker kind={draft.kind} onKind={(kind) => update({ kind, fallback: '', perWorkspace: {} })} /></Field>
      {draft.kind === 'list' && (
        <Field label={t('plugins.variables.form.values')}>
          <Textarea aria-label={t('plugins.variables.form.values')} value={draft.values} rows={3} onChange={(event) => update({ values: event.target.value })} className="min-h-0 px-2 py-1 font-mono text-xs" />
        </Field>
      )}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={t('plugins.variables.default')}>
            <DraftValue kind={draft.kind} values={valuesOf(draft)} raw={draft.fallback} label={t('plugins.variables.default')} emptyLabel="null" isDisabled={draft.required} onChange={(fallback) => update({ fallback })} />
          </Field>
        </div>
        <span className="flex items-center gap-1.5 pb-1.5">
          {t('plugins.variables.form.required')}
          <Switch aria-label={t('plugins.variables.form.required')} checked={draft.required} onCheckedChange={(required) => update({ required, fallback: '' })} />
        </span>
      </div>
    </>
  );
}

// A value per configured workspace, in config order (decisions 11, 14): empty uses the default
function WorkspaceFields({ draft, update, workspaces }: WorkspaceProps) {
  const values = valuesOf(draft);
  return (
    <Field label={t('plugins.variables.form.perWorkspace')}>
      {workspaces.map((w) => (
        <div key={w} className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><WorkspaceSquare name={w} /><span className="truncate">{w}</span></span>
          <DraftValue
            kind={draft.kind} values={values} raw={draft.perWorkspace[w] ?? ''} label={w} emptyLabel={t('plugins.variables.default')}
            onChange={(raw) => update({ perWorkspace: { ...draft.perWorkspace, [w]: raw } })}
          />
        </div>
      ))}
    </Field>
  );
}

/** The 11o form (#321) at the top of the list: declares a variable, or rewrites one's declaration with its name read-only. A refused edit
 * stays open with its copy, never the parser's text (decision 15). */
export function VariableForm({ text, workspaces, variable, onApply, onClose }: VariableFormProps) {
  const [draft, setDraft] = useState(() => draftOf(variable, workspaces));
  const [error, setError] = useState<MessageKey>();
  const update = (patch: Partial<Draft>): void => setDraft((prev) => ({ ...prev, ...patch }));
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = editOf(text, draft, workspaces, variable);
    const refused = typeof result === 'string' ? result : onApply(result);
    if (refused === undefined) onClose();
    else setError(refused);
  };
  const title = variable === undefined ? t('plugins.variables.add') : t('plugins.variables.form.editTitle', { name: variable.name });
  return (
    <form aria-label={title} onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-dashed bg-card p-2.5">
      <DeclarationFields draft={draft} isEditing={variable !== undefined} update={update} />
      <WorkspaceFields draft={draft} update={update} workspaces={workspaces} />
      <p className="text-[11px] text-muted-foreground">{t('plugins.variables.form.note')}</p>
      {error && <p role="alert" className="text-destructive">{t(error)}</p>}
      <div className="flex gap-1.5">
        <Button type="submit" size="xs">{t(variable === undefined ? 'plugins.variables.form.create' : 'plugins.variables.form.save')}</Button>
        <Button type="button" size="xs" variant="outline" onClick={onClose}>{t('plugins.variables.form.cancel')}</Button>
      </div>
    </form>
  );
}
