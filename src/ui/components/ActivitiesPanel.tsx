import { ChevronDownIcon, GitBranchIcon, PlusIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { taskTotals } from '../../record-kit';
import { taskLabel, resolveWorkspace } from '../../tasks';
import { displayBinding } from '../../shortcuts';
import type { Task, Session, Worker, Stage, Status } from '../../types';
import { ActivityGroupList } from '@/components/ActivityGroups';
import { useBranches } from '@/components/QuickDialogs';
import { LocalSessionLines, TaskSessionLine } from '@/components/SessionLines';
import { StatusWord } from '@/components/StatusWord';
import { TerminalLines } from '@/components/TerminalLines';
import { WorkspaceMenu } from '@/components/WorkspaceMenu';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { type Activity, isTask, type LocalActivity, localKey, type TaskActivity } from '@/lib/activities';
import { useWorkspaceView, type WorkspaceView } from '@/lib/activities-view';
import { groupActivities, workspaceSummary } from '@/lib/activity-groups';
import { binding, isMac } from '@/lib/shortcut-bindings';
import { compact } from '@/lib/usage';
import { useWorktreeStates, type WorktreeState, worktreeText } from '@/lib/worktree-states';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

/** What the sidebar reaches beyond its list (redesign 03): the Start dialog (in a workspace from its +), Settings on workspaces, and each
 * activity's right-click menu, a task's and a local activity's (#590) (absent in the terminal's harness: the row alone). */
export interface ActivitiesNav {
  newActivity(workspace?: string): void; addWorkspace?(): void;
  menu?(task: Task, row: ReactNode): ReactNode; localMenu?(activity: LocalActivity, row: ReactNode): ReactNode;
}

export interface ActivitiesPanelProps {
  activities: Activity[]; workspaces: string[]; sourceWorkspaces?: Record<string, string>; workers: Worker[];
  stages: Stage[]; // the flow's stages in order (#586): what a workspace groups its activities by, and which one is done
  selected?: string; onSelect(key: string): void; // activityKey's: a task's item id, or local/<workspace> (#590)
  shown?: string; // the run the center's focused group shows (#492), handed only while the center is Atividades'
  onOpenRun(key: string, ptyId: string): void; // a session's click: that run in its activity (#492)
  nav: ActivitiesNav;
  isShown?: boolean; // the tab is on screen: the checkouts' branches and the worktree states are read then, and again each time it shows
}

const ENTRY = 'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-5 text-left text-[13px]';
// The guide line the session lines hang on, under an activity's row and under a workspace's local entry alike
const GUIDE = 'flex flex-col gap-px border-empty border-l pl-[9px]';

// ⌘N as the user bound it, or nothing once unbound
function NewKey() {
  const current = binding('newActivity');
  if (current === null) return null;
  return <span className="ml-auto text-muted-foreground text-xs tracking-widest">{displayBinding(current, isMac())}</span>;
}

/** The + of the sidebar's header and of each workspace (redesign 03): nova atividade… opens the Start dialog, a task created there running
 * in the + 's workspace, and adicionar workspace… opens Settings on workspaces. */
export function PlusMenu({ nav, label, workspace }: { nav: ActivitiesNav; label: string; workspace?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={label}><PlusIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px]">
        <DropdownMenuItem onSelect={() => nav.newActivity(workspace)} className="flex-col items-stretch gap-0.5">
          <span className="flex items-center">{t('activities.new')}<NewKey /></span>
          <span className="text-muted-foreground text-xs">{t('activities.newHint')}</span>
        </DropdownMenuItem>
        {nav.addWorkspace && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={nav.addWorkspace}>{t('activities.addWorkspaceMenu')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The activity's branch and its worktree's state (#586): no branch yet, the state alone; neither, no line
function WorktreeLine({ branch, state }: { branch?: string; state?: WorktreeState }) {
  if (branch === undefined && state === undefined) return null;
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono">{branch ?? ''}</span>
      {state && <span className="shrink-0 whitespace-nowrap">{worktreeText(state)}</span>}
    </span>
  );
}

// The activity's own line (#663, #696), between the worktree line and the sessions: review or approval in its status colour, sleeping muted
// (it is not a status), both as `<status> · sleeping`; neither, no line
function StatusLine({ status, isSleeping }: { status?: Status; isSleeping: boolean }) {
  if (status === undefined && !isSleeping) return null;
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-xs">
      {status && <StatusWord status={status} />}
      {status && isSleeping && <span className="text-muted-foreground">·</span>}
      {isSleeping && <span className="text-muted-foreground">{t('session.sleeping')}</span>}
    </span>
  );
}

type RowsProps = Pick<ActivitiesPanelProps, 'workers' | 'selected' | 'shown' | 'onSelect' | 'onOpenRun' | 'nav'> & { worktrees: Record<string, WorktreeState> };
type EntryProps = Omit<RowsProps, 'selected' | 'worktrees'> & { activity: TaskActivity; isSelected: boolean; worktree?: WorktreeState; showWorktree: boolean };

// An activity as one block (#586): the row (its title, then the worktree line) picks the activity (#457), and its sessions sit inside the
// block on a guide line, each opening its run (#492). Siblings, never nested: a button holds no button. The selected block takes the muted
// fill whole. Only the selected activity's sessions can be the shown one, since the center shows the selected activity
function ActivityEntry({ activity, isSelected, worktree, showWorktree, workers, shown, onSelect, onOpenRun, nav }: EntryProps) {
  const { task } = activity;
  const id = task.item.itemId;
  const terminals = activity.terminals ?? []; // #696
  // Review and approval are the task's state once no session works (#663): no session line says them, so the row does
  const ended = activity.status === 'review' || activity.status === 'approval' ? activity.status : undefined;
  // the detail's total: the working time, the waiting left out (#248); its own activity is what its workers point at (#629)
  const total = taskTotals({ workers, activities: [activity.activity], activityRecords: activity.records }, task, Date.now());
  const row = (
    <button
      type="button" aria-current={isSelected ? 'true' : undefined} onClick={() => onSelect(id)}
      className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 text-left"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate">{taskLabel(task)}</span>
        {activity.worker && <span className="shrink-0 rounded-[4px] border px-1 font-medium text-[11px]">{t('activities.worker')}</span>}
        <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs">{compact(total.ms - total.waitingMs)}</span>
      </span>
      {showWorktree && <WorktreeLine branch={activity.activity.branch} state={worktree} />}
      <StatusLine status={ended} isSleeping={activity.sleeping === true} />
    </button>
  );
  return (
    <div className={`flex flex-col rounded-md py-1.5 pr-2 pl-5 ${isSelected ? 'bg-muted' : 'hover:bg-accent/50'}`}>
      {nav.menu ? nav.menu(task, row) : row}
      {(activity.sessions.length > 0 || terminals.length > 0) && (
        <div className={`mt-1 ml-[2px] ${GUIDE}`}>
          {activity.sessions.map((entry) => (
            <TaskSessionLine
              key={entry.session?.id ?? entry.run?.ptyId} activity={activity} entry={entry}
              shown={isSelected ? shown : undefined} onOpenRun={(ptyId) => onOpenRun(id, ptyId)}
            />
          ))}
          <TerminalLines terminals={terminals} shown={isSelected ? shown : undefined} onOpen={(ptyId) => onOpenRun(id, ptyId)} />
        </div>
      )}
    </div>
  );
}

// One activity's block as its list renders it: selected per the tab, its worktree state per the route (#586)
function entryOf({ selected, worktrees, ...rest }: RowsProps, showWorktree: boolean): (activity: TaskActivity) => ReactNode {
  return (activity) => {
    const id = activity.task.item.itemId;
    return <ActivityEntry key={id} activity={activity} isSelected={id === selected} worktree={worktrees[id]} showWorktree={showWorktree} {...rest} />;
  };
}

interface HeaderProps {
  name: string; isOpen: boolean; summary: string; onToggle(): void; nav: ActivitiesNav; view: WorkspaceView; onView(patch: Partial<WorkspaceView>): void;
}

// The workspace's header: collapse, its colour, its name (never wrapped), the collapsed workspace's summary (#586), then + and ⋯
function WorkspaceHeader({ name, isOpen, summary, onToggle, nav, view, onView }: HeaderProps) {
  return (
    <div className="flex items-center gap-1 px-1.5 py-1 font-medium text-xs">
      <button type="button" aria-expanded={isOpen} onClick={onToggle} className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left">
        <ChevronDownIcon className={`size-3 shrink-0 text-muted-foreground ${isOpen ? '' : '-rotate-90'}`} />
        <WorkspaceSquare name={name} />
        <span className="truncate">{name}</span>
      </button>
      <span className="min-w-0 flex-1 truncate text-right font-normal text-muted-foreground">{isOpen ? '' : summary}</span>
      <PlusMenu nav={nav} label={t('activities.newIn', { name })} workspace={name} />
      <WorkspaceMenu name={name} view={view} onView={onView} onSettings={nav.addWorkspace} />
    </div>
  );
}

type LocalProps = Omit<RowsProps, 'worktrees'> & { name: string; branch?: string | null; local?: LocalActivity; sessions: Session[] };

// A workspace's local activity (#590): its row, selectable like any activity, with its checkout's branch, and under it its local sessions
// (#587), a live one opening its run and a stopped one continued. No time, no worker badge, no delete: it holds no task and never goes
function LocalEntry({ name, branch, local, sessions, workers, selected, shown, onSelect, onOpenRun, nav }: LocalProps) {
  const key = localKey(name);
  const isSelected = key === selected;
  const row = (
    <button
      type="button" aria-current={isSelected ? 'true' : undefined} onClick={() => onSelect(key)}
      className={`${ENTRY} ${isSelected ? 'bg-muted' : 'hover:bg-accent/50'}`}
    >
      <span className="shrink-0">{t('activities.local')}</span>
      {branch && <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">{branch}</span>}
    </button>
  );
  return (
    <>
      {local && nav.localMenu ? nav.localMenu(local, row) : row}
      <div className={`mr-2 ml-[22px] empty:hidden ${GUIDE}`}>
        <LocalSessionLines workspace={name} sessions={sessions} workers={workers} shown={isSelected ? shown : undefined} />
        <TerminalLines terminals={local?.terminals ?? []} shown={isSelected ? shown : undefined} onOpen={(ptyId) => onOpenRun(key, ptyId)} />
      </div>
    </>
  );
}

type GroupProps = RowsProps & { name: string; branch?: string | null; activities: TaskActivity[]; stages: Stage[]; localSessions: Session[]; local?: LocalActivity };

// A workspace: its local activity first (#590), outside any stage or status group, then its task activities in the groups its ⋯ picks (#586)
function WorkspaceGroup({ name, branch, activities, stages, localSessions, local, ...rows }: GroupProps) {
  const [view, setView] = useWorkspaceView(name);
  const toggle = (key: string): void =>
    setView({ collapsed: view.collapsed.includes(key) ? view.collapsed.filter((k) => k !== key) : [...view.collapsed, key] });
  return (
    <section aria-label={name} className="flex flex-col gap-0.5">
      {/* open or closed is part of the workspace's saved view, so a restart or a remount keeps it (#779) */}
      <WorkspaceHeader
        name={name} isOpen={view.isOpen} summary={workspaceSummary(activities)} onToggle={() => setView({ isOpen: !view.isOpen })}
        nav={rows.nav} view={view} onView={setView}
      />
      {view.isOpen && (
        <>
          <LocalEntry name={name} branch={branch} local={local} sessions={localSessions} {...rows} />
          <ActivityGroupList
            groups={groupActivities(activities, view.mode, stages)} isFlat={view.mode === 'none'} collapsed={view.collapsed}
            onToggle={toggle} entry={entryOf(rows, view.showWorktree)}
          />
        </>
      )}
    </section>
  );
}

/** The Activities tab (#457, redesign 03): one group per workspace, each with its local entry and its activities grouped by stage, by status
 * or not at all (#586), and the activities that resolve to no workspace after them, a flat list with no menu. An activity shows with nothing
 * running while its worktree is on disk: its title, worker on the automation's, its total time, its worktree line, and under it one line per
 * session of its task with its own status, sleeping while no run holds it (#614); its status line (#696), and after its sessions one line per
 * terminal it keeps. Plain buttons, never list items: the main window's tasks are the page's own. */
export function ActivitiesPanel({ activities: all, workspaces, sourceWorkspaces, stages, isShown = true, ...rest }: ActivitiesPanelProps) {
  const activities = all.filter(isTask); // a local activity is its workspace's first row, in no group (#590)
  // ponytail: read when the tab shows and when the workspaces change; a checkout switched while it stays on screen waits for the next one
  const branches = useBranches(isShown, workspaces.join('\n'));
  // A Stop is when a worktree changes (#586): read again when the set of activities or any of their statuses changes, never on a timer
  const worktrees = useWorktreeStates(isShown, activities.map((a) => `${a.task.item.itemId}:${a.status}`).join('\n'));
  const rows: RowsProps = { ...rest, worktrees };
  const of = (name?: string): TaskActivity[] => activities.filter((a) => resolveWorkspace(a.task, workspaces, sourceWorkspaces) === name);
  const localOf = (name: string): LocalActivity | undefined => all.find((a): a is LocalActivity => a.kind === 'local' && a.workspace === name);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label={t('dock.activities')} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1.5 py-1">
        {workspaces.map((name) => (
          <WorkspaceGroup key={name} name={name} branch={branches[name]} activities={of(name)} stages={stages} localSessions={localOf(name)?.record.sessions ?? []} local={localOf(name)} {...rows} />
        ))}
        <div className="flex flex-col gap-0.5 empty:hidden">{of(undefined).map(entryOf(rows, true))}</div>
      </nav>
      {rest.nav.addWorkspace && (
        <button
          type="button" onClick={rest.nav.addWorkspace}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 border-t px-3 py-2 text-muted-foreground text-xs hover:text-foreground"
        >
          <PlusIcon className="size-3" />
          {t('activities.addWorkspace')}
        </button>
      )}
    </div>
  );
}
