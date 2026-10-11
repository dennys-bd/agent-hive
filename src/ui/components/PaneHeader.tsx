import { taskLabel, resolveWorkspace, stageOf } from '../../tasks';
import type { Activity as LiveActivity, Task, State, Status } from '../../types';
import { agentName, RUN_AGENT } from '@/components/NewRunButton';
import { StatusWord } from '@/components/StatusWord';
import { t } from '@/i18n';
import { type Activity, runStatus, sleepingOf } from '@/lib/activities';
import type { CenterTabRef } from '@/lib/center-layout';

/** What a pane's header reads beyond the activity (#536): the model the task's stage names (#516), and the folder the task works in. */
export interface PaneContext { model?: string; folder?: string }

// A path's last segment: a worktree's folder
const folderOf = (path: string | undefined): string | undefined => path?.split('/').filter((part) => part !== '').at(-1);

/** A task's pane context (#536): its stage's model when the stage sets one, and its worktree's folder, or its workspace's name on a task
 * that runs in the checkout (#444). */
export function paneContext(task: Task, live: LiveActivity | undefined, state: Pick<State, 'stages' | 'workspaces' | 'sourceWorkspaces' | 'tasks'>): PaneContext {
  const model = stageOf(state.stages, task.stage)?.model;
  const folder = live?.local ? resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks) : folderOf(live?.worktree); // the live activity's (#629)
  return { ...(model === undefined ? {} : { model }), ...(folder === undefined ? {} : { folder }) };
}

/** An activity's pane context (#590): a task's as paneContext reads it; a local activity's folder is its workspace's name, as a checkout
 * task's is (#444). */
export const activityPane = (activity: Activity, state: Pick<State, 'stages' | 'workspaces' | 'sourceWorkspaces' | 'tasks'>): PaneContext =>
  (activity.kind === 'local' ? { folder: activity.workspace } : paneContext(activity.task, activity.activity, state));

interface Header { name: string; parts: string[]; status?: Status; branch?: string }

// An agent names itself, then the model and the folder, with its session's status; a terminal its kind (the UI never learns the shell's
// name) and the folder, with no status since a terminal reports none (#192); a diff, the console or a run already gone only its label
function headerOf(item: CenterTabRef, label: string, activity: Activity, context: PaneContext): Header {
  // A diff (#591): `diff`, the task, and its branch in mono when it has one
  if (item.kind === 'diff' && activity.kind === 'task') return { name: t('diff.pane'), parts: [taskLabel(activity.task)], branch: activity.activity.branch };
  // A preview (#697): `Preview` and its path
  if (item.kind === 'preview') return { name: t('preview.title'), parts: [item.path] };
  // The changes pane (#668): `Alterações` and its path
  if (item.kind === 'changes') return { name: t('changes.title'), parts: [item.path] };
  const sleeping = item.kind === 'run' ? sleepingOf(activity, item.ptyId) : undefined;
  const run = item.kind === 'run' ? activity.runs.find((r) => r.ptyId === item.ptyId) ?? sleeping?.run : undefined;
  if (run === undefined) return { name: label, parts: [] };
  const folder = context.folder === undefined ? [] : [context.folder];
  if (run.kind === 'terminal') return { name: t('activities.menu.terminal'), parts: folder, ...(sleeping === undefined ? {} : { status: 'empty' as const }) }; // #696: sleeping, muted
  const model = context.model === undefined ? [] : [context.model];
  const status = sleeping === undefined ? runStatus(activity, run.ptyId) : 'empty'; // a sleeping run reads sleeping, muted (#672)
  return { name: agentName(RUN_AGENT), parts: [...model, ...folder], status };
}

interface PaneHeaderProps { item: CenterTabRef; label: string; activity: Activity; context: PaneContext }

/** A pane's header (redesign 04, #536): 26px of muted 12px text over the group's shown tab, the name in foreground and the status on the
 * right. */
export function PaneHeader({ item, label, activity, context }: PaneHeaderProps) {
  const { name, parts, status, branch } = headerOf(item, label, activity, context);
  return (
    <div data-pane-header className="flex h-[26px] shrink-0 items-center gap-2 px-3 text-muted-foreground text-xs">
      <span className="shrink-0 text-foreground">{name}</span>
      {parts.length > 0 && <span className="min-w-0 truncate">{parts.join(' · ')}</span>}
      {branch !== undefined && <><span aria-hidden="true">·</span><span className="min-w-0 truncate font-mono">{branch}</span></>}
      {/* empty here is a held approval run or a sleeping one (#663, #672): it reads sleeping like its line */}
      {status !== undefined && <span className="ml-auto flex"><StatusWord status={status} emptyWord="session.sleeping" /></span>}
    </div>
  );
}
