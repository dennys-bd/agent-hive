import { ChevronRightIcon, PencilIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { addLesson, editLesson, removeLesson } from '@/lib/memory-api';
import { canSaveLesson, charactersText, kindLabel, metaText, originDateText, readText, refusalText } from '@/lib/memory-view';
import { isMemoryKind, MEMORY_BODY_MAX, MEMORY_DESCRIPTION_MAX, MEMORY_KINDS, type MemoryEntry, type MemoryKind, type MemoryView } from '../../../types';

/** The table's columns (#797), as the handoff lays them out: id, kind, lesson, actions. */
export const LESSON_GRID = 'grid grid-cols-[10rem_7rem_minmax(0,1fr)_4.5rem] gap-3 px-3 py-2.5';

interface LessonRowProps { workspace: string; entry: MemoryEntry; descRef(button: HTMLButtonElement | null): void; onEdit(): void; onRemoved(view: MemoryView): void }
interface LessonEditRowProps { workspace: string; entry?: MemoryEntry; onSaved(view: MemoryView): void; onCancel(): void }

const DISCLOSURE = 'flex items-start gap-1.5 rounded-sm text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface LessonDisclosureProps { description: string; body: string; descRef(button: HTMLButtonElement | null): void }

/** A lesson's description as a disclosure of its body (#680), closed at first since bodies run to 4,000 characters; the lesson row's and,
 * for the lesson as it was, the history row's (#684). */
export function LessonDisclosure({ description, body, descRef }: LessonDisclosureProps) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={descRef} type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} className={DISCLOSURE}>
        <ChevronRightIcon aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-pretty">{description}</span>
      </button>
      <div id={bodyId} hidden={!open} className="max-w-[72ch] whitespace-pre-wrap break-words pl-[22px] text-[13px]/[19px]">{body}</div>
    </>
  );
}

/** One lesson as read (#797, #680): its id, kind, description as a disclosure of its body, then the meta line and how many times it was read (#681); ✎ and ✕, which removes at once. */
export function LessonRow({ workspace, entry, descRef, onEdit, onRemoved }: LessonRowProps) {
  const [error, setError] = useState<string>();
  const edit = t('settings.memory.edit', { id: entry.id });
  const remove = t('settings.memory.remove', { id: entry.id });
  return (
    <div className={`${LESSON_GRID} items-start border-t`}>
      <span className="truncate font-mono text-xs" title={entry.id}>{entry.id}</span>
      <Badge variant="outline">{kindLabel(entry.kind)}</Badge>
      <div className="flex min-w-0 flex-col gap-1">
        <LessonDisclosure description={entry.description} body={entry.body} descRef={descRef} />
        <span className="pl-[22px] text-muted-foreground text-xs">{`${metaText(entry)} · `}<span>{readText(entry.uses)}</span></span>
        {error !== undefined && <p role="alert" className="pl-[22px] text-destructive text-xs">{error}</p>}
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={edit} title={edit} onClick={onEdit}><PencilIcon /></Button>
        <Button
          type="button" variant="ghost" size="icon-sm" aria-label={remove} title={remove}
          onClick={() => { removeLesson(workspace, entry.id).then(onRemoved, (err: unknown) => setError(refusalText(err))); }}
        ><XIcon /></Button>
      </div>
    </div>
  );
}

// Enter saves from the description; ⌘/Ctrl+Enter from either field, so Enter alone breaks the body's line (#680). A key an IME composition
// sends confirms its candidate, it is not the user's save
const isSaveKey = (e: KeyboardEvent<HTMLElement>, multiline: boolean): boolean =>
  e.key === 'Enter' && !e.nativeEvent.isComposing && (!multiline || e.metaKey || e.ctrlKey);

interface LessonFieldProps { id: string; label: string; hint: string; length: number; max: number; children: ReactNode }
// A field of the editing row (#680): its label, the control, then its hint on the left and its live counter on the right
function LessonField({ id, label, hint, length, max, children }: LessonFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="font-normal text-muted-foreground text-xs">{label}</Label>
      {children}
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{hint}</span>
        <span id={`${id}-count`} className={length > max ? 'text-destructive' : 'text-muted-foreground'}>{charactersText(length, max)}</span>
      </div>
    </div>
  );
}

interface LessonEditHeaderProps { entry?: MemoryEntry; kind: MemoryKind; onKind(kind: MemoryKind): void }
// The row's id (— before the first save), its kind, and where it came from (#680: the sizes sit under each field now)
function LessonEditHeader({ entry, kind, onKind }: LessonEditHeaderProps) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-xs">{entry?.id ?? '—'}</span>
      <Select value={kind} onValueChange={(value) => { if (isMemoryKind(value)) onKind(value); }}>
        <SelectTrigger size="sm" aria-label={t('settings.memory.type')} className="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>{MEMORY_KINDS.map((k) => <SelectItem key={k} value={k}>{kindLabel(k)}</SelectItem>)}</SelectContent>
      </Select>
      <span className="ml-auto text-muted-foreground text-xs">{entry ? originDateText(entry) : `${t('settings.memory.you')} · ${t('settings.memory.now')}`}</span>
    </div>
  );
}

/** The one row in edit (#797, #680): an entry's, or a new lesson's with no id yet. Save is off while a field is empty or past its limit; a
 * refusal shows in the footer until either field changes. */
export function LessonEditRow({ workspace, entry, onSaved, onCancel }: LessonEditRowProps) {
  const id = useId();
  const [kind, setKind] = useState<MemoryKind>(entry?.kind ?? 'fact');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [error, setError] = useState<string>();
  const descriptionRef = useRef<HTMLInputElement>(null);
  useEffect(() => { descriptionRef.current?.focus(); }, []); // #680: ✎ and "+ lesson" land in the description
  const canSave = canSaveLesson(description, body);
  const save = (): void => {
    if (!canSave) return;
    const lesson = { kind, description, body };
    (entry ? editLesson(workspace, entry.id, lesson) : addLesson(workspace, lesson)).then(onSaved, (err: unknown) => setError(refusalText(err)));
  };
  const onKeyDown = (multiline: boolean) => (e: KeyboardEvent<HTMLElement>): void => {
    if (!isSaveKey(e, multiline)) return;
    e.preventDefault();
    save();
  };
  const edited = (set: (value: string) => void) => (value: string): void => { set(value); setError(undefined); };
  // #680: Esc cancels this row only; a key from a portalled Select list is not a descendant, so it only closes the list
  const onRowKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>): void => {
    // an IME's Esc dismisses its candidate, never the row and what was typed in it
    if (e.key !== 'Escape' || e.nativeEvent.isComposing || !(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    e.preventDefault();
    onCancel();
  };
  const isNew = entry === undefined;
  return (
    <fieldset aria-label={t('settings.memory.lesson')} data-lesson-edit="" onKeyDown={onRowKeyDown} className="flex min-w-0 flex-col gap-3 border-t bg-background p-3">
      <LessonEditHeader entry={entry} kind={kind} onKind={setKind} />
      <LessonField id={`${id}-d`} label={t('settings.memory.description')} hint={t('settings.memory.descriptionHint')} length={description.trim().length} max={MEMORY_DESCRIPTION_MAX}>
        <Input
          ref={descriptionRef} id={`${id}-d`} value={description} aria-invalid={description.trim().length > MEMORY_DESCRIPTION_MAX} aria-describedby={`${id}-d-count`}
          placeholder={isNew ? t('settings.memory.descriptionPlaceholder') : undefined} onChange={(e) => edited(setDescription)(e.target.value)} onKeyDown={onKeyDown(false)}
        />
      </LessonField>
      <LessonField id={`${id}-b`} label={t('settings.memory.body')} hint={t('settings.memory.bodyHint')} length={body.trim().length} max={MEMORY_BODY_MAX}>
        <Textarea
          id={`${id}-b`} rows={7} className="resize-y" value={body} aria-invalid={body.trim().length > MEMORY_BODY_MAX} aria-describedby={`${id}-b-count`}
          placeholder={isNew ? t('settings.memory.bodyPlaceholder') : undefined} onChange={(e) => edited(setBody)(e.target.value)} onKeyDown={onKeyDown(true)}
        />
      </LessonField>
      <div className="flex items-start gap-3">
        {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
        <span className="grow" />
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('settings.memory.cancel')}</Button>
        <Button type="button" size="sm" disabled={!canSave} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={save}>{t('settings.memory.save')}</Button>
      </div>
    </fieldset>
  );
}
