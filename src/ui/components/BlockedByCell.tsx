import { Fragment } from 'react';
import type { BlockerRef, ProjectItem } from '../../types';
import { shownBlockerId } from '@/components/BlockerAddRow';
import { FieldCell } from '@/components/FieldCell';
import { t } from '@/i18n';
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

/** The Project's blocked-by cell (#61): an editable field cell over the issue's blocked-by refs. */
export function BlockedByCell({ item }: BlockedByCellProps) {
  return <FieldCell aria-label={t('field.edit', { field: t('project.col.blockedBy') })}><BlockedByList refs={item.blockedBy} /></FieldCell>;
}
