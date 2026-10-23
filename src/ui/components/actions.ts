// Every dashboard action: same route and body as before, a toast instead of the error bar.
import { toast } from 'sonner';
import type { RunKind } from '../../task-runs';
import { activityOf } from '../../activities';
import { taskLabel, resolveWorkspace } from '../../tasks';
import { commandChannel } from '../../console';
import type { Task, OpenResult, SessionRef, State } from '../../types';
import type { OpenConsole } from '@/hooks/use-console';
import type { OpenRun, RunTab } from './terminal-tabs';
import { sendJson, WriteCancelled } from '../lib/api.js';
import { sessionPath } from '../lib/copy-targets.js';
import { shownSize } from '../lib/xterm-setup.js';

/** The answer's body on success, undefined (never a rejection) on failure: the toast already carries the error; a cancelled intervention (#469) says nothing. Most callers ignore the
 * body (`void act(path)`); POST /open's caller reads it to attach the run it started (#249). */
export function act<T = void>(path: string, body?: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<T | undefined> {
  return sendJson<T>(method, path, body)
    .catch((err: Error) => {
      if (!(err instanceof WriteCancelled)) toast.error(err.message); // #469: a cancel is the user's choice, not an error
      return undefined;
    });
}

/** act, then `done` only when the server took it: a refusal is act's toast and nothing more (#457). `body`: a continue's grid (#808). */
export function actThen(path: string, done?: () => void, body?: unknown): Promise<void> {
  return act<unknown>(path, body).then((answer) => { if (answer !== undefined) done?.(); });
}

/** A run's terminal button (#283): its detached window when it has one (#252), else `open`: the dock's run opener, a task's run shown in
 * the center as its activity (#457), or the panel's openTab for a chip dropped there (#340). Inside the viewer the window is asked first; a
 * failed ask opens it, as no window does. A plain browser has no windows to ask about. */
export function focusRun(tab: RunTab, open?: OpenRun): void {
  const bridge = window.hive;
  if (!bridge) {
    open?.(tab);
    return;
  }
  void bridge.focusDetached(tab.ptyId).catch(() => false).then((focused) => {
    if (!focused) open?.(tab);
  });
}

/** What POST /tasks/:id/open and .../sessions/:id/open answer with (#249): the run it started, attached at once, no extra click on
 * terminal. No ptyId (a spawn failure; the error bar already shows it through spawnFailed): nothing. */
export function attachRun(result: OpenResult, task: Task, kind: RunKind, open?: OpenRun): void {
  if (!result.ptyId) return;
  focusRun({ ptyId: result.ptyId, kind, task: task.item.itemId, title: taskLabel(task) }, open);
}

/** Continues a task's kept session in a new run through the task's open route (#614), the run opening as a tab of the task's activity (#249):
 * a sleeping line's click, and the close-tab notice's reabrir once the run is asleep. A refusal is act's toast. */
export function continueTaskSession(task: Task, ref: SessionRef, open?: OpenRun, onNoRun?: () => void): void {
  void act<OpenResult>(`${sessionPath(ref)}/open`, { size: shownSize() }).then((result) => {
    if (result?.ptyId) attachRun(result, task, 'session', open);
    else onNoRun?.(); // a refusal or a spawn that answered no run (#672)
  });
}

/** A workspace's run command on a task (#300): POST /run, then the console shows the command's channel with the new run (#353); no terminal
 * tab. The channel is the workspace the task resolves to, the one the server keys it by. A refusal is a toast; a spawn failure answers no run
 * and shows nothing. */
export function runCommand(task: Task, state: Pick<State, 'workspaces' | 'sourceWorkspaces' | 'activities' | 'activityRecords' | 'tasks'>, command: string, openConsole?: OpenConsole): void {
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks);
  const live = activityOf(state, task.item.itemId); // a command runs in the live activity's worktree (#629)
  if (!live) return;
  void act<OpenResult>(`/activities/${encodeURIComponent(live.id)}/run`, { command, size: shownSize() }).then((result) => {
    if (result?.ptyId !== undefined && workspace !== undefined) openConsole?.(commandChannel(workspace, command).id, result.ptyId);
  });
}

/** A stage a task may move to and its move (#164, #916). */
export interface StageMove { stage: string; move(): void }

/** The stages but the task's own, each posting move-to: what the task menu's mover para etapa › and the exhausted block's mover para… list. */
export function stageMoves(task: Task, state: Pick<State, 'stages'>): StageMove[] {
  const path = `/tasks/${encodeURIComponent(task.item.itemId)}/move-to`;
  return state.stages.filter((s) => s.name !== task.stage).map((s) => ({ stage: s.name, move: () => void act(path, { stage: s.name }) }));
}
