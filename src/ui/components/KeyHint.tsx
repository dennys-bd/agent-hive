import { type FixedShortcutId, fixedShortcut } from '../../shortcut-registry';
import { displayBinding, displayKeys, fixedKeys } from '../../shortcuts';
import type { OperationId } from '../../types';
import { binding, isMac } from '@/lib/shortcut-bindings';

/** A shortcut's keys at the end of a menu item (#536), in the design system's shortcut style; nothing while the shortcut is off. Read at
 * render, so a Settings save shows at the next open. */
export function KeyHint({ id }: { id: OperationId }) {
  const keys = binding(id);
  return keys === null ? null : <span className="ml-auto text-muted-foreground text-xs tracking-widest">{displayBinding(keys, isMac())}</span>;
}

/** A shortcut's keys inside a button (#585), muted beside its text and aria-hidden, so the button's name stays its text; nothing while the
 * shortcut is off. Read at render. */
export function ButtonKeyHint({ id }: { id: OperationId }) {
  const keys = binding(id);
  return keys === null ? null : <span aria-hidden="true" className="text-xs tracking-widest opacity-60">{displayBinding(keys, isMac())}</span>;
}

/** A fixed row's keys at the end of a menu item (#818): the files tree's cut, copy and paste, which are no shortcut. */
export function FixedKeyHint({ id }: { id: FixedShortcutId }) {
  return <span className="ml-auto text-muted-foreground text-xs tracking-widest">{displayKeys(fixedKeys(fixedShortcut(id), isMac()), isMac())}</span>;
}
