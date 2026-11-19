import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { HIVE_SOURCE, sourceOf } from '../../tasks';
import type { BlockerChange, BlockerRef, Item, ItemBlockers, State, Task } from '../../types';
import { BlockerAddRow, shownBlockerId } from '@/components/BlockerAddRow';
import { DetailSection, SUMMARY_LINE } from '@/components/DetailSection';
import { hasRelationsSection, RelationsList } from '@/components/RelationsSection';
import { Button } from '@/components/ui/button';
import { useRefGrammar } from '@/hooks/use-ref-grammar';
import { useSectionEdit } from '@/hooks/use-section-edit';
import { type MessageKey, t } from '@/i18n';
import { editBlocker } from '@/lib/blockers-api';

type Kind = BlockerChange['kind'];

const MUTED = 'text-muted-foreground';
const NONE: ItemBlockers = { blockedBy: [], blocking: [] };
const KIND_LABEL: Record<Kind, MessageKey> = { blockedBy: 'blockers.blockedBy', blocking: 'blockers.blocking' };
const ADDING = 'add'; // the pending key of an add; a row's is `<kind>:<id>`, which never equals it

/** Whether a task shows the blockers section (#57): a hive task, or a source item whose relations were read (every GitHub item since #56).
 * A source that cannot relate reads none, and its route would answer blockers.unknownItem. */
export const hasBlockersSection = (task: Task): boolean => sourceOf(task) === HIVE_SOURCE || task.item.blockers !== undefined;

/** #424: each inherited blocker as the ⊘ line, the search row and this section name it, `#12 (via #7)`, nearest ancestor first. */
export const inheritedIds = (item: Pick<Item, 'inheritedBlockedBy'>): string[] =>
  (item.inheritedBlockedBy ?? []).map((b) => t('task.blockedVia', { id: `#${b.id}`, via: `#${b.via}` }));

// A row's right side: fechada; else the stage of the task the ref names in the flow (same source, same id); else aberta
export function refState(blocker: BlockerRef, source: string, tasks: readonly Task[]): string {
  if (blocker.state === 'closed') return t('blockers.closed');
  return tasks.find((other) => sourceOf(other) === source && other.item.id === blocker.id)?.stage ?? t('blockers.open');
}

export interface BlockerRowProps { label: string; blocker: BlockerRef; stateText: string; isPending: boolean; onRemove(): void }

/** One relation's row (#57): its label (the kind, or a relation's phrase, #829), the id, the title, the state and its ×. */
export function BlockerRow({ label, blocker, stateText, isPending, onRemove }: BlockerRowProps) {
  const id = shownBlockerId(blocker.id);
  return (
    <div data-slot="blocker-row" className="flex min-w-0 items-center gap-2">
      <span className={`w-[84px] shrink-0 ${MUTED}`}>{label}</span>
      <span className="shrink-0 font-medium">{id}</span>
      <span className={`min-w-0 flex-1 truncate ${blocker.state === 'closed' ? MUTED : ''}`} title={blocker.title}>{blocker.title}</span>
      <span className={`shrink-0 ${MUTED}`}>{stateText}</span>
      <Button type="button" variant="ghost" size="icon-xs" className={`size-5 ${MUTED}`} aria-label={t('blockers.remove', { id })} disabled={isPending} onClick={onRemove}>
        <XIcon />
      </Button>
    </div>
  );
}

const openIds = (refs: readonly BlockerRef[]): string[] => refs.filter((r) => r.state !== 'closed').map((r) => shownBlockerId(r.id));

/** relacionamentos' closed line (#958): only what still holds the task, the open blocked-by and every inherited blocker (they keep it from
 * starting too), then the open blocks. A closed ref says nothing more about the task. */
export function blockersSummary(item: Pick<Item, 'blockers' | 'inheritedBlockedBy'>): string {
  const { blockedBy, blocking } = item.blockers ?? NONE;
  const by = [...openIds(blockedBy), ...inheritedIds(item)];
  const head = by.length === 0 ? t('blockers.notBlocked') : `${t('blockers.blockedBy')} ${by.join(', ')}`;
  const blocks = openIds(blocking);
  return blocks.length === 0 ? head : `${head} · ${t('blockers.blocking')} ${blocks.join(', ')}`;
}

interface BlockerRowsProps { task: Task; state: State; pending: string | undefined; onRemove(key: string, change: BlockerChange): void }

// The task's own rows, blocked-by first, each with its ×; then #424's inherited lines, read-only: the relation lives on the ancestor
function BlockerRows({ task, state, pending, onRemove }: BlockerRowsProps) {
  const source = sourceOf(task);
  const blockers = task.item.blockers ?? NONE;
  const rows: [Kind, BlockerRef][] = [
    ...blockers.blockedBy.map((b): [Kind, BlockerRef] => ['blockedBy', b]), ...blockers.blocking.map((b): [Kind, BlockerRef] => ['blocking', b]),
  ];
  return (
    <>
      {rows.map(([kind, b]) => {
        const key = `${kind}:${b.id}`;
        return <BlockerRow key={key} label={t(KIND_LABEL[kind])} blocker={b} stateText={refState(b, source, state.tasks)} isPending={pending === key} onRemove={() => onRemove(key, { action: 'remove', kind, ref: b.id })} />;
      })}
      {inheritedIds(task.item).map((text) => (
        <p key={text} data-slot="inherited-blocker" className={`truncate ${MUTED}`}>{`${t('blockers.blockedBy')} ${text}`}</p>
      ))}
    </>
  );
}

/** relacionamentos (#57, #829, #958): the task's blockers and, on a Jira task, its other relations, as one section closed by default whose
 * summary counts only what blocks. `+ adicionar` (the blockers') is the last row; a refusal shows inline by its code. The list always comes
 * from the state. DetailPanel keys it by task, so an error, an open add row or the open state never follows another task. */
export function BlockersSection({ task, state }: { task: Task; state: State }) {
  const [isAdding, setIsAdding] = useState(false);
  const source = sourceOf(task);
  const grammar = useRefGrammar(source);
  const { pending, error, edit } = useSectionEdit((change: BlockerChange) => editBlocker(source, task.item.itemId, change), grammar);
  const hasBlockers = hasBlockersSection(task);
  if (!hasBlockers && !hasRelationsSection(task)) return null;
  const add = async (kind: Kind, ref: string): Promise<void> => {
    if (await edit(ADDING, { action: 'add', kind, ref })) setIsAdding(false);
  };
  return (
    <DetailSection name={t('blockers.title')} note={t('blockers.note')} summary={<span className={SUMMARY_LINE}>{blockersSummary(task.item)}</span>}>
      {hasBlockers && <BlockerRows task={task} state={state} pending={pending} onRemove={(key, change) => void edit(key, change)} />}
      {hasRelationsSection(task) && <RelationsList task={task} state={state} relations={task.item.relations ?? []} />}
      {hasBlockers && !isAdding && <div><Button type="button" variant="ghost" size="xs" className="h-5 px-1 font-medium" onClick={() => setIsAdding(true)}>{t('blockers.add')}</Button></div>}
      {hasBlockers && isAdding && (
        <BlockerAddRow
          source={source} itemId={task.item.itemId} selfId={task.item.id} blockers={task.item.blockers ?? NONE} isBusy={pending !== undefined} grammar={grammar}
          onAdd={(kind, ref) => void add(kind, ref)} onCancel={() => setIsAdding(false)}
        />
      )}
      {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </DetailSection>
  );
}
