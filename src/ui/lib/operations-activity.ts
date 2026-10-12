// The activity group (#584): what the activity's menus, + and bar offer, targeted at the open activity, or at the row a → opened. Built per
// activity, so each run closes over its task.
import { AGENTS } from '../../agents';
import { canDiff, canRunCommand, commandsOf, startMode } from '../../task-runs';
import { nextPr } from '../../pull-requests';
import { activityOf } from '../../activities';
import { canOpenSession, removalBlocker, resolveWorkspace } from '../../tasks';
import { AGENT_IDS, type Task, type DiffScope } from '../../types';
import { runCommand } from '@/components/actions';
import { asksBeforeSleepAll } from '@/components/SleepMenu';
import { agentName, openNew } from '@/components/NewRunButton';
import { type MessageKey, t } from '@/i18n';
import { type Activity, activityPrs, type LocalActivity, type TaskActivity } from '@/lib/activities';
import { runShortcut } from '@/lib/dock-layout';
import type { FocusTarget, Operation, OperationContext } from '@/lib/operations';

/** A task's reference, taskLabel's head (#466, or HIVE-11 for one created in the Hive): what an operation names as its target. */
export const taskRef = (task: Pick<Task, 'item' | 'created'>): string => `${task.created ? '' : '#'}${task.item.id}`;

// diff › in the spec's order; último commit waits for a scope of its own (DiffScope has none)
const DIFFS: ReadonlyArray<[DiffScope, MessageKey]> = [['worktree', 'task.diffWorktree'], ['stage', 'task.diffStage']];

// A pick of a › page on this activity: listed, run at once
const pick = (id: string, label: string, run: (ctx: OperationContext) => void, extra: Partial<Operation> = {}): Operation =>
  ({ id, group: 'activity', label: () => label, available: () => true, run, ...extra });

// executar {command} (#300, #353): one per command of the activity's workspace, disabled as the task menu's item while canRunCommand refuses
export function commandOperations(task: Task, ctx: OperationContext): Operation[] {
  const workspace = resolveWorkspace(task, ctx.state.workspaces, ctx.state.sourceWorkspaces, ctx.state.tasks) ?? '';
  return commandsOf(task, ctx.state).map((name) => ({
    id: `command:${name}`, group: 'activity', label: () => t('search.op.runCommand', { command: name }), target: () => `${workspace} · ${taskRef(task)}`,
    available: () => true, disabled: () => !canRunCommand(task, activityOf(ctx.state, task.item.itemId)), run: (c) => runCommand(task, c.state, name, c.nav.openConsole),
  }));
}

// nova sessão ›: one item per agent that can open a free session (#927: not Codex, which picks its own id, until #931), opened in the activity (a task's worktree or a workspace's checkout, #590)
const newSession = (activity: Activity, op: OpFactory, isOpenable: boolean): Operation => op('newSession', 'activities.menu.newSession', {
  available: () => isOpenable,
  children: () => AGENT_IDS.filter((agent) => AGENTS[agent].canChooseSessionId).map((agent) => pick(`activity.newSession.${agent}`, agentName(agent), (c) => openNew(activity, agent, c.nav.openRun))),
});

// the split key's listener mounts with the center, so only the shown activity splits
const split = (op: OpFactory, isOpenable: boolean): Operation =>
  op('split', 'split.same', { shortcut: 'splitSame', available: (c) => c.isShown === true && isOpenable, run: () => runShortcut('splitSame') });

// ⌘D and ⌘⇧D (#641): listed while the shown activity's focused group shows a run, the only time their listener (mounted with the center) acts
const SPLIT_TERMINAL = ['splitTerminalVertical', 'splitTerminalHorizontal'] as const;
const splitTerminal = (op: OpFactory, isOpenable: boolean): Operation[] => SPLIT_TERMINAL.map((id) => op(id, `shortcuts.${id}` as const, {
  shortcut: id, available: (c) => c.isShown === true && isOpenable && c.shownRun !== undefined, run: () => runShortcut(id),
}));

type OpFactory = (id: string, label: MessageKey, rest: Partial<Operation>) => Operation;

// dormir todas (#672), with its dialog, whenever it asks first: several runs, or a terminal among them (#696); one session sleeps from dormir
const sleepAll = (activity: Activity, op: OpFactory): Operation => op('sleepAll', 'sleep.all', {
  shortcut: 'sleepAll', available: () => asksBeforeSleepAll(activity.runs), run: (c) => c.nav.dialog({ kind: 'sleep', activity, runs: activity.runs }),
});

// A workspace's local activity holds no task (#590): it has no stage, diff, worktree commands or delete; its sessions and terminals sleep all
// the same (#696), so the new session, the splits and dormir todas are listed, as its own menu offers
const localOperations = (activity: LocalActivity, op: OpFactory): Operation[] =>
  [newSession(activity, op, true), split(op, true), ...splitTerminal(op, true), sleepAll(activity, op)];

function taskOperations(activity: TaskActivity, ctx: OperationContext, op: OpFactory): Operation[] {
  const { task, activity: live } = activity;
  const mode = startMode(task, ctx.state);
  const diffs = DIFFS.filter(([scope]) => canDiff(task, live, scope));
  return [
    newSession(activity, op, canOpenSession(task, live)),
    op('diff', 'activity.new.diff', {
      available: () => diffs.length > 0,
      children: () => diffs.map(([scope, key]) => pick(`activity.diff.${scope}`, t(key), (c) => c.nav.openDiff?.(task, scope), scope === 'stage' ? { shortcut: 'openDiff' } : {})),
    }),
    // mostrar PR (#592, #758): listed on every task, disabled while it has none, as its menus show it; the PR's page
    op('showPr', 'task.showPr', {
      disabled: () => nextPr(activityPrs(activity), task.item.facets?.repository) === undefined,
      run: (c) => { const url = nextPr(activityPrs(activity), task.item.facets?.repository); if (url !== undefined) c.nav.openPr?.(url); },
    }),
    split(op, canOpenSession(task, live)),
    ...splitTerminal(op, canOpenSession(task, live)),
    ...commandOperations(task, ctx),
    sleepAll(activity, op),
    op('restart', 'task.restartStage', { available: () => typeof mode === 'object' && mode.restart, run: (c) => c.nav.dialog({ kind: 'restart', task }) }),
    op('delete', 'activity.delete', { available: () => !live?.local && removalBlocker(task, ctx.state) === undefined, run: (c) => c.nav.dialog({ kind: 'delete', task }) }),
  ];
}

/** The activity's operations in the spec's order, each targeted at it; what the activity does not allow is not listed. */
export function activityOperations(activity: Activity, ctx: OperationContext): Operation[] {
  const target = activity.kind === 'local' ? activity.workspace : taskRef(activity.task);
  const op: OpFactory = (id, label, rest) => ({ id: `activity.${id}`, group: 'activity', label: () => t(label), target: () => target, available: () => true, ...rest });
  return activity.kind === 'local' ? localOperations(activity, op) : taskOperations(activity, ctx, op);
}

/** The task the run-command key acts on (#585): the shown activity's, else the task focused in the flow. A local activity holds no task. */
export function commandTask(shown: Activity | undefined, focus: FocusTarget | undefined): Task | undefined {
  if (shown !== undefined) return shown.kind === 'task' ? shown.task : undefined;
  return focus?.kind === 'task' ? focus.task : undefined;
}

/** The search the run-command key opens on several commands (#585): a page of that task's commands, named after the key and the task. */
export const commandsPage = (task: Task, ctx: OperationContext): { title: string; operations: Operation[] } =>
  ({ title: `${t('shortcuts.runCommand')} · ${taskRef(task)}`, operations: commandOperations(task, ctx) });
