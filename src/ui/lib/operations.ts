// The Hive's operations (#584): what the Hive does, started from the UI or by a key, listed in the search's comandos. Each one's run calls what
// its button or key calls today, so the search adds no behaviour. A shortcut is only the key bound to an operation; many have none.
import { activityOf } from '../../activities';
import type { LiveRun } from '../../task-runs';
import { shortcutDef } from '../../shortcut-registry';
import type { AgentAvailability, Task, EffectiveLimits, OperationId, State } from '../../types';
import { act } from '@/components/actions';
import type { OpenDiff, OpenPr, OpenRun, OpenStarted } from '@/components/terminal-tabs';
import type { OpenConsole } from '@/hooks/use-console';
import { t } from '@/i18n';
import type { Activity, TaskActivity } from '@/lib/activities';
import { isMarkdownPath } from '@/lib/doc-links';
import { activityOperations, taskRef } from '@/lib/operations-activity';
import { GLOBAL_OPERATIONS } from '@/lib/operations-global';
import { answerableActivity } from '@/lib/task-state';
import { clearTerminal } from '@/lib/xterm-setup';

/** focus: acts on what held the focus before the search opened. activity: on the open activity. global: always there. */
export type OperationGroup = 'focus' | 'activity' | 'global';

/** The confirm or dialog an operation opens (#584): the same its menu opens, shown once the search has closed. */
export type OperationDialog = { kind: 'sleep'; activity: Activity; runs: LiveRun[] } | { kind: 'restart'; task: Task } | { kind: 'delete'; task: Task } | { kind: 'feedback'; task: Task };

/** What held the focus when the search opened (#584): a terminal tab, an editor pane's file (#697) or a flow task. A terminal carries its run
 * only: a workspace's local terminal (#590) has no task, and nothing an operation does on a tab needs one. A file carries its activity's id,
 * which the pane knows. */
export type FocusTarget = { kind: 'terminal'; run: LiveRun } | { kind: 'file'; activityId: string; path: string } | { kind: 'task'; task: Task };

/** Where the search's rows lead (#584): the dock's openers. */
export interface SearchNav {
  openActivity(itemId: string): void; // ↵ on an activity: it opens in the center
  showFlow(itemId: string): void; // ⌘↵: the task's details in the flow
  startTask(start: { itemId?: string; title?: string }): void; // ↵ on a task, + criar tarefa: the Start dialog (redesign 11)
  openSettings?(): void; // configurações; absent (a harness): not listed
  openRun?: OpenRun; // nova sessão's run, as the activity menu's + opens it
  openDiff?: OpenDiff; // diff ›, a tab of the activity's center
  openPr?: OpenPr; // mostrar PR: the PR's page (#758)
  openConsole?: OpenConsole; // executar's console channel
  openStarted?: OpenStarted; // reiniciar etapa's new session goes to the center
  openPreview?(activityId: string, path: string): void; // Markdown: Open Preview (#697): the file's preview pane, a tab of its activity's center
  openChanges?(activityId: string, path: string): void; // Git: Open Changes (#668): the file's changes pane, a tab of its activity's center
  closeTab(ptyId: string): void; // fechar tab: as ⌘W closes it; an agent's run follows its close setting, a terminal closeTerminalTab (#452, #696)
  dialog(dialog: OperationDialog): void; // parar todas, reiniciar etapa…, excluir atividade…
}

/** What an operation reads (#584). */
export interface OperationContext {
  state: State;
  effective?: EffectiveLimits; // sinal's floor and pausar regra's rules
  activity?: Activity; // the open activity, or the row a → opened
  focus?: FocusTarget; // read when the search opened
  isShown?: boolean; // that activity is the one the center shows: dividir splits its focused group
  shownRun?: string; // the run its focused group shows, a split tab's focused pane (#641): the split-terminal keys act on it
  agents?: readonly AgentAvailability[]; // #931: the agents boot found, which nova sessão › disables by; absent reads as every one
  nav: SearchNav;
}

/** One operation (#584). A `›` one has children, a page of its own; the rest run. target names what it acts on, apart from the label so the
 * row can mute it; disabled keeps it listed but inert (a command without its worktree); checked marks a state it toggles or picks. */
export interface Operation {
  id: string;
  group: OperationGroup;
  label(ctx: OperationContext): string;
  target?(ctx: OperationContext): string;
  shortcut?: OperationId;
  available(ctx: OperationContext): boolean;
  disabled?(ctx: OperationContext): boolean;
  checked?(ctx: OperationContext): boolean;
  run?(ctx: OperationContext): void;
  children?(ctx: OperationContext): Operation[];
}

/** An operation's words and state in a context: what a row shows and what the search matches. */
export interface OperationView { operation: Operation; label: string; target?: string; isDisabled: boolean; isChecked: boolean }

export const viewOf = (operation: Operation, ctx: OperationContext): OperationView => ({
  operation, label: operation.label(ctx), target: operation.target?.(ctx), isDisabled: operation.disabled?.(ctx) ?? false, isChecked: operation.checked?.(ctx) ?? false,
});

// The focus group over an editor pane (#697, #668): Markdown: Open Preview over a markdown file and Git: Open Changes over any, as VS Code's
// palette offers them; Git: Open Changes is not listed with no opener (a harness)
function fileOperations({ activityId, path }: Extract<FocusTarget, { kind: 'file' }>): Operation[] {
  const name = path.split('/').at(-1) ?? path;
  const on = { group: 'focus' as const, target: () => name };
  return [
    { ...on, id: 'focus.markdownPreview', label: () => t('operation.markdownPreview'), available: () => isMarkdownPath(path), run: (c) => c.nav.openPreview?.(activityId, path) },
    { ...on, id: 'focus.openChanges', label: () => t('operation.openChanges'), available: (c) => c.nav.openChanges !== undefined, run: (c) => c.nav.openChanges?.(activityId, path) },
  ];
}

// The focus group (#584): what the target that held the focus allows, named after it. A terminal tab: its X and the clear key. A task: the
// approval's two while the user can answer it, as its menu offers them (#268, #685, #829), and começar sozinho (#164)
function focusOperations(focus: FocusTarget): Operation[] {
  if (focus.kind === 'file') return fileOperations(focus);
  if (focus.kind === 'terminal') {
    const { run } = focus;
    const on = { group: 'focus' as const, target: () => run.label, available: () => true };
    return [
      { ...on, id: 'focus.closeTab', label: () => t('search.op.closeTab'), run: (c) => c.nav.closeTab(run.ptyId) },
      { ...on, id: 'focus.clear', shortcut: 'clear', label: () => t('shortcuts.clear'), run: () => clearTerminal(run.ptyId) },
    ];
  }
  // Read from the State at each use: the copy the search took on opening may be stale by the time a row is picked
  const live = (c: OperationContext): Task => c.state.tasks.find((x) => x.item.itemId === focus.task.item.itemId) ?? focus.task;
  const awaits = (c: OperationContext): boolean => answerableActivity(live(c), c.state) !== undefined; // #829: none while a session of it is live
  const pathOf = (c: OperationContext): string => `/tasks/${encodeURIComponent(live(c).item.itemId)}`;
  const workOf = (c: OperationContext): string => `/activities/${encodeURIComponent(activityOf(c.state, focus.task.item.itemId)?.id ?? '')}`; // #629
  const on = { group: 'focus' as const, target: () => taskRef(focus.task) };
  return [
    { ...on, id: 'focus.feedback', label: () => t('task.sendFeedback'), available: awaits, run: (c) => c.nav.dialog({ kind: 'feedback', task: live(c) }) },
    { ...on, id: 'focus.approve', label: () => t('approval.approve'), available: awaits, run: (c) => void act(`${workOf(c)}/approve`) },
    { ...on, id: 'focus.autoStart', label: () => t('detail.menu.autoStart'), available: (c) => !live(c).missing, checked: (c) => live(c).auto, run: (c) => void act(`${pathOf(c)}/auto`, { auto: !live(c).auto }) },
  ];
}

/** Whether the search lists an operation (#585): never one whose key is a soon shortcut's, which is only reserved. */
export const isListed = (op: Operation): boolean => op.shortcut === undefined || shortcutDef(op.shortcut).soon !== true;

/** The operations `ctx` allows, in the order focus › activity › global (the spec); one the target does not allow is not listed. */
export function operationsFor(ctx: OperationContext): Operation[] {
  const focus = ctx.focus === undefined ? [] : focusOperations(ctx.focus);
  const activity = ctx.activity === undefined ? [] : activityOperations(ctx.activity, ctx);
  return [...focus, ...activity, ...GLOBAL_OPERATIONS].filter((op) => isListed(op) && op.available(ctx));
}

/** A → page (#584): the row's task as if it held the focus, and its activity's group when it is one, targeted at it; never the global group.
 * Returns the context the page's operations run in. Only a task's activity has a → page: a workspace's local one is not a search row. */
export function itemPage(ctx: OperationContext, task: Task, activity?: TaskActivity): { ctx: OperationContext; operations: Operation[] } {
  const isShown = ctx.isShown === true && activity !== undefined && ctx.activity?.kind === 'task' && ctx.activity.task.item.itemId === activity.task.item.itemId;
  const item: OperationContext = { ...ctx, focus: { kind: 'task', task }, activity, isShown };
  return { ctx: item, operations: operationsFor(item).filter((op) => op.group !== 'global') };
}
