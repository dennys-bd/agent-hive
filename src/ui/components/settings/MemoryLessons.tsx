import { useState } from 'react';
import { LESSON_GRID, LessonEditRow, LessonRow } from '@/components/settings/MemoryLessonRow';
import { PART_TITLE } from '@/components/settings/TaskDefaults';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t } from '@/i18n';
import { type KindFilter, kindCounts, kindLabel } from '@/lib/memory-view';
import { isMemoryKind, MEMORY_KINDS, type MemoryView } from '../../../types';

interface MemoryLessonsProps { workspace: string; view: MemoryView; onView(view: MemoryView): void }

const NEW = 'new'; // the editing row of a lesson not saved yet; an entry's own id otherwise

/** The memory dialog's lessons (#797): a kind filter with counts, the table, and one row in edit at a time. `+ lesson` shows every kind and
 * opens a row at the end; cancelling it discards the lesson. */
export function MemoryLessons({ workspace, view, onView }: MemoryLessonsProps) {
  const [filter, setFilter] = useState<KindFilter>('all');
  const [editing, setEditing] = useState<string>();
  const counts = kindCounts(view.entries);
  const shown = filter === 'all' ? view.entries : view.entries.filter((e) => e.kind === filter);
  const saved = (next: MemoryView): void => {
    setEditing(undefined);
    onView(next);
  };
  const title = t('settings.memory.lessonsTitle');
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 className={PART_TITLE}>{title}</h3>
        <ToggleGroup type="single" variant="outline" size="sm" aria-label={t('settings.memory.filterLabel')} value={filter} onValueChange={(value) => { if (value === 'all' || isMemoryKind(value)) setFilter(value); }}>
          <ToggleGroupItem value="all">{t('settings.memory.filter.all', { n: counts.all })}</ToggleGroupItem>
          {MEMORY_KINDS.map((kind) => <ToggleGroupItem key={kind} value={kind}>{`${kindLabel(kind)} · ${counts[kind]}`}</ToggleGroupItem>)}
        </ToggleGroup>
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => { setFilter('all'); setEditing(NEW); }}>{t('settings.memory.add')}</Button>
      </div>
      <div className="flex flex-col rounded-md border">
        <div className={`${LESSON_GRID} text-muted-foreground text-xs`}>
          <span>{t('settings.memory.key')}</span><span>{t('settings.memory.type')}</span><span>{t('settings.memory.lesson')}</span><span />
        </div>
        {shown.map((entry) => (entry.id === editing
          ? <LessonEditRow key={entry.id} workspace={workspace} entry={entry} onSaved={saved} onCancel={() => setEditing(undefined)} />
          : <LessonRow key={entry.id} workspace={workspace} entry={entry} onEdit={() => setEditing(entry.id)} onView={onView} />))}
        {editing === NEW && <LessonEditRow workspace={workspace} onSaved={saved} onCancel={() => setEditing(undefined)} />}
        {shown.length === 0 && editing !== NEW && (
          <p className="border-t px-3 py-2.5 text-muted-foreground text-xs">{t(filter === 'all' ? 'settings.memory.none' : 'settings.memory.empty')}</p>
        )}
      </div>
    </section>
  );
}
