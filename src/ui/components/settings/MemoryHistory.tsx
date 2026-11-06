import { Trash2Icon, Undo2Icon } from 'lucide-react';
import { useState } from 'react';
import { LESSON_GRID, LessonDisclosure } from '@/components/settings/MemoryLessonRow';
import { useFocusAfter } from '@/components/settings/MemoryLessons';
import { PART_TITLE } from '@/components/settings/TaskDefaults';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { discardChange, restoreChange } from '@/lib/memory-api';
import { changeByText, changeRefusalText, historyCountText } from '@/lib/memory-view';
import type { MemoryChange, MemoryView } from '../../../types';

interface MemoryHistoryProps { workspace: string; view: MemoryView; onView(view: MemoryView): void }
interface ChangeRowProps { workspace: string; change: MemoryChange; descRef(button: HTMLButtonElement | null): void; onDone(view: MemoryView): void }

const TITLE = 'title'; // focus target: no change's id, so the fallback (the history's title) takes the focus
const FOCUSABLE_TITLE = 'rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

// #684: one change, laid out as a lesson row with the action where the kind was. Restore and discard apply at once; a refusal stays on the
// row, under the lesson as it was, and so does the change
function ChangeRow({ workspace, change, descRef, onDone }: ChangeRowProps) {
  const [error, setError] = useState<string>();
  const { id } = change.entry;
  const restore = t('settings.memory.restore', { id });
  const discard = t('settings.memory.discard', { id });
  const run = (call: (workspace: string, changeId: string) => Promise<MemoryView>) => (): void => {
    setError(undefined);
    call(workspace, change.id).then(onDone, (err: unknown) => setError(changeRefusalText(err)));
  };
  return (
    <div className={`${LESSON_GRID} items-start border-t`}>
      <span className="truncate font-mono text-xs" title={id}>{id}</span>
      <Badge variant="outline">{t(`settings.memory.action.${change.action}`)}</Badge>
      <div className="flex min-w-0 flex-col gap-1">
        <LessonDisclosure description={change.entry.description} body={change.entry.body} descRef={descRef} />
        <p className="max-w-[72ch] break-words pl-[22px] text-xs"><span className="text-muted-foreground">{t('settings.memory.why')}</span> {change.why}</p>
        <span className="pl-[22px] text-muted-foreground text-xs">{changeByText(change)}</span>
        {error !== undefined && <p role="alert" className="pl-[22px] text-destructive text-xs">{error}</p>}
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={restore} title={restore} onClick={run(restoreChange)}><Undo2Icon /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={discard} title={discard} onClick={run(discardChange)}><Trash2Icon /></Button>
      </div>
    </div>
  );
}

/** The memory dialog's history (#684): the changes agents made with hive_revise and hive_forget, newest first, each lesson as it was with
 * the why. Always shown, empty or not, so the user knows where an agent's change lands. */
export function MemoryHistory({ workspace, view, onView }: MemoryHistoryProps) {
  const focus = useFocusAfter<HTMLHeadingElement>();
  const changes = [...view.history].reverse(); // stored oldest first; the newest is the one the user came to see
  const done = (changeId: string) => (next: MemoryView): void => {
    const at = changes.findIndex((c) => c.id === changeId);
    focus.focusNext(changes[at + 1]?.id ?? TITLE); // the next change's description, else the title
    onView(next);
  };
  const title = t('settings.memory.history');
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h3 ref={focus.fallback} tabIndex={-1} className={`${PART_TITLE} ${FOCUSABLE_TITLE}`}>{title}</h3>
        <span className="text-muted-foreground text-xs">{historyCountText(view.history.length)}</span>
      </div>
      <div className="flex flex-col rounded-md border">
        <div className={`${LESSON_GRID} text-muted-foreground text-xs`}>
          <span>{t('settings.memory.key')}</span><span>{t('settings.memory.change')}</span><span>{t('settings.memory.asItWas')}</span><span />
        </div>
        {changes.map((change) => <ChangeRow key={change.id} workspace={workspace} change={change} descRef={focus.refOf(change.id)} onDone={done(change.id)} />)}
        {changes.length === 0 && <p className="border-t px-3 py-2.5 text-muted-foreground text-xs">{t('settings.memory.historyNone')}</p>}
      </div>
    </section>
  );
}
