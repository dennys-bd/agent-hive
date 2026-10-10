// The shortcut map's rows (#639): the keys that work now, scope by scope as Settings › atalhos lists them, each in this platform's symbols.
// Pure, so the dialog and its tests read the same list. Compiled by the main tsc too, hence the .js imports.
import { type FixedShortcut, SHORTCUT_MAP, SHORTCUT_SCOPES, type ShortcutDef, type ShortcutScope } from '../../shortcut-registry.js';
import { bindingOf, displayBinding, displayKeys, fixedKeys } from '../../shortcuts.js';
import type { Shortcuts } from '../../types.js';
import type { MessageKey } from '../i18n.js';

/** keys: already in this platform's symbols, a range as one key (⌘⌥1–3). */
export interface MapRow { label: MessageKey; keys: string }
export interface MapSection { scope: ShortcutScope; rows: MapRow[] }

// A row as the map shows it, or none: a soon row does nothing yet, and a shortcut turned off has no key
function mapRow(row: ShortcutDef | FixedShortcut, shortcuts: Shortcuts, mac: boolean): MapRow[] {
  if (row.soon) return [];
  if ('keys' in row) return [{ label: row.label, keys: displayKeys(fixedKeys(row, mac), mac) }];
  const binding = bindingOf(shortcuts, row, mac);
  return binding === null ? [] : [{ label: row.label, keys: displayBinding(binding, mac) }];
}

/** The map's sections (#639): SHORTCUT_MAP in order, the user's changes applied, soon rows and shortcuts turned off left out; a scope with no
 * row left is not shown. */
export function shortcutMapSections(shortcuts: Shortcuts, mac: boolean): MapSection[] {
  return SHORTCUT_SCOPES.flatMap((scope) => {
    const rows = SHORTCUT_MAP.filter((row) => row.scope === scope).flatMap((row) => mapRow(row, shortcuts, mac));
    return rows.length === 0 ? [] : [{ scope, rows }];
  });
}
