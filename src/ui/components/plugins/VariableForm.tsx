import { type FormEvent, useRef, useState } from 'react';
import type { TemplateVariable, VariableKind, VariableValue } from '../../../template';
import type { EditResult } from '../../../template-edit';
import type { WorkspaceVariables } from '../../../types';
import { type Draft, draftOf, headerEdit, valuesOf, workspaceWrites } from '@/components/plugins/variable-draft';
import { AddOverride, DraftValue, Field, OverrideSection, SharedSection } from '@/components/plugins/WorkspaceValueFields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { type MessageKey, t } from '@/i18n';

interface DeclarationProps { draft: Draft; update(patch: Partial<Draft>): void }
export interface VariableFormProps {
  text: string; workspaces: readonly string[]; variable?: TemplateVariable;
  values: WorkspaceVariables; // #621: each workspace's values, what the workspace section starts from
  onApply(result: EditResult): MessageKey | undefined; onClose(): void;
  onWorkspaceValue?(workspace: string, name: string, value: VariableValue | undefined): Promise<MessageKey | undefined>; // omitted (a passage): no workspace section
}

const MONO_INPUT = 'h-7 px-2 font-mono text-xs';
const KINDS: readonly [VariableKind, MessageKey][] = [['text', 'plugins.variables.form.text'], ['list', 'plugins.variables.form.list'], ['boolean', 'plugins.variables.form.boolean']];

// A segmented pick of one option: the type's
function Segmented<T>({ label, options, value, onPick }: { label: MessageKey; options: readonly [T, MessageKey][]; value: T; onPick(value: T): void }) {
  return (
    <Field label={t(label)}>
      <fieldset aria-label={t(label)} className="m-0 flex min-w-0 gap-0.5 rounded-md border p-0.5">
        {options.map(([option, key]) => (
          <Button key={key} type="button" size="xs" variant={option === value ? 'secondary' : 'ghost'} aria-pressed={option === value} className="flex-1" onClick={() => onPick(option)}>{t(key)}</Button>
        ))}
      </fieldset>
    </Field>
  );
}

// Type, a list's values, default and required; required clears and disables the default (decision 14). A new type clears the default and the
// overrides typed for the old one, never the workspace values: those are every skill's, so one this type cannot take shows red instead
function DeclarationFields({ draft, update }: DeclarationProps) {
  return (
    <>
      <Segmented label="plugins.variables.form.type" options={KINDS} value={draft.kind} onPick={(kind) => update({ kind, fallback: '', overrides: {} })} />
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

// Decision 2 (#621): the header edit first, when the declaration or an override changed, then each changed workspace value through its route.
// A header the edit already wrote is the baseline of a retry, so a refused route write never writes the header twice
function useSave({ text, workspaces, variable, onApply, onWorkspaceValue }: VariableFormProps, draft: Draft, initial: Draft) {
  const written = useRef(initial);
  return async (): Promise<MessageKey | undefined> => {
    const edit = headerEdit(text, draft, written.current, workspaces, variable);
    if (typeof edit === 'string') return edit;
    if (edit !== undefined) {
      const refused = onApply(edit);
      if (refused !== undefined) return refused;
      written.current = { ...draft, shared: written.current.shared };
    }
    if (onWorkspaceValue === undefined) return undefined;
    const name = variable?.name ?? draft.name.trim();
    const answers = await Promise.all(workspaceWrites(draft, initial, workspaces).map((write) => onWorkspaceValue(write.workspace, name, write.value)));
    return answers.find((answer) => answer !== undefined);
  };
}

/** The 11o form (#321): declares a variable, or rewrites one in its card's place with its name read-only. A refused edit or route write stays
 * open with its copy, never the parser's text (decision 15). */
export function VariableForm(props: VariableFormProps) {
  const { workspaces, variable, values, onClose, onWorkspaceValue } = props;
  const [initial] = useState(() => draftOf(variable, workspaces, values));
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<MessageKey>();
  const [isFocusingOverrides, setFocusingOverrides] = useState(false);
  const save = useSave(props, draft, initial);
  const update = (patch: Partial<Draft>): void => setDraft((prev) => ({ ...prev, ...patch }));
  const canShare = onWorkspaceValue !== undefined;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save().then((refused) => (refused === undefined ? onClose() : setError(refused)));
  };
  const addOverride = (): void => { setFocusingOverrides(true); update({ hasOverrides: true }); };
  const title = variable === undefined ? t('plugins.variables.add') : t('plugins.variables.form.editTitle', { name: variable.name });
  return (
    <form aria-label={title} onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-dashed bg-card p-2.5">
      {variable !== undefined && <b className="font-mono font-semibold">{title}</b>}
      <Field label={t('plugins.variables.form.name')}>
        <Input aria-label={t('plugins.variables.form.name')} value={draft.name} readOnly={variable !== undefined} onChange={(event) => update({ name: event.target.value })} className={MONO_INPUT} />
      </Field>
      <DeclarationFields draft={draft} update={update} />
      {canShare && <SharedSection draft={draft} workspaces={workspaces} update={update} />}
      {canShare && !draft.hasOverrides && <AddOverride onAdd={addOverride} />}
      {(draft.hasOverrides || !canShare) && (
        <OverrideSection draft={draft} workspaces={workspaces} update={update} canRemove={canShare} shouldFocus={isFocusingOverrides} />
      )}
      {error && <p role="alert" className="text-destructive">{t(error)}</p>}
      <div className="flex gap-1.5">
        <Button type="submit" size="xs">{t(variable === undefined ? 'plugins.variables.form.create' : 'plugins.variables.form.save')}</Button>
        <Button type="button" size="xs" variant="outline" onClick={onClose}>{t('plugins.variables.form.cancel')}</Button>
      </div>
    </form>
  );
}
