// The Hive's keys over the editor pane (#717): a key a global or an activity's shortcut binds acts in the Hive, never in Monaco, as a
// terminal's keys do (#448). Every other key, the flow's ⌘F among them (Monaco's find), stays the editor's.
import { SHORTCUTS } from '../../shortcut-registry';
import type { KeyLike } from '../../shortcuts';
import type { OperationId } from '../../types';
import { pressed } from '@/lib/shortcut-bindings';

/** The Hive keys that stay the editor's inside it (#780): ⌘. is Monaco's quick fix; sleepSession keeps it everywhere else. */
export const EDITOR_KEYS: readonly OperationId[] = ['sleepSession'];
const isInEditor = (target: EventTarget | null): boolean => target instanceof Element && target.closest('.monaco-editor') !== null;
/** Whether shortcut `id` yields to the editor at `target` (#780). */
export const isEditorKey = (id: OperationId, target: EventTarget | null): boolean => EDITOR_KEYS.includes(id) && isInEditor(target);

/** Whether a keydown is a shortcut that acts with the focus in a terminal or the editor (#585: inTerminal, the global and activities scopes),
 * but the editor's own, EDITOR_KEYS. */
export const isHiveKey = (event: KeyLike): boolean => SHORTCUTS.some((def) => def.inTerminal && !EDITOR_KEYS.includes(def.id) && pressed(event, def.id));

/** Keeps a Hive key from Monaco's own handlers below `host` (#717). The window's capture listeners already took the keys they act on;
 * stopping the rest here leaves their default, so a menu accelerator still fires. Returns the undo. */
export function passHiveKeys(host: HTMLElement): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (isHiveKey(event)) event.stopPropagation();
  };
  host.addEventListener('keydown', listener, true);
  return () => host.removeEventListener('keydown', listener, true);
}
