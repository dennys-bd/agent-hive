import { type ReactNode, useMemo, useState } from 'react';
import { hiveProject } from '../../hive-project';
import { HIVE_SOURCE } from '../../tasks';
import type { Flow, ProjectItem, ProjectView, SourceConfig, State, Task } from '../../types';
import { ColumnScroll, HeaderHandles, useColumnWidths } from '@/components/ColumnDividers';
import { FlowHeader } from '@/components/FlowHeader';
import { useIsFlowShown } from '@/components/MainDock';
import { ProjectColumnsMenu } from '@/components/ProjectColumnsMenu';
import { ProjectGroupMenu, ProjectGroupRow } from '@/components/ProjectGroupMenu';
import { ProjectRow, type RowTree } from '@/components/ProjectRow';
import { type ProjectState, useProject } from '@/hooks/use-project';
import { t } from '@/i18n';
import { gridTemplate, withWidths } from '@/lib/column-widths';
import { ACTION_WIDTH, columnLabel, DATES, defaultColumns, FIELD_KEY, hiveColumns, openFirst, type ProjectColumn, projectColumns } from '@/lib/project-columns';
import { defaultCollapsed, type GroupOption, groupItems, groupOptions, hiveGroups, type ProjectGroup } from '@/lib/project-groups';
import { PROJECT_KEYS, subIssueCount, type TreeRow, treeRows } from '@/lib/project-tree';
import { type ProjectSort, type ProjectViewPrefs, readProjectView, writeProjectView } from '@/lib/project-views';

const NOTHING_OPEN: ReadonlySet<string> = new Set();
const SUBBAR ='flex h-10 shrink-0 items-center gap-2 px-3.5 text-muted-foreground text-xs';

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

// The subbar (handoff 01, 01b, §5): what was read and how many of its rows have a task, in or out of the flow (#583), and the cap when the read
// stopped at it; lendo… while it reads. On the right, the menus that shape the view, once there is one
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

/** The parents unfolded (#584 decision 4): session state, not saved with the view; every parent starts folded. */
interface Tree { expanded: ReadonlySet<string>; onToggle(itemId: string): void }

// A line's place in the tree (#584): a parent that nests gets its count from the whole view, not its group (decision 9), and its fold
function rowTree({ item, depth, childCount }: TreeRow<ProjectItem>, view: ProjectView | undefined, flows: readonly Flow[], tree: Tree): RowTree {
  if (childCount === 0 || view === undefined) return { depth };
  return { depth, parent: { count: subIssueCount(item, view, flows), isExpanded: tree.expanded.has(item.itemId), onToggle: () => tree.onToggle(item.itemId) } };
}

interface ProjectGridProps {
  view?: ProjectView; visible: ProjectColumn[]; rows: ProjectItem[]; grouping?: Grouping; linked: Map<string, Task>; state: State; sort?: ProjectSort;
  onSort(key: string): void; onDrag(key: string, width?: number): void; onResize(key: string, width?: number): void; onGoTo(taskId: string): void;
  source: string; onRow(row: ProjectItem): void; onOpenIssue(item: ProjectItem, task?: Task): void;
  tree: Tree;
}

// The rows, each group's under its group row unless it is folded, nested under their parents (#584); ungrouped, the rows alone, nested too
function GridBody({ view, visible, rows, grouping, linked, state, onGoTo, source, onRow, onOpenIssue, tree }: Omit<ProjectGridProps, 'sort' | 'onSort' | 'onDrag' | 'onResize'>) {
  const columns = gridTemplate(visible, ACTION_WIDTH);
  const row = (line: TreeRow<ProjectItem>) => (
    <ProjectRow
      key={line.item.itemId} item={line.item} task={linked.get(line.item.itemId)} tree={rowTree(line, view, state.flows, tree)} visible={visible} columns={columns}
      state={state} onGoTo={onGoTo} source={source} statuses={view?.statuses ?? []} onRow={onRow} onOpenIssue={onOpenIssue}
    />
  );
  // #584 decision 7: every list nests on its own, each group's and the ungrouped one; a sub-issue sits in its root's group (#696), so a group's pill counts roots only
  const lines = (items: ProjectItem[]) => treeRows(items, tree.expanded, PROJECT_KEYS).map(row);
  if (grouping === undefined) return <tbody className="block">{lines(rows)}</tbody>;
  const { groups, collapsed, onToggle } = grouping;
  return (
    <tbody className="block">
      {groups.flatMap((g) => [
        <ProjectGroupRow key={`group:${g.key}`} group={g} isCollapsed={collapsed.includes(g.key)} onToggle={() => onToggle(g.key)} />,
        ...(collapsed.includes(g.key) ? [] : lines(g.items)),
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
  // the hive's statuses are stages: a stage named Done holds live tasks, so nothing starts folded there
  const collapsed = source === HIVE_SOURCE ? [] : defaultCollapsed(view);
  const prefs = saved ?? { groupBy: 'status', collapsed,columns: defaultColumns(columns), sort: null, widths: {}, blockedByShown: true as const };
  const update = (patch: Partial<ProjectViewPrefs>): void => {
    const next = { ...prefs, ...patch };
    setSaved(next);
    writeProjectView(source, next);
  };
  return { prefs, update };
}

// The groups of the rows when the saved grouping is one the view still offers; a field gone from the project leaves the rows ungrouped. The
// hive's status groups are its stages, sem fluxo last (#583 decision 7)
function groupingOf(rows: ProjectItem[], view: ProjectView | undefined, options: GroupOption[], { prefs, update }: Prefs, isHive: boolean): Grouping | undefined {
  const option = options.find((o) => o.key === prefs.groupBy);
  if (view === undefined || option === undefined) return undefined;
  const { collapsed } = prefs;
  const onToggle = (key: string): void => update({ collapsed: collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key] });
  return { groups: isHive ? hiveGroups(rows, view) : groupItems(rows, option, view), collapsed, onToggle };
}

export interface ProjectTableProps { state: State; source: SourceConfig | typeof HIVE_SOURCE; onGoTo(taskId: string): void; onOpenIssue(item: ProjectItem, task?: Task): void }

interface TableViewProps extends ProjectTableProps { project: ProjectState; onRefresh(): Promise<unknown>; replaceRow(row: ProjectItem): void }

// The table under the source header (#756, #583): the view's rows in the shape saved for the source (hive included), the bar and the grid. The
// hive's columns are fixed (decision 3): no columns menu, and its group menu offers status alone
function TableView({ state, source, onGoTo, onOpenIssue, project, onRefresh, replaceRow }: TableViewProps) {
  const name = typeof source === 'string' ? source : source.name;
  const isHive = name === HIVE_SOURCE;
  const [search, setSearch] = useState('');
  // #584 decision 4: the table is not remounted between sources, so the unfolded parents belong to one source and fold again on a switch
  const [open, setOpen] = useState<{ source: string; ids: ReadonlySet<string> }>(() => ({ source: name, ids: NOTHING_OPEN }));
  if (open.source !== name) setOpen({ source: name, ids: NOTHING_OPEN }); // React's reset-on-prop-change during render, no effect
  const expanded = open.source === name ? open.ids : NOTHING_OPEN;
  const onToggleRow = (itemId: string): void =>
    setOpen({ source: name, ids: expanded.has(itemId) ? new Set([...expanded].filter((id) => id !== itemId)) : new Set([...expanded, itemId]) });
  const isShown = useIsFlowShown();
  const view = project.kind === 'view' ? project.view : undefined;
  const columns = view === undefined ? [] : isHive ? hiveColumns(view) : projectColumns(view);
  const shape = usePrefs(name, view, columns);
  const { prefs, update } = shape;
  const shownKeys = isHive ? columns.map((c) => c.key) : prefs.columns;
  const options = view === undefined ? [] : groupOptions(view).filter((o) => !isHive || o.key === 'status');
  const linked = tasksByItem(state.tasks);
  const term = search.trim().toLowerCase();
  // a sort by a column since hidden is dropped: no header could show it
  const { sort } = prefs;
  const shownSort = sort !== null && (sort.key === 'issue' || shownKeys.includes(sort.key)) ? sort : undefined;
  const rows = view === undefined ? [] : sortedRows(view.items.filter((item) => matches(item, term)), shownSort, view);
  // a new column sorts ascending; the sorted one again reverses
  const onSort = (key: string): void => update({ sort: { key, desc: sort?.key === key && !sort.desc } });
  // a drag draws its width live and saves it on release; a double-click drops the column's entry, back to its kind's
  const { widths, onDrag, onResize } = useColumnWidths(prefs.widths, (next) => update({ widths: next }));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} mode={{ kind: 'source', source }} search={search} onSearch={setSearch} isShown={isShown} onRefresh={onRefresh} />
      <Subbar project={project} linked={linked}>
        <ProjectGroupMenu options={options} groupBy={prefs.groupBy} onChange={(groupBy) => update({ groupBy })} />
        {!isHive && <ProjectColumnsMenu columns={columns} visible={prefs.columns} onChange={(next) => update({ columns: next })} />}
      </Subbar>
      {project.kind === 'error'
        ? <p className="px-3.5 text-muted-foreground text-xs">{project.message}</p>
        : (
          <ProjectGrid
            view={view} visible={withWidths(columns.filter((c) => shownKeys.includes(c.key)), widths)} rows={rows} grouping={groupingOf(rows, view, options, shape, isHive)} linked={linked} state={state} sort={shownSort}
            onSort={onSort} onDrag={onDrag} onResize={onResize} onGoTo={onGoTo} source={name} onRow={replaceRow} onOpenIssue={onOpenIssue}
            tree={{ expanded, onToggle: onToggleRow }}
          />
        )}
    </div>
  );
}

const NOTHING_TO_READ = (): Promise<void> => Promise.resolve(); // #583 decision 2: the hive's view is the live state's: atualizar has nothing to re-read
const NO_ROW = (): void => undefined; // the hive's cells write through the task routes; the next state event redraws the row

// #583 decision 2: the hive's view from the live state, the same function GET /sources/hive/project answers with, so the two never disagree.
// No useProject: it would read that endpoint
function HiveTable(props: ProjectTableProps) {
  const { state } = props;
  // one view per state: rows stay the same objects between renders that did not change the state
  const project = useMemo((): ProjectState => ({ kind: 'view', view: hiveProject(state) }), [state]);
  return <TableView {...props} project={project} onRefresh={NOTHING_TO_READ} replaceRow={NO_ROW} />;
}

function SourceTable(props: ProjectTableProps & { source: SourceConfig }) {
  const { project, reload, replaceRow } = useProject(props.source.name);
  return <TableView {...props} project={project} onRefresh={() => reload({ fresh: true })} replaceRow={replaceRow} />;
}

/** A source's native view (#756, handoff 01, 01b, §5): every issue of its project, unfiltered, as a table of issue, the visible columns and the
 * task column. Read on opening and on atualizar, never polled; the search lives and dies with the tab, the grouping, columns, sort and widths
 * are saved per source. A failed read with nothing cached leaves its reason in place of the table. The hive source (#583) shows its own tasks
 * from the state, in five fixed columns. */
export function ProjectTable(props: ProjectTableProps) {
  const { source } = props;
  return typeof source === 'string' ? <HiveTable {...props} /> : <SourceTable {...props} source={source} />;
}
