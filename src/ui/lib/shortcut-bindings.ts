// The page's keyboard shortcut bindings (#449), the way trusted-links.ts holds its domains: the saved config's changes, set from GET /settings
// by App (the main window) and terminal.ts (a detached window), and read at every key, so a Settings save reaches the open panels and terminals at
// once. A binding is resolved at each read against this platform's table (#585).
import { type FixedShortcutId, fixedShortcut, shortcutDef } from '../../shortcut-registry.js';
import { bindingOf, fixedKeys, type KeyLike, matches } from '../../shortcuts.js';
import type { OperationId, Shortcuts } from '../../types.js';

let saved: Shortcuts = {}; // no change until the page reads GET /settings: every default

/** The saved changes, as GET /settings answered them. */
export function setShortcuts(shortcuts: Shortcuts): void {
  saved = shortcuts;
}

/** The saved changes, a copy (#639): the shortcut map lists the bindings the keys match, and a Settings save shows on its next open. */
export const savedShortcuts = (): Shortcuts => ({ ...saved });

/** A shortcut's current binding on this platform; null while it is turned off. */
export const binding = (id: OperationId): string | null => bindingOf(saved, shortcutDef(id), isMac());

// Cmd is the shortcut modifier on macOS; elsewhere CmdOrCtrl is Ctrl. jsdom's platform is '', so the UI tests run as off macOS.
export const isMac = (): boolean => /Mac/.test(navigator.platform);

/** Whether a keydown is shortcut `id` on this platform, with exactly its modifiers; a shortcut turned off never is, nor a soon one, whose
 * operation does not exist yet (#585). */
export function pressed(event: KeyLike, id: OperationId): boolean {
  if (shortcutDef(id).soon) return false;
  const current = binding(id);
  return current !== null && matches(event, current, isMac());
}

/** Which key of a fixed row a keydown is (#585), by its index in this platform's list; -1 for none. */
export const pressedFixed = (event: KeyLike, id: FixedShortcutId): number =>
  fixedKeys(fixedShortcut(id), isMac()).findIndex((key) => matches(event, key, isMac()));

/** Whether a Settings key field is recording at `target` (#449). The page's own shortcuts that run before the field sees the key (the dock's panel keys on
 * window's capture phase, the dialog's Escape on the document's) leave it to the field. */
export const isRecording = (target: EventTarget | null): boolean => target instanceof Element && target.closest('[data-shortcut-recording]') !== null;

/** Whether a key lands in a text field (#585): an input, a textarea (xterm's among them), a select or an editable element. A bare or Alt key
 * there is typing, never a shortcut of the page's. */
export const isTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** Whether a key lands inside an open dialog (#585): a flow key must not act behind it, even from one of the dialog's buttons. */
export const isInDialog = (target: EventTarget | null): boolean => target instanceof Element && target.closest('[role="dialog"]') !== null;
