import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { HIVE_SOURCE, sourceOf } from '../../tasks';
import type { BlockerChange, BlockerRef, ItemBlockers, State, Task } from '../../types';
import { BlockerAddRow, shownBlockerId } from '@/components/BlockerAddRow';
import { Button } from '@/components/ui/button';
import { type MessageKey, t } from '@/i18n';
import { blockerErrorText } from '@/lib/blocker-errors';
import { editBlocker } from '@/lib/blockers-api';

type Kind = BlockerChange['kind'];

const MUTED = 'text-muted-foreground';
const NONE: ItemBlockers = { blockedBy: [], blocking: [] };
const KIND_LABEL: Record<Kind, MessageKey> = { blockedBy: 'blockers.blockedBy', blocking: 'blockers.blocking' };
const ADDING = 'add'; // the pending key of an add; a row's is `<kind>:<id>`, which never equals it

/** Whether a task shows the blockers section (#57): a hive task, or a source item whose relations were read (every GitHub item since #56).
 * A source that cannot relate reads none, and its route would answer blockers.unknownItem. */
export const hasBlockersSection = (task: Task): boolean => sourceOf(task) === HIVE_SOURCE || task.item.blockers !== undefined;

// A row's right side: fechada; else the stage of the task the ref names in the flow (same source, same id); else aberta
function refState(blocker: BlockerRef, source: string, tasks: readonly Task[]): string {
  if (blocker.state === 'closed') return t('blockers.closed');
  return tasks.find((other) => sourceOf(other) === source && other.item.id === blocker.id)?.stage ?? t('blockers.open');
}

// One edit at a time per section, and no optimistic change: the list stays as the state has it, so a refusal needs no rollback, only its copy
function useBlockerEdit(source: string, itemId: string) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const edit = async (key: string, change: BlockerChange): Promise<boolean> => {
    setPending(key);
    setError(undefined);
    try {
      await editBlocker(source, itemId, change);
      return true;
    } catch (err) {
      setError(blockerErrorText(err));
      return false;
    } finally {
      setPending(undefined);
    }
  };
  return { pending, error, edit };
}

interface RowProps { kind: Kind; blocker: BlockerRef; stateText: string; isPending: boolean; onRemove(): void }

function BlockerRow({ kind, blocker, stateText, isPending, onRemove }: RowProps) {
  const id = shownBlockerId(blocker.id);
  return (
    <div data-slot="blocker-row" className="flex min-w-0 items-center gap-2">
      <span className={`w-[84px] shrink-0 ${MUTED}`}>{t(KIND_LABEL[kind])}</span>
      <span className="shrink-0 font-medium">{id}</span>
      <span className={`min-w-0 flex-1 truncate ${blocker.state === 'closed' ? MUTED : ''}`} title={blocker.title}>{blocker.title}</span>
      <span className={`shrink-0 ${MUTED}`}>{stateText}</span>
      <Button type="button" variant="ghost" size="icon-xs" className={`size-5 ${MUTED}`} aria-label={t('blockers.remove', { id })} disabled={isPending} onClick={onRemove}>
        <XIcon />
      </Button>
    </div>
  );
}

/** The details panel's blockers (#57, handoff 3): one row per relation, blocked-by first, each with its ×; `+ add` opens the add row; a
 * refusal shows inline by its code. The list always comes from the state: an edit's answer is not kept, the state broadcast after the
 * route's dispatch redraws it. DetailPanel keys it by task, so an error or an open add row never follows another task. */
export function BlockersSection({ task, state }: { task: Task; state: State }) {
  const [isAdding, setIsAdding] = useState(false);
  const source = sourceOf(task);
  const { pending, error, edit } = useBlockerEdit(source, task.item.itemId);
  if (!hasBlockersSection(task)) return null;
  const blockers = task.item.blockers ?? NONE;
  const add = async (kind: Kind, ref: string): Promise<void> => {
    if (await edit(ADDING, { action: 'add', kind, ref })) setIsAdding(false);
  };
  const rows: [Kind, BlockerRef][] = [
    ...blockers.blockedBy.map((b): [Kind, BlockerRef] => ['blockedBy', b]), ...blockers.blocking.map((b): [Kind, BlockerRef] => ['blocking', b]),
  ];
  return (
    <section aria-label={t('blockers.title')} className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-center justify-between">
        <h4 className={`font-normal ${MUTED}`}>{t('blockers.title')}</h4>
        {!isAdding && <Button type="button" variant="ghost" size="xs" className="h-5 px-1 font-medium" onClick={() => setIsAdding(true)}>{t('blockers.add')}</Button>}
      </div>
      {rows.map(([kind, b]) => {
        const key = `${kind}:${b.id}`;
        return <BlockerRow key={key} kind={kind} blocker={b} stateText={refState(b, source, state.tasks)} isPending={pending === key} onRemove={() => void edit(key, { action: 'remove', kind, ref: b.id })} />;
      })}
      {isAdding && (
        <BlockerAddRow
          source={source} itemId={task.item.itemId} selfId={task.item.id} blockers={blockers} isBusy={pending !== undefined}
          onAdd={(kind, ref) => void add(kind, ref)} onCancel={() => setIsAdding(false)}
        />
      )}
      <p className={`leading-4 ${MUTED}`}>{t('blockers.note')}</p>
      {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </section>
  );
}
