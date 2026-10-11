import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

const MUTED = 'text-muted-foreground';
const HTTP_CONFLICT = 409;

export type SaveResult = 'saved' | 'changed' | 'failed';

/** A title or description save (#757, #758), sent to `path` with the updatedAt the edit started on (Editable hands it over). A 409 is a newer
 * issue or PR on GitHub: say `changed`, read it again, and keep the draft. Any other refusal is its toast. */
export function fieldSaver(path: string, changed: string, onChanged: () => Promise<void>): (field: 'title' | 'body') => (text: string, updatedAt: string) => Promise<SaveResult> {
  return (field) => async (text, updatedAt) => {
    try {
      await postJson(path, { [field]: text, updatedAt });
    } catch (err) {
      const isChanged = (err as { status?: number }).status === HTTP_CONFLICT;
      toast.error(isChanged ? changed : err instanceof Error ? err.message : String(err));
      if (!isChanged) return 'failed';
      await onChanged();
      return 'changed';
    }
    await onChanged();
    return 'saved';
  };
}

export interface EditableOptions { label: string; value: string; updatedAt: string; isMultiline: boolean; changed: string; onSave(text: string, updatedAt: string): Promise<SaveResult> }

/** An edit in place's state (#62): whether it is open, what opens it, and its form while open. Editable lays it out beside the text; the PR's
 * description panel puts `edit` in its header and the form in its body. */
export interface EditableState { isEditing: boolean; edit(): void; form: ReactNode }

// ⌘↵ saves, Esc cancels
const formKeys = (save: () => void, close: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>): void => {
  if (e.key === 'Enter' && e.metaKey) {
    e.preventDefault();
    save();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
};

/** editar in place (#757, #758): the text swaps for a field with salvar and cancelar. A save refused because the issue or the PR changed keeps
 * the draft and says `changed` above the field. The save goes with the `updatedAt` read when the edit started: a refresh meanwhile (a poll, a
 * posted comment) must not make it look current, so only a refused save takes the reloaded one. */
export function useEditable({ label, value, updatedAt, isMultiline, changed, onSave }: EditableOptions): EditableState {
  const [draft, setDraft] = useState<string>();
  const [base, setBase] = useState(updatedAt);
  const [isRearming, setIsRearming] = useState(false);
  useEffect(() => {
    if (isRearming && updatedAt !== base) {
      setBase(updatedAt);
      setIsRearming(false);
    }
  }, [isRearming, updatedAt, base]);
  const [isChanged, setIsChanged] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const close = (): void => {
    setDraft(undefined);
    setIsChanged(false);
    setIsRearming(false);
  };
  const save = async (): Promise<void> => {
    if (draft === undefined || isSaving) return;
    setIsSaving(true);
    const result = await onSave(draft, base);
    setIsSaving(false);
    if (result === 'saved') close();
    else if (result === 'changed') {
      setIsChanged(true);
      setIsRearming(true);
    }
  };
  const edit = (): void => {
    setBase(updatedAt);
    setDraft(value);
  };
  const form = draft !== undefined && (
    <div className="flex flex-col gap-1.5">
      {isChanged && <p className={`text-xs ${MUTED}`}>{changed}</p>}
      <Textarea autoFocus aria-label={label} value={draft} rows={isMultiline ? 10 : 2} onChange={(e) => setDraft(e.target.value)} onKeyDown={formKeys(() => void save(), close)} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="outline" onClick={close}>{t('issue.cancel')}</Button>
        <Button type="button" size="xs" disabled={isSaving} onClick={() => void save()}>{t('issue.save')}</Button>
      </div>
    </div>
  );
  return { isEditing: draft !== undefined, edit, form };
}

/** editar beside the text (#757, #758): the issue page's title and description, and the PR's title. */
export function Editable({ children, ...options }: EditableOptions & { children: ReactNode }) {
  const { isEditing, edit, form } = useEditable(options);
  if (isEditing) return form;
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">{children}</div>
      <Button type="button" size="xs" variant="outline" onClick={edit}>{t('issue.edit')}</Button>
    </div>
  );
}
