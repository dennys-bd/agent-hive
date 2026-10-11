import { Fragment, type ReactNode } from 'react';
import { STATUS } from '../../field-values';
import type { ItemField, Task } from '../../types';
import { FieldEditor } from '@/components/FieldEditor';
import type { FieldAnswer } from '@/hooks/use-item-fields';
import { t } from '@/i18n';

const MUTED = 'text-muted-foreground';
const CHIP = 'max-w-full shrink-0 truncate rounded-[4px] border px-1.5 text-muted-foreground text-xs'; // ProjectRow's label chip (#60)

// The handoff's order (#65): Status, the labels, the assignees, then the rest in the project's order; sort is stable
const rank = (f: ItemField): number => (f.name === STATUS ? 0 : f.type === 'labels' ? 1 : f.type === 'assignees' ? 2 : 3);

// The labels as the table's chips; Status with the task's stage after it; anything else FieldEditor's own text (undefined)
function displayOf(field: ItemField, stage: string | undefined): ReactNode {
  if (field.type === 'labels' && Array.isArray(field.value) && field.value.length > 0) {
    return field.value.map((label) => <span key={label} className={CHIP}>{label}</span>);
  }
  if (field.name !== STATUS || stage === undefined) return undefined;
  return (
    <>
      <span className="truncate">{field.value === null ? '—' : String(field.value)}</span>
      <span className={`shrink-0 ${MUTED}`}>{t('issue.box.stage', { x: stage })}</span>
    </>
  );
}

export interface IssueFieldsBoxProps {
  itemId: string; source: string; fields: ItemField[];
  task?: Task; // only a task this item's Status moves: its stage beside Status, and the note
  onWritten(answer: FieldAnswer): void;
}

/** this issue (#65, handoff 7): the source's fields of the issue's item as the Project table's editable cells, each written at once through
 * its FieldEditor. A Status write moves the task through the route's own re-read (#686), so the note says so. */
export function IssueFieldsBox({ itemId, source, fields, task, onWritten }: IssueFieldsBoxProps) {
  const ordered = [...fields].sort((a, b) => rank(a) - rank(b));
  return (
    <section aria-label={t('issue.box.title')} className="flex flex-col gap-3 rounded-lg border p-3 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{t('issue.box.title')}</span>
        <span className={`truncate ${MUTED}`}>{t('issue.box.fields', { source })}</span>
      </div>
      <dl className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
        {ordered.map((field) => (
          <Fragment key={field.name}>
            <dt className={`truncate ${MUTED}`}>{field.type === 'assignees' ? t('issue.props.assignee') : field.name}</dt>
            <dd className="flex min-w-0"><FieldEditor itemId={itemId} field={field} display={displayOf(field, task?.stage)} onWritten={onWritten} /></dd>
          </Fragment>
        ))}
      </dl>
      {task && <p className={MUTED}>{t('issue.box.note')}</p>}
    </section>
  );
}
