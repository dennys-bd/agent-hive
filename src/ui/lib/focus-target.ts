// What held the focus when the search opened (#584), as VS Code's palette reads the focused editor: a terminal tab's xterm or a task in
// the flow. The search's focus operations act on it.
import { type LiveRun, liveRuns, localRuns } from '../../task-runs';
import type { State } from '../../types';
import type { FocusTarget } from '@/lib/operations';

type Slice = Pick<State, 'tasks' | 'workers' | 'terminals' | 'workspaces' | 'activities' | 'activityRecords'>;

// The live run of a worker: a task's, else a workspace's local one (#590)
function runOf(state: Slice, ptyId: string): LiveRun | undefined {
  const runs = [...state.tasks.flatMap((task) => liveRuns(task, state)), ...state.workspaces.flatMap((workspace) => localRuns(workspace, state))];
  return runs.find((run) => run.ptyId === ptyId);
}

/** The focused element as a target: inside a terminal tab (PtyTab's data-pty-id) its run, inside an editor pane (EditorPane's
 * data-file-activity and data-file-path, #697) its file, a flow task (FlowTask's data-task-id) its task; undefined for anything else, a
 * run or a task gone from the State included. */
export function readFocusTarget(state: Slice, active: Element | null = document.activeElement): FocusTarget | undefined {
  const ptyId = active?.closest<HTMLElement>('[data-pty-id]')?.dataset.ptyId;
  if (ptyId !== undefined) {
    const run = runOf(state, ptyId);
    return run === undefined ? undefined : { kind: 'terminal', run };
  }
  const file = active?.closest<HTMLElement>('[data-file-path]')?.dataset;
  if (file?.filePath !== undefined && file.fileActivity !== undefined) return { kind: 'file', activityId: file.fileActivity, path: file.filePath };
  const taskId = active?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId;
  const task = state.tasks.find((c) => c.item.itemId === taskId);
  return task === undefined ? undefined : { kind: 'task', task };
}
