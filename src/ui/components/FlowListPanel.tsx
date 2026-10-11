import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { activityOf } from '../../activities';
import type { Stage, State, Status, Task } from '../../types';
import { FlowTask } from '@/components/FlowTask';
import { type DragRef, useStageDrag } from '@/components/task-drag';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { statusText, t } from '@/i18n';
import { matchesSearch } from '@/lib/flow-search';
import { taskState } from '@/lib/task-state';

interface FlowListPanelProps { stage: Stage; state: State; tasks: Task[]; order: Task[]; drag: DragRef; selectedId?: string; onOpen?(taskId: string): void; onClose(): void }

/** A node's list (#134, 1b): 340px over the canvas's right, every task of the node in the compact card, a filter by text and by status, and
 * esc fecha · o grafo não muda; × and esc close it. Drag reorders inside the stage, as in the node. */
export function FlowListPanel({ stage, state, tasks, order, drag, selectedId, onOpen, onClose }: FlowListPanelProps) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status | 'all'>('all');
  useEffect(() => {
    const close = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  const states = new Map(tasks.map((c) => [c.item.itemId, taskState(c, state)]));
  const present = [...new Set(states.values())];
  const waiting = [...states.values()].filter((s) => s === 'waiting' || s === 'approval').length;
  const shown = tasks.filter((c) => matchesSearch(c, activityOf(state, c.item.itemId)?.branch ?? '', text) && (status === 'all' || states.get(c.item.itemId) === status));
  const { draggedId, dropBefore, taskDragProps } = useStageDrag(drag, stage, order, state);
  const filter = t('flow.list.filter', { stage: stage.name });
  return (
    <section data-flow-list-panel aria-label={stage.name} className="absolute inset-y-0 right-0 z-10 flex w-[340px] flex-col border-l bg-card shadow-lg">
      <header className="flex h-10 flex-none items-center gap-2 border-b px-3">
        <h3 className="truncate font-semibold text-[13px]">{stage.name}</h3>
        <span className="text-muted-foreground text-xs">{t('flow.list.count', { n: tasks.length })}</span>
        {waiting > 0 && <span className="text-waiting text-xs">{`● ${waiting}`}</span>}
        <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label={t('flow.list.close')} onClick={onClose}><XIcon /></Button>
      </header>
      <div className="flex h-9 flex-none items-center gap-2 border-b px-3">
        <Input aria-label={filter} placeholder={filter} value={text} onChange={(e) => setText(e.target.value)} className="h-7 flex-1 text-xs" />
        <Select value={status} onValueChange={(v) => setStatus(v as Status | 'all')}>
          <SelectTrigger aria-label={t('flow.list.status')} className="h-7 w-auto text-xs"><SelectValue>{status === 'all' ? t('flow.list.status') : statusText(status)}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('flow.list.status.all')}</SelectItem>
            {present.map((s) => <SelectItem key={s} value={s}>{statusText(s)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <ul aria-label={t('flow.list.count', { n: tasks.length })} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2.5 py-2 [scrollbar-width:none]">
        {shown.map((task) => (
          <FlowTask
            key={task.item.itemId} task={task} state={state} dragHandlers={{ draggable: true, ...taskDragProps(task) }} isDimmed={draggedId === task.item.itemId}
            isDropBefore={dropBefore === task.item.itemId} isSelected={selectedId === task.item.itemId} onOpen={onOpen}
          />
        ))}
      </ul>
      <footer className="flex h-8 flex-none items-center border-t px-3 text-muted-foreground text-xs">{t('flow.list.footer')}</footer>
    </section>
  );
}
