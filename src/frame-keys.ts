// The keys main takes from a focused subframe for the page (#906): a key pressed in an <iframe> (the design pane, draw.io) fires in that
// frame's document and never reaches the window's capture listeners. before-input-event sees every key of every frame first, so main
// forwards the page's global keys from there. Electron is imported for its types only, so node:test covers the rule.
import type { Input } from 'electron';
import { menuKeys } from './app-menu.js';
import { FIXED_SHORTCUTS, SHORTCUTS, type ShortcutScope } from './shortcut-registry.js';
import { type Bindings, bindingFromEvent, effectiveBindings, fixedKeys, isReserved, type KeyLike, matches } from './shortcuts.js';
import type { OperationId, Shortcuts } from './types.js';

/** The channel the page's preload listens on (window-preload.cts writes it as a literal: a sandboxed preload imports nothing of ours). */
export const FRAME_KEY_CHANNEL = 'window:frameKey';

// The panes sit in the activities view, so its keys cross a frame with the global ones; a files, flow or dialog key acts only with its own
// focus, which a frame never has
const FORWARDED_SCOPES: readonly ShortcutScope[] = ['global', 'activities'];
// The activity keys only a terminal's own handler reads (terminalKeys in ui/lib/xterm-setup.ts, TerminalFind's field): no window listener
// acts on them, so taken from a frame they would do nothing and be lost to it (⌘K, ⌘F in draw.io)
const TERMINAL_ONLY: readonly OperationId[] = ['clear', 'findInTerminal'];
// bindingFromEvent orders CmdOrCtrl, Ctrl, Alt, Shift: a guard modifier, when there is one, leads. Without one the key is typing
const HAS_GUARD = /^(?:CmdOrCtrl|Ctrl|Alt)\+/;

const keyLikeOf = (input: Input): KeyLike =>
  ({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift });

// Every key the page's capture listeners act on from anywhere in the window: the forwarded scopes' bindings (a soon one never fires) and
// the global fixed rows' keys
function forwardedKeys(bindings: Bindings, isMac: boolean): string[] {
  const shortcuts = SHORTCUTS.filter((def) => FORWARDED_SCOPES.includes(def.scope) && def.soon === undefined && !TERMINAL_ONLY.includes(def.id))
    .flatMap((def) => bindings[def.id] ?? []);
  const fixed = FIXED_SHORTCUTS.filter((row) => row.scope === 'global' && row.soon === undefined).flatMap((row) => fixedKeys(row, isMac));
  return [...shortcuts, ...fixed];
}

/** The key to forward for a keyDown in a subframe (#906), or undefined to leave it to the frame: a bare or Shift key (typing), a reserved
 *  key (copy, paste, undo stay the frame's), a menu key (the menu handles it in every frame, and preventing it would cancel the accelerator),
 *  or any key no global or activities listener acts on. Bindings are read at each key: Settings' changes reach it at once. */
export function frameKeyOf(input: Input, shortcuts: Shortcuts, isMac: boolean): KeyLike | undefined {
  if (input.type !== 'keyDown') return undefined;
  const key = keyLikeOf(input);
  const pressed = bindingFromEvent(key, isMac);
  if (pressed === undefined || !HAS_GUARD.test(pressed) || isReserved(pressed)) return undefined;
  const bindings = effectiveBindings(shortcuts, isMac);
  const isMenuKey = Object.values(menuKeys(bindings)).some((binding) => binding !== null && matches(key, binding, isMac));
  return !isMenuKey && forwardedKeys(bindings, isMac).some((binding) => matches(key, binding, isMac)) ? key : undefined;
}

/** What forwardFrameKeys reads of a window's WebContents (#906); a real WebContents is one, a test passes a plain fake. Frames compare by
 *  frameTreeNodeId, which Electron keeps for a frame's whole life. */
export interface FrameKeyContents {
  on(event: 'before-input-event', listener: (event: { preventDefault(): void }, input: Input) => void): unknown;
  readonly focusedFrame: { frameTreeNodeId: number } | null;
  readonly mainFrame: { frameTreeNodeId: number };
  send(channel: string, ...args: unknown[]): void;
}

/** Main's cached shortcuts (loadSettings refreshes them on settingsChanged) and the platform, read at each key. */
export interface FrameKeySettings { shortcuts: Shortcuts; isMac: boolean }

/** Every key of a focused subframe that frameKeyOf forwards (#906): prevented, so the frame never gets it (⌘B no longer bolds in draw.io),
 *  and sent to the window's page, which dispatches it where its capture listeners act. A key in the main document goes on untouched, read
 *  before any binding work: it is every keystroke of the page. */
export function forwardFrameKeys(contents: FrameKeyContents, read: () => FrameKeySettings): void {
  contents.on('before-input-event', (event, input) => {
    const focused = contents.focusedFrame;
    if (focused === null || focused.frameTreeNodeId === contents.mainFrame.frameTreeNodeId) return;
    const { shortcuts, isMac } = read();
    const key = frameKeyOf(input, shortcuts, isMac);
    if (key === undefined) return;
    event.preventDefault();
    contents.send(FRAME_KEY_CHANNEL, key);
  });
}
