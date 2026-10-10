import { PencilIcon, XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { addLesson, editLesson, removeLesson } from '@/lib/memory-api';
import { charactersText, citedText, kindLabel, metaText, refusalText } from '@/lib/memory-view';
import { isMemoryKind, MEMORY_KINDS, MEMORY_TEXT_MAX, type MemoryEntry, type MemoryKind, type MemoryView } from '../../../types';

/** The table's columns (#797), as the handoff lays them out: id, kind, lesson, actions. */
export const LESSON_GRID = 'grid grid-cols-[10rem_7rem_minmax(0,1fr)_4.5rem] gap-3 px-3 py-2.5';

interface LessonRowProps { workspace: string; entry: MemoryEntry; onEdit(): void; onView(view: MemoryView): void }
interface LessonEditRowProps { workspace: string; entry?: MemoryEntry; onSaved(view: MemoryView): void; onCancel(): void }

/** One lesson as read (#797): its id, kind, text and meta line, the last why as the title of its citations; ✎ and ✕, which removes at once. */
export function LessonRow({ workspace, entry, onEdit, onView }: LessonRowProps) {
  const [error, setError] = useState<string>();
  const edit = t('settings.memory.edit', { id: entry.id });
  const remove = t('settings.memory.remove', { id: entry.id });
  return (
    <div className={`${LESSON_GRID} items-start border-t`}>
      <span className="truncate font-mono text-xs" title={entry.id}>{entry.id}</span>
      <Badge variant="outline">{kindLabel(entry.kind)}</Badge>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-pretty text-sm">{entry.text}</span>
        <span className="text-muted-foreground text-xs">{`${metaText(entry)} · `}<span title={entry.lastUsed?.why}>{citedText(entry.uses)}</span></span>
        {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={edit} title={edit} onClick={onEdit}><PencilIcon /></Button>
        <Button
          type="button" variant="ghost" size="icon-sm" aria-label={remove} title={remove}
          onClick={() => { removeLesson(workspace, entry.id).then(onView, (err: unknown) => setError(refusalText(err))); }}
        ><XIcon /></Button>
      </div>
    </div>
  );
}

/** The one row in edit (#797): an entry's, or a new lesson's with no id yet. Past MEMORY_TEXT_MAX the field is invalid and save is off; Enter
 * saves instead of breaking the line; a refusal shows under the field until the text changes. */
export function LessonEditRow({ workspace, entry, onSaved, onCancel }: LessonEditRowProps) {
  const id = useId();
  const [kind, setKind] = useState<MemoryKind>(entry?.kind ?? 'fact');
  const [text, setText] = useState(entry?.text ?? '');
  const [error, setError] = useState<string>();
  const over = text.length > MEMORY_TEXT_MAX;
  const save = (): void => {
    if (over) return;
    (entry ? editLesson(workspace, entry.id, kind, text) : addLesson(workspace, kind, text)).then(onSaved, (err: unknown) => setError(refusalText(err)));
  };
  return (
    <div className="flex flex-col gap-2 border-t bg-background p-3">
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,10rem)_minmax(0,1fr)] items-center gap-3">
        <span className="font-mono text-xs">{entry?.id ?? '—'}</span>
        <Select value={kind} onValueChange={(value) => { if (isMemoryKind(value)) setKind(value); }}>
          <SelectTrigger size="sm" aria-label={t('settings.memory.type')} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{MEMORY_KINDS.map((k) => <SelectItem key={k} value={k}>{kindLabel(k)}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-right text-muted-foreground text-xs">{entry ? metaText(entry) : ''}</span>
      </div>
      <Textarea
        aria-label={t('settings.memory.text')} rows={2} aria-invalid={over || error !== undefined} aria-describedby={`${id}-count`} value={text}
        onChange={(e) => { setText(e.target.value); setError(undefined); }}
        // a key an IME composition sends confirms its candidate, it is not the user's save
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); save(); } }}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span id={`${id}-count`} className={over ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>{charactersText(text.length, MEMORY_TEXT_MAX)}</span>
          {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
        </div>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('settings.memory.cancel')}</Button>
          <Button type="button" size="sm" disabled={over} onClick={save}>{t('settings.memory.save')}</Button>
        </div>
      </div>
    </div>
  );
}
