import { XIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { BlockerChange, BlockerRef, ProjectItem } from '../../types';
import { BlockerAddRow, shownBlockerId } from '@/components/BlockerAddRow';
import { FieldCell } from '@/components/FieldCell';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { blockerErrorText } from '@/lib/blocker-errors';
import { editBlocker } from '@/lib/blockers-api';
import { openFirst } from '@/lib/project-columns';

const MUTED = 'text-muted-foreground';

// #274 as it is; a closed one as #521 · closed: the cell's text, its title and the popover say it the same way
const refLabel = (ref: BlockerRef): string =>
  (ref.state === 'closed' ? `${shownBlockerId(ref.id)} · ${t('blockers.closed')}` : shownBlockerId(ref.id));

/** The blocked-by cell's value (#61, handoff §4): the open refs first in foreground, then the closed ones in muted, comma-separated and
 * truncated, the whole list as its title; — with none. An absent list (a row that could not be read) is — too: the honest empty value. */
export function BlockedByList({ refs }: { refs?: BlockerRef[] }) {
  const shown = openFirst(refs ?? []);
  if (shown.length === 0) return <span className={MUTED}>—</span>;
  return (
    <span className="min-w-0 truncate" title={shown.map(refLabel).join(', ')}>
      {shown.map((ref, at) => (
        <Fragment key={ref.id}>
          {at > 0 && ', '}
          <span className={ref.state === 'closed' ? MUTED : 'text-foreground'}>{refLabel(ref)}</span>
        </Fragment>
      ))}
    </span>
  );
}

export interface BlockedByCellProps { source: string; item: ProjectItem; onRow(row: ProjectItem): void }

// One edit at a time and no optimistic change: the row changes only with the route's answer, so a refusal needs no rollback, only its copy
function useBlockedByEdit(source: string, item: ProjectItem, onRow: (row: ProjectItem) => void) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string>();
  const edit = async (action: BlockerChange['action'], ref: string): Promise<boolean> => {
    if (isPending) return false;
    setIsPending(true);
    setError(undefined);
    try {
      const { blockedBy } = await editBlocker(source, item.itemId, { action, kind: 'blockedBy', ref });
      onRow({ ...item, blockedBy });
      return true;
    } catch (err) {
      setError(blockerErrorText(err));
      return false;
    } finally {
      setIsPending(false);
    }
  };
  return { isPending, error, edit, clearError: () => setError(undefined) };
}

interface RefRowProps { blocker: BlockerRef; isBusy: boolean; onRemove(): void }

// One blocked-by ref in the popover: its id, its title truncated, · closed in muted on a closed one, and its ×
function RefRow({ blocker, isBusy, onRemove }: RefRowProps) {
  const id = shownBlockerId(blocker.id);
  const isClosed = blocker.state === 'closed';
  return (
    <div data-slot="blocked-by-row" className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 font-medium">{id}</span>
      <span className={`min-w-0 flex-1 truncate ${isClosed ? MUTED : ''}`} title={blocker.title}>{blocker.title}</span>
      {isClosed && <span className={`shrink-0 ${MUTED}`}>· {t('blockers.closed')}</span>}
      <Button type="button" variant="ghost" size="icon-xs" className={`size-5 ${MUTED}`} aria-label={t('blockers.remove', { id })} disabled={isBusy} onClick={onRemove}>
        <XIcon />
      </Button>
    </div>
  );
}

/** The Project's blocked-by cell (#61): the refs as a field cell that opens a popover with each ref and its ×, then the blockers add row
 * fixed to blocked by. Each edit goes through the blockers route (#56) and its answer replaces the row's blockedBy, with no Project re-read.
 * A refusal shows inline with the details panel's copy (#57); a landed add empties the field and keeps the popover open. The row ignores
 * clicks inside the portaled popover, and Escape there closes only the popover. */
export function BlockedByCell({ source, item, onRow }: BlockedByCellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [addKey, setAddKey] = useState(0); // a new key remounts the add row: its field empties after an add that landed
  const { isPending, error, edit, clearError } = useBlockedByEdit(source, item, onRow);
  const label = t('project.col.blockedBy');
  const onOpenChange = (next: boolean): void => {
    setIsOpen(next);
    if (!next) clearError();
  };
  const add = async (ref: string): Promise<void> => {
    if (await edit('add', ref)) setAddKey((k) => k + 1);
  };
  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <FieldCell aria-label={t('field.edit', { field: label })}><BlockedByList refs={item.blockedBy} /></FieldCell>
      </PopoverTrigger>
      {/* the add row's field keeps the focus its autoFocus gave it, not the first × */}
      <PopoverContent align="start" aria-label={label} className="flex w-[300px] flex-col gap-1.5 p-2 text-xs" onOpenAutoFocus={(e) => e.preventDefault()}>
        {openFirst(item.blockedBy ?? []).map((r) => <RefRow key={r.id} blocker={r} isBusy={isPending} onRemove={() => void edit('remove', r.id)} />)}
        <BlockerAddRow
          key={addKey} kind="blockedBy" source={source} itemId={item.itemId} selfId={item.id} blockers={{ blockedBy: item.blockedBy ?? [], blocking: [] }}
          isBusy={isPending} onAdd={(_kind, ref) => void add(ref)} onCancel={() => onOpenChange(false)}
        />
        {error !== undefined && <p role="alert" className="text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
