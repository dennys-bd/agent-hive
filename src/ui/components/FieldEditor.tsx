import { CheckIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { toast } from 'sonner';
import { STATUS } from '../../field-values';
import type { FieldValue, ItemField } from '../../types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type FieldAnswer, readFields, writeField } from '@/hooks/use-item-fields';
import { t } from '@/i18n';

const MUTED = 'text-muted-foreground';
const TRIGGER = 'flex min-h-5 w-full min-w-0 items-center text-left disabled:opacity-50';

export interface FieldEditorProps {
  itemId: string; // namespaced: the source is its prefix
  field: ItemField;
  display?: ReactNode; // how the value looks: a table cell's own rendering; plain text when absent
  onWritten(answer: FieldAnswer): void; // the write's re-read fields and row
}
type EditorProps = FieldEditorProps & { display: ReactNode };

// The sidebar's value: the text, the logins joined, or — when empty
function FieldText({ value }: { value: FieldValue }) {
  const text = value === null ? '' : Array.isArray(value) ? value.join(', ') : String(value);
  return text === '' ? <span className={MUTED}>—</span> : <span className="truncate">{text}</span>;
}

// One editor's writes, one at a time (#686): disabled while in flight, so a field's own writes never overtake each other. A refusal is
// writeField's toast, and the editor keeps showing the value it had: the field only changes with a write's answer
function useWrite(itemId: string, field: ItemField, onWritten: (answer: FieldAnswer) => void): { isBusy: boolean; write(value: FieldValue): Promise<void> } {
  const [isBusy, setIsBusy] = useState(false);
  const write = async (value: FieldValue): Promise<void> => {
    setIsBusy(true);
    const answer = await writeField(itemId, field.name, value);
    setIsBusy(false);
    if (answer !== undefined) onWritten(answer);
  };
  return { isBusy, write };
}

// A choice's options: the field's own, else read when its menu opens (a table cell knows no milestones, issue types or assignable users)
function useOptions(itemId: string, field: ItemField): { options?: string[]; load(): void } {
  const [read, setRead] = useState<string[]>();
  const load = (): void => {
    if (field.options !== undefined || read !== undefined) return;
    readFields(itemId).then(
      (fields) => setRead(fields?.find((f) => f.name === field.name)?.options ?? []),
      (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
    );
  };
  return { options: field.options ?? read, load };
}

// A single-select, an iteration, a milestone or an issue type (ProjectStatusSelect's pattern): the options with the current one checked, limpar when set
function ChoiceEditor({ itemId, field, display, onWritten }: EditorProps) {
  const { isBusy, write } = useWrite(itemId, field, onWritten);
  const { options, load } = useOptions(itemId, field);
  return (
    <DropdownMenu onOpenChange={(isOpen) => { if (isOpen) load(); }}>
      <DropdownMenuTrigger asChild disabled={isBusy}>
        <button type="button" aria-label={t('field.edit', { field: field.name })} className={TRIGGER}>{display}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] w-[220px] overflow-y-auto">
        {options === undefined && <p className={`px-2 py-1.5 text-xs ${MUTED}`}>{t('project.loading')}</p>}
        {options?.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => { if (option !== field.value) void write(option); }}>
            <CheckIcon aria-hidden="true" className={`size-3.5 ${option === field.value ? '' : 'invisible'}`} />
            <span className="truncate">{option}</span>
          </DropdownMenuItem>
        ))}
        {field.value !== null && field.name !== STATUS && ( // a task is always in a column: Status is changed, never cleared
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void write(null)}>{t('field.clear')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The assignees (IssueLabelsPopover's pattern): a checkbox per login, the current ones first; a toggle writes the whole new set
function AssigneesEditor({ itemId, field, display, onWritten }: EditorProps) {
  const { isBusy, write } = useWrite(itemId, field, onWritten);
  const { options, load } = useOptions(itemId, field);
  const current = Array.isArray(field.value) ? field.value : [];
  const toggle = (login: string): void => void write(current.includes(login) ? current.filter((l) => l !== login) : [...current, login]);
  return (
    <Popover onOpenChange={(isOpen) => { if (isOpen) load(); }}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t('field.edit', { field: field.name })} className={TRIGGER}>{display}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[320px] w-[220px] flex-col gap-1 overflow-y-auto p-2">
        {options === undefined
          ? <p className={`text-xs ${MUTED}`}>{t('project.loading')}</p>
          : [...new Set([...current, ...options])].map((login) => (
            <label key={login} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted">
              <input type="checkbox" checked={current.includes(login)} disabled={isBusy} onChange={() => toggle(login)} />
              {login}
            </label>
          ))}
      </PopoverContent>
    </Popover>
  );
}

// An input's text as the field's value: empty clears, a number field's text is a number
const parsed = (type: ItemField['type'], draft: string): FieldValue => {
  const text = draft.trim();
  if (text === '') return null;
  return type === 'number' ? Number(text) : text;
};

// A text, a number or a date (Editable's pattern): the value until a click, then an input saved on Enter or blur, cancelled on Escape
function InputEditor({ itemId, field, display, onWritten }: EditorProps) {
  const [draft, setDraft] = useState<string>();
  const isClosed = useRef(true); // Enter's save unmounts the input: its blur must not save again
  const { isBusy, write } = useWrite(itemId, field, onWritten);
  const close = (): void => {
    isClosed.current = true;
    setDraft(undefined);
  };
  const save = (): void => {
    if (isClosed.current || draft === undefined) return;
    const value = parsed(field.type, draft);
    close();
    if (value !== field.value) void write(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  if (draft === undefined) {
    const open = (): void => {
      isClosed.current = false;
      setDraft(field.value === null ? '' : String(field.value));
    };
    return <button type="button" aria-label={t('field.edit', { field: field.name })} disabled={isBusy} className={TRIGGER} onClick={open}>{display}</button>;
  }
  return (
    <Input
      autoFocus aria-label={field.name} type={field.type === 'text' ? 'text' : field.type} value={draft} className="h-6 px-1.5 text-xs"
      onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={onKeyDown}
    />
  );
}

/** One field's editor (#686), by kind: a choice menu, the assignees' checkboxes, or a text, number or date input. A read-only kind is its value
 * as text. Each write goes to the source at once; its answer (the re-read fields and row) is the caller's to show. */
export function FieldEditor(props: FieldEditorProps) {
  const { field } = props;
  const editor: EditorProps = { ...props, display: props.display ?? <FieldText value={field.value} /> };
  if (field.readOnly) return <span className="min-w-0 truncate" title={t('field.readOnly')}>{editor.display}</span>;
  if (field.type === 'assignees') return <AssigneesEditor {...editor} />;
  if (field.type === 'text' || field.type === 'number' || field.type === 'date') return <InputEditor {...editor} />;
  return <ChoiceEditor {...editor} />;
}
