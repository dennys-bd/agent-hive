import type { KeyboardEvent, MouseEvent } from 'react';
import { prsOf } from '../../activities';
import { isReadOnly } from '../../field-values';
import { prNumber } from '../../pull-requests';
import { resolveWorkspace } from '../../tasks';
import type { ItemField, ProjectField, ProjectItem, ProjectPr, ProjectView, Signal, State, Task } from '../../types';
import type { ReactNode } from 'react';
import { BlockedByCell } from '@/components/BlockedByCell';
import { FieldEditor } from '@/components/FieldEditor';
import { ProjectCreatePopover } from '@/components/ProjectCreatePopover';
import { ProjectStatusSelect } from '@/components/ProjectStatusSelect';
import { Button } from '@/components/ui/button';
import type { FieldAnswer } from '@/hooks/use-item-fields';
import { statusText, t } from '@/i18n';
import { type DateKey, DATES, type ProjectColumn } from '@/lib/project-columns';
import { STATUS_TEXT } from '@/lib/status';
import { taskState } from '@/lib/task-state';
import { workspaceColor } from '@/lib/workspace-color';

// A PR's checks as handoff 01 marks them, in the status colours their signal stands for
const CHECK: Record<Signal, { mark: string; tone: string }> = {
  green: { mark: '✓', tone: 'text-working' }, yellow: { mark: '●', tone: 'text-waiting' }, red: { mark: '✕', tone: 'text-destructive' },
};
const CHIP = 'max-w-full shrink-0 truncate rounded-[4px] border px-1.5 text-muted-foreground text-xs';

const ASSIGNEES = 'Assignees'; // GitHub's built-in field: the view shows it as a fixed column, never by name (#686)
const LABELS = 'Labels'; // GitHub's built-in field, a fixed column as the assignees (#60)

// A field column's value as its editor takes it (#686): the options the view knows; a milestone's, an issue type's or the assignees' are read
// when the menu opens
function itemField(field: ProjectField, item: ProjectItem): ItemField {
  const value = Object.hasOwn(item.fields, field.name) ? item.fields[field.name] : null;
  return { name: field.name, type: field.type, value, ...(field.options === undefined ? {} : { options: field.options }), ...(isReadOnly(field.type) ? { readOnly: true as const } : {}) };
}

/** A row's PRs (#698, #757): a task's are its own, the ones its workers opened; any other row's are the PRs the source says close the issue. */
export function taskPrs(pullRequests: ProjectPr[], task: Task | undefined, state: State): ProjectPr[] {
  if (task === undefined) return pullRequests;
  return prsOf(state, task.item.itemId).map((pr) => ({ number: Number(prNumber(pr.url)), url: pr.url, state: pr.state }));
}

/** The PR cell (handoff 01, 02): one PR as its number in review blue and its checks' mark, a draft as #n draft in muted (#757); several as
 * how many merged; none as —. */
export function PrCell({ prs }: { prs: ProjectPr[] }) {
  const [pr] = prs;
  if (pr === undefined) return <span className="text-muted-foreground">—</span>;
  if (prs.length > 1) {
    return <span className="truncate text-muted-foreground text-xs">⇅ {t('prs.mergedShort', { x: prs.filter((p) => p.state === 'merged').length, y: prs.length })}</span>;
  }
  if (pr.draft) return <span className="truncate text-muted-foreground text-xs">{t('repos.prDraft', { n: pr.number })}</span>;
  const check = pr.checks === undefined ? undefined : CHECK[pr.checks];
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-review">#{pr.number}</span>
      {check && <span className={check.tone}>{check.mark}</span>}
    </span>
  );
}

// The issue cell (handoff 01): the workspace square (the task's, else the issue's hint when the Comb has it), the number, the title and,
// on a task, its session status in its colour
function IssueCell({ item, task, state }: { item: ProjectItem; task?: Task; state: State }) {
  const hint = item.workspaceHint !== undefined && state.workspaces.includes(item.workspaceHint) ? item.workspaceHint : undefined;
  const workspace = task ? resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks) : hint;
  const status = task ? taskState(task, state) : 'empty';
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={workspace === undefined ? undefined : { background: workspaceColor(workspace) }} />
      <span className="shrink-0 font-medium">#{item.id}</span>
      <span className="min-w-0 truncate">{item.title}</span>
      {status !== 'empty' && <span className={`shrink-0 text-xs ${STATUS_TEXT[status]}`}>{statusText(status)}</span>}
    </span>
  );
}

// resp. (handoff 01): the first assignee's initials on a 20px avatar, every login in its title; nobody, a dashed one
export function AssigneeCell({ logins }: { logins: string[] }) {
  const [first] = logins;
  if (first === undefined) return <span aria-hidden="true" className="block size-5 rounded-full border border-dashed" />;
  return <span title={logins.join(', ')} className="flex size-5 items-center justify-center rounded-full border font-semibold text-[10px]">{first.slice(0, 2).toUpperCase()}</span>;
}

const pad = (n: number): string => String(n).padStart(2, '0');

// An ISO day as dd/mm; a timestamp (an issue's own dates) by its local day; anything else as it came
function dayMonth(iso: string): string {
  const at = iso.includes('T') ? new Date(iso) : undefined;
  if (at !== undefined && !Number.isNaN(at.getTime())) return `${pad(at.getDate())}/${pad(at.getMonth() + 1)}`;
  const [, month, day] = iso.split('-');
  return day === undefined ? iso : `${day.slice(0, 2)}/${month}`;
}

// A project field's value by its kind (#756): single-select and issue type as a chip, number right-aligned, date dd/mm, the rest as text
// with an ellipsis. A kind the Hive does not know with no value reads —; any other empty cell stays blank, as before addendum 2
function FieldDisplay({ field, value }: { field: ProjectField; value?: string | number }) {
  if (value === undefined) return field.type === 'other' ? <span className="text-muted-foreground">—</span> : null;
  if (field.type === 'singleSelect' || field.type === 'issueType') return <span className={CHIP}>{value}</span>;
  if (field.type === 'number') return <span className="w-full text-right tabular-nums">{value}</span>;
  if (field.type === 'date') return <span className="tabular-nums">{dayMonth(String(value))}</span>;
  return <span className="truncate" title={String(value)}>{value}</span>;
}

export interface ProjectRowProps {
  item: ProjectItem; task?: Task; visible: ProjectColumn[]; columns: string; state: State; onGoTo(taskId: string): void;
  source: string; statuses: ProjectView['statuses']; onRow(row: ProjectItem): void; // #756, #686: a cell's write answers its re-read row, which replaces this one
  onOpenIssue(item: ProjectItem, task?: Task): void; // #757: the issue's page
}

// A visible column's cell (#756): its class and what it shows; a field's, the labels' and the assignees' through their editor (#686, #60), the blocked-by refs through theirs (#61)
function cellOf(column: ProjectColumn, { item, task, state, source, statuses, onRow }: ProjectRowProps): { className?: string; cell: ReactNode } {
  const { field } = column;
  const written = (answer: FieldAnswer): void => onRow(answer.row);
  if (field !== undefined) {
    const shown = <FieldDisplay field={field} value={Object.hasOwn(item.fields, field.name) ? item.fields[field.name] : undefined} />;
    return { className: 'flex min-w-0', cell: <FieldEditor itemId={item.itemId} field={itemField(field, item)} display={shown} onWritten={written} /> };
  }
  if (Object.hasOwn(DATES, column.key)) {
    const at = item[DATES[column.key as DateKey]];
    return { className: 'min-w-0', cell: at === undefined ? null : <span className="tabular-nums">{dayMonth(at)}</span> };
  }
  switch (column.key) {
    case 'status':
      return { className: 'min-w-0', cell: <ProjectStatusSelect source={source} itemId={item.itemId} status={item.status} statuses={statuses} onRow={onRow} /> };
    case 'labels': {
      const labels: ItemField = { name: LABELS, type: 'labels', value: item.labels };
      const chips = item.labels.map((label) => <span key={label} className={CHIP}>{label}</span>);
      return { className: 'flex min-w-0', cell: <FieldEditor itemId={item.itemId} field={labels} display={chips} onWritten={written} /> };
    }
    case 'assignee': {
      const assignees: ItemField = { name: ASSIGNEES, type: 'assignees', value: item.assignees };
      return { cell: <FieldEditor itemId={item.itemId} field={assignees} display={<AssigneeCell logins={item.assignees} />} onWritten={written} /> };
    }
    case 'blockedBy':
      return { className: 'flex min-w-0', cell: <BlockedByCell source={source} item={item} onRow={onRow} /> };
    default: return { className: 'min-w-0', cell: <PrCell prs={taskPrs(item.pullRequests, task, state)} /> };
  }
}

/** One issue of the native view (#756, handoff 01). Any row opens its issue's page (#757); fluxo › goes to its task; ⇧↵ on the focused
 * row opens the issue on GitHub. */
export function ProjectRow(props: ProjectRowProps) {
  const { item, task, visible, columns, state, onGoTo, source, onOpenIssue } = props;
  // a click on a cell's own control or input (#686), or inside a menu or popover it portaled out (still bubbling through React), is not the row's
  const onClick = (e: MouseEvent<HTMLTableRowElement>): void => {
    const target = e.target as Element;
    if (e.currentTarget.contains(target) && !target.closest('button, a, input')) onOpenIssue(item, task);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>): void => {
    if (e.key !== 'Enter' || !e.shiftKey || e.target !== e.currentTarget) return;
    e.preventDefault();
    window.open(item.url, '_blank', 'noreferrer');
  };
  return (
    <tr
      tabIndex={0}
      onClick={onClick} onKeyDown={onKeyDown} style={{ gridTemplateColumns: columns }}
      className="grid h-10 cursor-pointer items-center gap-3 border-b px-3 text-[13px] outline-none hover:bg-muted focus:bg-muted"
    >
      <td className="min-w-0"><IssueCell item={item} task={task} state={state} /></td>
      {visible.map((column) => {
        const { className, cell } = cellOf(column, props);
        return <td key={column.key} className={className}>{cell}</td>;
      })}
      {/* fluxo › to the issue's task, fluxo… for an issue kept out; one passing the filter in an uncited column has none: its way in is the Status (#756) */}
      <td className="flex justify-end">
        {task
          ? <Button type="button" size="xs" variant="outline" onClick={() => onGoTo(task.item.itemId)}>{t('project.action.goto')}</Button>
          : item.out && <ProjectCreatePopover item={item} source={source} state={state} onCreated={onGoTo} />}
      </td>
    </tr>
  );
}
