import { type ReactNode, useState } from 'react';
import type { ProjectItem, ProjectView, SourceConfig, State, Task } from '../../types';
import { ColumnScroll, HeaderHandles, useColumnWidths } from '@/components/ColumnDividers';
import { FlowHeader, type SourceTabs } from '@/components/FlowHeader';
import { useIsFlowShown } from '@/components/MainDock';
import { ProjectColumnsMenu } from '@/components/ProjectColumnsMenu';
import { ProjectGroupMenu, ProjectGroupRow } from '@/components/ProjectGroupMenu';
import { ProjectRow } from '@/components/ProjectRow';
import { type ProjectState, useProject } from '@/hooks/use-project';
import { t } from '@/i18n';
import { gridTemplate, withWidths } from '@/lib/column-widths';
import { ACTION_WIDTH, columnLabel, DATES, defaultColumns, FIELD_KEY, openFirst, type ProjectColumn, projectColumns } from '@/lib/project-columns';
import { defaultCollapsed, groupItems, groupOptions, type ProjectGroup } from '@/lib/project-groups';
import { type ProjectSort, type ProjectViewPrefs, readProjectView, writeProjectView } from '@/lib/project-views';

const SUBBAR = 'flex h-10 shrink-0 items-center gap-2 px-3.5 text-muted-foreground text-xs';

// What a column sorts by: the number, the Status option's place, the first label or assignee, the first PR's number, an ISO date, a field's value, the first blocker's number (#61)
function sortValue(item: ProjectItem, key: string, view: ProjectView): string | number | undefined {
  switch (key) {
    case 'issue': return Number(item.id);
    case 'status': {
      const at = view.statuses.findIndex((s) => s.name === item.status);
      return at < 0 ? undefined : at;
    }
    case 'labels': return item.labels[0];
    case 'assignee': return item.assignees[0];
    case 'pr': return item.pullRequests[0]?.number;
    case 'created': case 'updated': case 'closed': return item[DATES[key]];
    case 'blockedBy': {
      // #61: the first ref the cell shows; one of another repository (owner/repo#n) or none sorts last, on purpose
      const first = openFirst(item.blockedBy ?? [])[0]?.id;
      return first !== undefined && /^\d+$/.test(first) ? Number(first) : undefined;
    }
    default: {
      const name = key.slice(FIELD_KEY.length);
      return Object.hasOwn(item.fields, name) ? item.fields[name] : undefined;
    }
  }
}

// Numbers as numbers, text as people read it (case-insensitive, digits by value); an empty cell sorts after any value
function compare(a: string | number | undefined, b: string | number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function sortedRows(items: ProjectItem[], sort: ProjectSort | undefined, view: ProjectView): ProjectItem[] {
  if (sort === undefined) return items; // the project's own order
  const sign = sort.desc ? -1 : 1;
  return [...items].sort((a, b) => sign * compare(sortValue(a, sort.key, view), sortValue(b, sort.key, view)));
}

// The search (#756): the title or #number, case-insensitive
const matches = (item: ProjectItem, term: string): boolean => term === '' || item.title.toLowerCase().includes(term) || `#${item.id}`.includes(term);

// The task each row belongs to (#756): the task the poll listed from the issue, else the Hive task created from it (its origin). The listed
// task wins: a copy made before the issue passed the filter stays a separate task, the Hive does not merge them
function tasksByItem(tasks: Task[]): Map<string, Task> {
  const origins = tasks.flatMap((c): [string, Task][] => (c.item.origin === undefined ? [] : [[c.item.origin, c]]));
  return new Map([...origins, ...tasks.map((c): [string, Task] => [c.item.itemId, c])]);
}

interface HeadCellProps { id: string; label: string; sort?: ProjectSort; onSort(key: string): void }

function HeadCell({ id, label, sort, onSort }: HeadCellProps) {
  const direction = sort?.key === id ? (sort.desc ? 'descending' : 'ascending') : undefined;
  return (
    <th aria-sort={direction} className="min-w-0 text-left font-normal">
      <button type="button" className={`max-w-full truncate hover:text-foreground ${direction ? 'text-foreground' : ''}`} onClick={() => onSort(id)}>
        {label}{direction === undefined ? '' : direction === 'ascending' ? ' ↑' : ' ↓'}
      </button>
    </th>
  );
}

// The subbar (handoff 01, 01b): what was read and how much of it is in the flow, and the cap when the read stopped at it; lendo… while it
// reads. On the right, the menus that shape the view, once there is one
function Subbar({ project, linked, children }: { project: ProjectState; linked: Map<string, Task>; children: ReactNode }) {
  if (project.kind !== 'view') return <div className={SUBBAR}>{project.kind === 'loading' ? t('project.loading') : null}</div>;
  const { items, truncated } = project.view;
  const counted = t('project.count', { n: items.length, m: items.filter((item) => linked.has(item.itemId)).length });
  return (
    <div className={SUBBAR}>
      <span className="min-w-0 flex-1 truncate">{truncated ? `${counted} · ${t('project.truncated', { n: items.length })}` : counted}</span>
      {children}
    </div>
  );
}

/** The groups shown (#756, handoff 01b), the ones folded and how a group row folds or unfolds. */
interface Grouping { groups: ProjectGroup[]; collapsed: string[]; onToggle(key: string): void }

interface ProjectGridProps {
  view?: ProjectView; visible: ProjectColumn[]; rows: ProjectItem[]; grouping?: Grouping; linked: Map<string, Task>; state: State; sort?: ProjectSort;
  onSort(key: string): void; onDrag(key: string, width?: number): void; onResize(key: string, width?: number): void; onGoTo(taskId: string): void;
  source: string; onRow(row: ProjectItem): void; onOpenIssue(item: ProjectItem, task?: Task): void;
}

// The rows, each group's under its group row unless it is folded; ungrouped, the rows alone
function GridBody({ view, visible, rows, grouping, linked, state, onGoTo, source, onRow, onOpenIssue }: Omit<ProjectGridProps, 'sort' | 'onSort' | 'onDrag' | 'onResize'>) {
  const columns = gridTemplate(visible, ACTION_WIDTH);
  const row = (item: ProjectItem) => (
    <ProjectRow
      key={item.itemId} item={item} task={linked.get(item.itemId)} visible={visible} columns={columns} state={state} onGoTo={onGoTo}
      source={source} statuses={view?.statuses ?? []} onRow={onRow} onOpenIssue={onOpenIssue}
    />
  );
  if (grouping === undefined) return <tbody className="block">{rows.map(row)}</tbody>;
  const { groups, collapsed, onToggle } = grouping;
  return (
    <tbody className="block">
      {groups.flatMap((g) => [
        <ProjectGroupRow key={`group:${g.key}`} group={g} isCollapsed={collapsed.includes(g.key)} onToggle={() => onToggle(g.key)} />,
        ...(collapsed.includes(g.key) ? [] : g.items.map(row)),
      ])}
    </tbody>
  );
}

// The table (handoff 01, 01b, item 4): a 34px header on card that stays as the body scrolls, 40px rows, a handle on each column's left edge
// and its divider down to the footer, then the footer's X de N and the hint that explains the table. The box fills the pane, so the dividers reach the footer
function ProjectGrid(props: ProjectGridProps) {
  const { view, visible, rows, sort, onSort, onDrag, onResize } = props;
  return (
    <div className="mx-3.5 mb-3.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border">
      <ColumnScroll columns={visible} trailing={ACTION_WIDTH} hasRows={rows.length > 0}>
        <table className="block w-full">
          <thead className="sticky top-0 z-10 block">
            <tr className="relative grid h-[34px] items-center gap-3 border-b bg-card px-3 text-muted-foreground text-xs" style={{ gridTemplateColumns: gridTemplate(visible, ACTION_WIDTH) }}>
              <HeadCell id="issue" label={t('project.col.issue')} sort={sort} onSort={onSort} />
              {visible.map((c) => <HeadCell key={c.key} id={c.key} label={columnLabel(c)} sort={sort} onSort={onSort} />)}
              <th />
              <HeaderHandles columns={visible} trailing={ACTION_WIDTH} labelOf={columnLabel} onDrag={onDrag} onResize={onResize} />
            </tr>
          </thead>
          <GridBody {...props} />
        </table>
      </ColumnScroll>
      <div className="flex h-8 shrink-0 items-center justify-between border-t px-3 text-muted-foreground text-xs">
        <span>{t('project.footer.count', { x: rows.length, n: view?.items.length ?? 0 })}</span>
        <span>{t('project.footer.hint')}</span>
      </div>
    </div>
  );
}

// The source's view (handoff 01b, addendum 2): what it saved, else the defaults: grouped by status with Done folded, the default columns at
// their kinds' widths, the project's order. The first change saves the whole of it for the source
interface Prefs { prefs: ProjectViewPrefs; update(patch: Partial<ProjectViewPrefs>): void }
function usePrefs(source: string, view: ProjectView | undefined, columns: ProjectColumn[]): Prefs {
  const [saved, setSaved] = useState(() => readProjectView(source));
  const prefs = saved ?? { groupBy: 'status', collapsed: defaultCollapsed(view), columns: defaultColumns(columns), sort: null, widths: {}, blockedByShown: true as const };
  const update = (patch: Partial<ProjectViewPrefs>): void => {
    const next = { ...prefs, ...patch };
    setSaved(next);
    writeProjectView(source, next);
  };
  return { prefs, update };
}

// The groups of the rows when the saved grouping is one the view still offers; a field gone from the project leaves the rows ungrouped
function groupingOf(rows: ProjectItem[], view: ProjectView | undefined, { prefs, update }: Prefs): Grouping | undefined {
  const option = view === undefined ? undefined : groupOptions(view).find((o) => o.key === prefs.groupBy);
  if (view === undefined || option === undefined) return undefined;
  const { collapsed } = prefs;
  const onToggle = (key: string): void => update({ collapsed: collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key] });
  return { groups: groupItems(rows, option, view), collapsed, onToggle };
}

export interface ProjectTableProps { state: State; source: SourceConfig; tabs: SourceTabs; onGoTo(taskId: string): void; onOpenIssue(item: ProjectItem, task?: Task): void }

/** A source's native view (#756, handoff 01, 01b): every issue of its project, unfiltered, as a table of issue, the visible columns and the
 * action. Read on opening and on atualizar, never polled; the search lives and dies with the tab, the grouping, columns, sort and widths
 * are saved per source. A failed read with nothing cached leaves its reason in place of the table. */
export function ProjectTable({ state, source, tabs, onGoTo, onOpenIssue }: ProjectTableProps) {
  const { project, reload, replaceRow } = useProject(source.name);
  const [search, setSearch] = useState('');
  const isShown = useIsFlowShown();
  const view = project.kind === 'view' ? project.view : undefined;
  const columns = view === undefined ? [] : projectColumns(view);
  const shape = usePrefs(source.name, view, columns);
  const { prefs, update } = shape;
  const linked = tasksByItem(state.tasks);
  const term = search.trim().toLowerCase();
  // a sort by a column since hidden is dropped: no header could show it
  const { sort } = prefs;
  const shownSort = sort !== null && (sort.key === 'issue' || prefs.columns.includes(sort.key)) ? sort : undefined;
  const rows = view === undefined ? [] : sortedRows(view.items.filter((item) => matches(item, term)), shownSort, view);
  // a new column sorts ascending; the sorted one again reverses
  const onSort = (key: string): void => update({ sort: { key, desc: sort?.key === key && !sort.desc } });
  // a drag draws its width live and saves it on release; a double-click drops the column's entry, back to its kind's
  const { widths, onDrag, onResize } = useColumnWidths(prefs.widths, (next) => update({ widths: next }));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} source={source.name} tasks={[]} search={search} onSearch={setSearch} isShown={isShown} tabs={tabs} onRefresh={() => reload({ fresh: true })} />
      <Subbar project={project} linked={linked}>
        <ProjectGroupMenu options={view === undefined ? [] : groupOptions(view)} groupBy={prefs.groupBy} onChange={(groupBy) => update({ groupBy })} />
        <ProjectColumnsMenu columns={columns} visible={prefs.columns} onChange={(next) => update({ columns: next })} />
      </Subbar>
      {project.kind === 'error'
        ? <p className="px-3.5 text-muted-foreground text-xs">{project.message}</p>
        : (
          <ProjectGrid
            view={view} visible={withWidths(columns.filter((c) => prefs.columns.includes(c.key)), widths)} rows={rows} grouping={groupingOf(rows, view, shape)} linked={linked} state={state} sort={shownSort}
            onSort={onSort} onDrag={onDrag} onResize={onResize} onGoTo={onGoTo} source={source.name} onRow={replaceRow} onOpenIssue={onOpenIssue}
          />
        )}
    </div>
  );
}
