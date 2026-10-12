import { type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { commandsOf } from '../../task-runs';
import { runCommand } from '@/components/actions';
import { openLocalRun } from '@/components/local-runs';
import { AgentsContext, openNew } from '@/components/NewRunButton';
import { rememberWorkspace, WorkspacePicker } from '@/components/QuickDialogs';
import { OperationDialogs } from '@/components/OperationDialogs';
import { SearchDialog } from '@/components/SearchDialog';
import { ShortcutMapDialog } from '@/components/ShortcutMapDialog';
import type { OpenRun } from '@/components/terminal-tabs';
import type { AgentAvailability, EffectiveLimits, State, Task } from '../../types';
import type { Activity } from '@/lib/activities';
import { onQuickKey, type QuickAction } from '@/lib/dock-layout';
import { readFocusTarget } from '@/lib/focus-target';
import type { FocusTarget, OperationContext, OperationDialog, SearchNav } from '@/lib/operations';
import { commandsPage, commandTask } from '@/lib/operations-activity';
import type { Scope } from '@/lib/search';
import { isInDialog } from '@/lib/shortcut-bindings';

/** What the search reads beyond the keys (#584): the State, the activities, and where its rows lead. shownRun: the run the shown activity's
 * focused group shows (#641). openShortcuts: Settings on the shortcuts, the map's link (#639); absent (a harness), no link. */
export interface SearchHost {
  state: State; effective?: EffectiveLimits; activities: Activity[]; shown?: Activity; shownRun?: string; nav: Omit<SearchNav, 'dialog'>; openShortcuts?(): void;
}

// The confirm an operation opens (#584), after the search closed. Keyed, so the same pick again opens a fresh one
function useOperationDialog(search?: SearchHost): { open(dialog: OperationDialog): void; element: ReactNode } {
  const [pending, setPending] = useState<{ dialog: OperationDialog; key: number }>();
  const open = useCallback((dialog: OperationDialog) => setPending((prev) => ({ dialog, key: (prev?.key ?? 0) + 1 })), []);
  const element = pending && search && (
    <OperationDialogs key={pending.key} dialog={pending.dialog} state={search.state} onStarted={search.nav.openStarted} onClose={() => setPending(undefined)} />
  );
  return { open, element };
}

// `shown` is the activity the center shows: the one the activity operations act on. agents: the ones boot found (#931)
const searchContext = (host: SearchHost, focus: FocusTarget | undefined, dialog: (next: OperationDialog) => void, agents: readonly AgentAvailability[]): OperationContext => ({
  state: host.state, effective: host.effective, focus, activity: host.shown, isShown: host.shown !== undefined, shownRun: host.shownRun, agents, nav: { ...host.nav, dialog },
});

interface QuickArgs {
  workspaces: string[]; current?: Activity; openRun: OpenRun; // a workspace's terminal goes through it too, to its local activity (#590)
  newActivity(): void; // nova atividade: the Start dialog (redesign 11)
  hasKeys: boolean; // the window's own keys: off in the terminal's harness, as the section keys are
  search?: SearchHost; // absent (the terminal's harness): the search keys open nothing
}

/** What the home's buttons and the ⌘N, ⌘P, ⌘⇧P, ⌘T, ⌘R and ⌘/ keys do (redesign 08, #584, #585, #639), with the dialogs they open. */
export interface QuickActions { newActivity(): void; localTerminal(): void; dialogs: ReactNode }

// commands: the run-command key's task (#585), whose commands the search opens on. shortcutMap: the shortcut map (#639)
type Open = { kind: 'search'; scope: Scope; focus?: FocusTarget; returnTo: Element | null; commands?: Task } | { kind: 'picker' } | { kind: 'shortcutMap' };

// The run-command key (#585): the shown activity's task, else the task focused in the flow. One command runs at once (a missing worktree is
// the route's toast), several open the search on that task's commands, none does nothing
function runCommandKey(host: SearchHost, openCommands: (task: Task, focus?: FocusTarget) => void): void {
  const focus = readFocusTarget(host.state);
  const task = commandTask(host.shown, focus);
  if (task === undefined) return;
  const names = commandsOf(task, host.state);
  if (names.length === 1) runCommand(task, host.state, names[0], host.nav.openConsole);
  else if (names.length > 1) openCommands(task, focus);
}

// The search while open (#584), on the run-command key's page when it opened it (#585)
function searchDialog(open: Open | undefined, search: SearchHost | undefined, agents: readonly AgentAvailability[], onOperation: (dialog: OperationDialog) => void, onClose: () => void): ReactNode {
  if (open?.kind !== 'search' || search === undefined) return null;
  const ctx = searchContext(search, open.focus, onOperation, agents);
  return <SearchDialog key={open.scope} scope={open.scope} returnTo={open.returnTo} ctx={ctx} page={open.commands && commandsPage(open.commands, ctx)} activities={search.activities} onClose={onClose} />;
}

// Settings is a full page over the inert dashboard (#510), not a [role="dialog"], yet it holds the window as one does (#639)
const SETTINGS_PAGE = '[data-settings-page]';

// Whether another modal holds the window (#639): the focus inside a dialog (Start, a confirm, a menu's), or the Settings page shown
const isWindowHeld = (): boolean => isInDialog(document.activeElement) || document.querySelector(SETTINGS_PAGE) !== null;

// The shortcut map's key (#639): it closes the map while it shows. Otherwise it opens the map, unless one of this hook's dialogs is open (the
// search, the picker), which stays as it is, or another modal holds the window: one modal at a time, and none of them loses its state
function toggleMap(prev: Open | undefined, isHeld: boolean): Open | undefined {
  if (prev?.kind === 'shortcutMap') return undefined;
  return prev !== undefined || isHeld ? prev : { kind: 'shortcutMap' };
}

// The map's link (#639): the map closes first, then Settings opens on the shortcuts, one modal at a time; none without a way to Settings
const editShortcuts = (close: () => void, openShortcuts?: () => void): (() => void) | undefined =>
  openShortcuts && (() => { close(); openShortcuts(); });

/** nova atividade opens the Start dialog; buscar opens the search (#584); a new terminal opens in the picked activity, else in a workspace's
 * local activity (#590): at once with one workspace, through the picker with several, and not at all with none. ⌘/ toggles the map (#639). */
export function useQuickActions({ workspaces, current, openRun, newActivity, hasKeys, search }: QuickArgs): QuickActions {
  const [open, setOpen] = useState<Open>();
  const operation = useOperationDialog(search);
  const agents = useContext(AgentsContext);
  const close = useCallback(() => setOpen(undefined), []);
  const onPick = useCallback((workspace: string) => {
    rememberWorkspace(workspace);
    setOpen(undefined);
    openLocalRun(workspace, 'terminal', openRun);
  }, [openRun]);
  const localTerminal = (): void => {
    if (workspaces.length === 1) onPick(workspaces[0]);
    else if (workspaces.length > 1) setOpen({ kind: 'picker' });
  };
  const openSearch = (scope: Scope): void => {
    // The focus is read before the dialog takes it: the key's listener runs in the window's capture phase, ahead of any focus move (#584)
    // Pressed while it is open, the focus is the search's own input: the first focus target and return point stay, and only the scope changes
    if (search === undefined) return;
    setOpen((prev) => (prev?.kind === 'search' ? { ...prev, scope } : { kind: 'search', scope, focus: readFocusTarget(search.state), returnTo: document.activeElement }));
  };
  const handlers: Record<QuickAction, () => void> = {
    newActivity,
    search: () => openSearch('all'),
    searchOperations: () => openSearch('commands'),
    newTerminal: () => (current === undefined ? localTerminal() : openNew(current, 'terminal', openRun)),
    runCommand: () => {
      if (search) runCommandKey(search, (task, focus) => setOpen({ kind: 'search', scope: 'commands', focus, returnTo: document.activeElement, commands: task }));
    },
    // ⌘/ (#639), the DOM read as the key found it. The search's pick closes the search, then runs this (#584): its field still has the
    // focus, but the window is free. A key pressed while the search is open finds `prev` still the search, which stays
    shortcutMap: () => { const isHeld = open?.kind !== 'search' && isWindowHeld(); setOpen((prev) => toggleMap(prev, isHeld)); },
  };
  // The key listener subscribes once; it reads the handlers of the latest render
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => (hasKeys ? onQuickKey((action) => latest.current[action]()) : undefined), [hasKeys]);
  const dialogs = (
    <>
      {searchDialog(open, search, agents, operation.open, close)}
      <WorkspacePicker open={open?.kind === 'picker'} workspaces={workspaces} onPick={onPick} onClose={close} />
      <ShortcutMapDialog open={open?.kind === 'shortcutMap'} onClose={close} onEditShortcuts={editShortcuts(close, search?.openShortcuts)} />
      {operation.element}
    </>
  );
  return { newActivity, localTerminal, dialogs };
}
