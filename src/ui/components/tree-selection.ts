// The files tree's selection (#818), apart from FilesPanel.tsx as tree-drag.ts is: a set of paths and the anchor a ⇧-click ranges from, as
// VS Code's explorer keeps them. Pure.

export interface TreeSelection { paths: ReadonlySet<string>; anchor?: string }

/** How a click selects: one row, ⌘ (Ctrl off macOS) toggling one, or ⇧ ranging from the anchor. */
export type ClickMode = 'single' | 'toggle' | 'range';

export const NO_SELECTION: TreeSelection = { paths: new Set() };

/** One row selected, the anchor on it. */
export const single = (path: string): TreeSelection => ({ paths: new Set([path]), anchor: path });

/** A click's mode from its modifiers. */
export function modeOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, mac: boolean): ClickMode {
  if (event.shiftKey) return 'range';
  return (mac ? event.metaKey : event.ctrlKey) ? 'toggle' : 'single';
}

/** The selection after a click on `path`: the row alone; ⌘ toggles it and moves the anchor there; ⇧ takes every visible row from the
 *  anchor to it, the anchor kept. A range with no anchor shown selects the row alone. */
export function clicked(selection: TreeSelection, path: string, mode: ClickMode, visible: readonly string[]): TreeSelection {
  if (mode === 'single') return single(path);
  if (mode === 'toggle') {
    const paths = new Set(selection.paths); // a copy: the selection given is never touched
    if (!paths.delete(path)) paths.add(path);
    return { paths, anchor: path };
  }
  const from = selection.anchor === undefined ? -1 : visible.indexOf(selection.anchor);
  const to = visible.indexOf(path);
  if (from === -1 || to === -1) return single(path);
  return { paths: new Set(visible.slice(Math.min(from, to), Math.max(from, to) + 1)), anchor: selection.anchor };
}

/** What an action on `path` takes (#818): the selection when the row is in it, else the row alone. */
export const actedOn = (selection: TreeSelection, path: string): string[] => (selection.paths.has(path) ? [...selection.paths] : [path]);
