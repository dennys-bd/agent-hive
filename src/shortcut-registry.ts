// The Hive's keyboard shortcuts as data (#449, #585): the map of every key in Settings › atalhos order, grouped by where a key acts, with a
// default on macOS and one Linux and Windows share. The rules of a binding live in shortcuts.ts. No Node or Electron import: the UI bundles it.
import type { OperationId } from './types.js';
import type { MessageKey } from './ui/i18n.js';

/** Where a key acts (#585), the atalhos section's cards in order: everywhere, with an activity shown, with the focus in the files tree (#818),
 * with the flow shown, in a dialog. */
export const SHORTCUT_SCOPES = ['global', 'activities', 'files', 'flow', 'dialogs'] as const;
export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];

/** A default per platform (#585): macOS's, and the one Linux and Windows share, where Ctrl alone would take a key the terminal reads. null:
 * unbound until the user binds one (#818). */
export interface PlatformKeys { mac: string | null; other: string | null }

/** A rebindable shortcut. inTerminal: it acts while the focus is in a terminal, so a key the program reads warns. soon: the operation does
 * not exist yet, so its row is greyed and its key only reserved (#585). */
export interface ShortcutDef { id: OperationId; defaults: PlatformKeys; inTerminal: boolean; label: MessageKey; scope: ShortcutScope; soon?: true }

export type FixedShortcutId =
  | 'signal' | 'settings' | 'quit' | 'goToTab' | 'copy' | 'paste' | 'selectAll' | 'moveFocus' | 'openDetails' | 'closeDetails' | 'runStages' | 'freeSession' | 'approve'
  | 'feedback' | 'openActivity' | 'autoTask' | 'taskMenu' | 'pickSource' | 'cancel' | 'treeCut' | 'treeCopy' | 'treePaste' | 'zoomFit';

/** A key that is no binding (#481, #585): listed read only, never in the config. keys: every key it acts on per platform, a range expanded. */
export interface FixedShortcut { id: FixedShortcutId; label: MessageKey; scope: ShortcutScope; keys: { mac: string[]; other: string[] }; soon?: true }

const SOON = { soon: true } as const;
const UNBOUND: PlatformKeys = { mac: null, other: null }; // #818
const both = (binding: string): PlatformKeys => ({ mac: binding, other: binding });
const same = (keys: string[]): FixedShortcut['keys'] => ({ mac: keys, other: keys });
const digits = (prefix: string, from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
// The map's "(in terminal)" scopes: a global key and an activity's act with the focus in a terminal. `as const` keeps each label a key
// tsc checks against i18n.ts
const row = (id: OperationId, defaults: PlatformKeys, scope: ShortcutScope, extra: { soon?: true } = {}): ShortcutDef =>
  ({ id, defaults, inTerminal: scope === 'global' || scope === 'activities', label: `shortcuts.${id}` as const, scope, ...extra });
const fixed = (id: FixedShortcutId, scope: ShortcutScope, keys: FixedShortcut['keys'], extra: { soon?: true } = {}): FixedShortcut =>
  ({ id, label: `shortcuts.fixed.${id}` as const, scope, keys, ...extra });

/** Every row of the map (#585), scope by scope in its order. Off macOS a key the terminal reads moves to Ctrl+Shift, and the diff takes
 * Ctrl+Shift+G: Ctrl+Alt is AltGr on Windows and types characters. */
export const SHORTCUT_MAP: readonly (ShortcutDef | FixedShortcut)[] = [
  row('viewActivities', both('CmdOrCtrl+1'), 'global'), // the header's first view takes Cmd+1 (#746)
  row('viewFlow', both('CmdOrCtrl+2'), 'global'),
  row('search', { mac: 'CmdOrCtrl+P', other: 'CmdOrCtrl+Shift+P' }, 'global'),
  row('searchOperations', { mac: 'CmdOrCtrl+Shift+P', other: 'F1' }, 'global'),
  row('newActivity', { mac: 'CmdOrCtrl+N', other: 'CmdOrCtrl+Shift+N' }, 'global'),
  row('runCommand', { mac: 'CmdOrCtrl+R', other: 'CmdOrCtrl+Shift+R' }, 'global'),
  row('toggleConsole', { mac: 'CmdOrCtrl+J', other: 'CmdOrCtrl+Shift+J' }, 'global'),
  row('problems', both('CmdOrCtrl+Shift+M'), 'global'), // #225: the drawer's problems tab; inside a dialog the key is switchStartMode's
  fixed('signal', 'global', { mac: digits('CmdOrCtrl+Alt+', 1, 3), other: digits('CmdOrCtrl+Shift+', 1, 3) }),
  row('toggleLeft', { mac: 'CmdOrCtrl+B', other: 'CmdOrCtrl+Shift+B' }, 'global'),
  row('toggleRight', { mac: 'CmdOrCtrl+Shift+B', other: 'CmdOrCtrl+Alt+Shift+B' }, 'global'),
  fixed('settings', 'global', same(['CmdOrCtrl+,'])),
  row('shortcutMap', both('CmdOrCtrl+/'), 'global'), // #639: the map of the keys that work now
  row('fullScreen', { mac: 'CmdOrCtrl+Shift+F', other: 'F11' }, 'global'),
  row('closeWindow', { mac: 'CmdOrCtrl+Shift+W', other: 'CmdOrCtrl+Alt+Shift+W' }, 'global'),
  fixed('quit', 'global', same(['CmdOrCtrl+Q'])),
  row('newTerminal', { mac: 'CmdOrCtrl+T', other: 'CmdOrCtrl+Shift+T' }, 'activities'),
  row('newSession', { mac: 'CmdOrCtrl+Shift+N', other: 'CmdOrCtrl+Alt+Shift+N' }, 'activities'),
  row('newSessionDialog', { mac: 'CmdOrCtrl+Alt+N', other: 'CmdOrCtrl+Alt+Shift+S' }, 'activities'), // #257: off macOS no plain Ctrl+Alt (AltGr), and Ctrl+Alt+Shift+N is newSession's
  row('openDiff', { mac: 'CmdOrCtrl+Alt+C', other: 'CmdOrCtrl+Shift+G' }, 'activities'),
  row('newFile', { mac: 'CmdOrCtrl+Alt+F', other: 'CmdOrCtrl+Alt+Shift+F' }, 'activities'), // #257: the +'s file; in the editor ⌘⌥F stays Monaco's replace (EDITOR_KEYS)
  row('close', { mac: 'CmdOrCtrl+W', other: 'CmdOrCtrl+Shift+W' }, 'activities'),
  row('nextTab', { mac: 'Ctrl+Tab', other: 'CmdOrCtrl+Tab' }, 'activities', SOON),
  row('prevTab', { mac: 'Ctrl+Shift+Tab', other: 'CmdOrCtrl+Shift+Tab' }, 'activities', SOON),
  // macOS: loses to "switch to desktop N" when the user turns it on
  fixed('goToTab', 'activities', { mac: digits('Ctrl+', 1, 9), other: digits('Alt+', 1, 9) }, SOON),
  // The terminal's copy, paste and select all (#644). On macOS the Edit menu's roles and xterm act on ⌘C / ⌘V / ⌘A. Off macOS the
  // terminal's handler acts, and Ctrl+C / V / A stay the program's. Fixed rows, so a shortcut on these keys collides in Settings instead of
  // silently beating the terminal from the capture phase.
  fixed('copy', 'activities', { mac: ['CmdOrCtrl+C'], other: ['CmdOrCtrl+Shift+C', 'CmdOrCtrl+Insert'] }),
  fixed('paste', 'activities', { mac: ['CmdOrCtrl+V'], other: ['CmdOrCtrl+Shift+V', 'Shift+Insert'] }),
  fixed('selectAll', 'activities', { mac: ['CmdOrCtrl+A'], other: ['CmdOrCtrl+Shift+A'] }),
  row('splitSame', { mac: 'CmdOrCtrl+\\', other: 'CmdOrCtrl+Shift+\\' }, 'activities'),
  row('splitTerminalVertical', { mac: 'CmdOrCtrl+D', other: 'CmdOrCtrl+Shift+D' }, 'activities'),
  row('splitTerminalHorizontal', { mac: 'CmdOrCtrl+Shift+D', other: 'CmdOrCtrl+Alt+Shift+D' }, 'activities'),
  row('clear', { mac: 'CmdOrCtrl+K', other: 'CmdOrCtrl+Shift+K' }, 'activities'),
  // #12: the terminal's find bar. Off macOS Ctrl+F is the program's (readline's forward-char); Cmd+F's searchTasks acts only in the flow
  row('findInTerminal', { mac: 'CmdOrCtrl+F', other: 'CmdOrCtrl+Shift+F' }, 'activities'),
  row('nextPane', { mac: 'CmdOrCtrl+]', other: 'CmdOrCtrl+Shift+]' }, 'activities', SOON),
  row('prevPane', { mac: 'CmdOrCtrl+[', other: 'CmdOrCtrl+Shift+[' }, 'activities', SOON),
  row('nextActivity', { mac: 'CmdOrCtrl+Alt+Down', other: 'CmdOrCtrl+Shift+PageDown' }, 'activities', SOON),
  row('prevActivity', { mac: 'CmdOrCtrl+Alt+Up', other: 'CmdOrCtrl+Shift+PageUp' }, 'activities', SOON),
  row('toggleSideTab', { mac: 'CmdOrCtrl+Shift+E', other: 'CmdOrCtrl+Alt+Shift+E' }, 'activities'),
  row('sleepSession', { mac: 'CmdOrCtrl+.', other: 'CmdOrCtrl+Shift+.' }, 'activities'), // #672: was stopSession, same keys
  row('sleepAll', { mac: 'CmdOrCtrl+Shift+.', other: 'CmdOrCtrl+Alt+Shift+.' }, 'activities'), // #672: was stopAll, same keys
  // #818: the files tree's keys act only with the focus in the tree (tree-keys.ts). Cut, copy and paste are the tree's DOM events on the
  // system keys, as its ⌘V has been since #594, so they never compete with a terminal's
  row('treeNewFile', UNBOUND, 'files'),
  row('treeNewFolder', UNBOUND, 'files'),
  row('treeRename', { mac: 'Enter', other: 'F2' }, 'files'),
  row('treeDelete', { mac: 'CmdOrCtrl+Backspace', other: 'Delete' }, 'files'),
  row('treeReveal', both('CmdOrCtrl+Alt+R'), 'files'), // VS Code's Cmd+Alt+C copy path is openDiff here
  row('treeOpenTerminal', UNBOUND, 'files'),
  row('treeCopyPath', UNBOUND, 'files'),
  row('treeCopyRelativePath', UNBOUND, 'files'),
  row('treeCopyCheckoutPath', UNBOUND, 'files'), // #131: the path from the main checkout
  fixed('treeCut', 'files', same(['CmdOrCtrl+X'])),
  fixed('treeCopy', 'files', same(['CmdOrCtrl+C'])),
  fixed('treePaste', 'files', same(['CmdOrCtrl+V'])),
  row('searchTasks', both('CmdOrCtrl+F'), 'flow'),
  fixed('moveFocus', 'flow', same(['Up', 'Down', 'Left', 'Right'])),
  fixed('openDetails', 'flow', same(['Enter'])),
  fixed('closeDetails', 'flow', same(['Escape'])),
  fixed('runStages', 'flow', same(['I'])),
  fixed('freeSession', 'flow', same(['L'])),
  fixed('approve', 'flow', same(['A'])),
  fixed('feedback', 'flow', same(['F'])),
  fixed('openActivity', 'flow', same(['O'])),
  fixed('autoTask', 'flow', same(['S'])),
  fixed('taskMenu', 'flow', { mac: ['M'], other: ['M', 'Shift+F10'] }),
  fixed('pickSource', 'flow', same(digits('Alt+', 0, 9))),
  row('refreshFlow', { mac: 'CmdOrCtrl+Alt+R', other: 'F5' }, 'flow'),
  // #911: back from an issue or PR page, as browsers and Finder bind ⌘[; Alt+Left elsewhere, the browsers' back. Before the zoom rows, so the
  // map's flow section still ends on them
  row('goBack', { mac: 'CmdOrCtrl+[', other: 'Alt+Left' }, 'flow'),
  // #910: the canvas's zoom; + is the = key without Shift
  row('zoomOut', both('CmdOrCtrl+-'), 'flow'),
  row('zoomIn', both('CmdOrCtrl+='), 'flow'),
  row('zoomReset', both('CmdOrCtrl+0'), 'flow'),
  // The handoff's ⇧1: Shift+digit types and is no binding (#585), so fit is a fixed key the flow matches by hand, as it does I, L and A
  fixed('zoomFit', 'flow', same(['Shift+1'])),
  row('confirm', both('CmdOrCtrl+Enter'), 'dialogs'),
  row('feedbackQueue', both('CmdOrCtrl+Shift+Enter'), 'dialogs'),
  row('switchStartMode', both('CmdOrCtrl+Shift+M'), 'dialogs'),
  fixed('cancel', 'dialogs', same(['Escape'])),
];

/** The global keys that do nothing with the focus in a dialog (#225), so a dialog's own key may hold the same binding: problems' ⌘⇧M is
 * the Start dialog's switchStartMode there. Their listener refuses a key inside a dialog (isInDialog, ConsoleDrawer). */
export const YIELDS_TO_DIALOGS: readonly OperationId[] = ['problems'];

export const SHORTCUTS: readonly ShortcutDef[] = SHORTCUT_MAP.filter((r): r is ShortcutDef => !('keys' in r));
export const FIXED_SHORTCUTS: readonly FixedShortcut[] = SHORTCUT_MAP.filter((r): r is FixedShortcut => 'keys' in r);

export const shortcutDef = (id: OperationId): ShortcutDef => SHORTCUTS.find((s) => s.id === id) as ShortcutDef; // every id has one
export const fixedShortcut = (id: FixedShortcutId): FixedShortcut => FIXED_SHORTCUTS.find((f) => f.id === id) as FixedShortcut; // every id has one
