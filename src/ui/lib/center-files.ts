// The center's file tabs (#818), beside center-layout.ts: the tabs that follow a file the tree renamed or moved. Pure.
import { type CenterLayout, type CenterTabRef, closeRef, groupsOf, mapTabs, refKey } from './center-layout.js';
import { untitledPath } from './editor-models.js';
import { renamedPath } from './file-tree.js';

// A file, preview, changes or design tab (#109) on `from` or under it, on its new path; any other tab as it is
function renamedRef(ref: CenterTabRef, from: string, to: string): CenterTabRef {
  if (ref.kind !== 'file' && ref.kind !== 'preview' && ref.kind !== 'changes' && ref.kind !== 'design') return ref;
  const path = renamedPath(ref.path, from, to);
  return path === undefined ? ref : { ...ref, path };
}

/** The layout with its tabs on `from` following it to `to` (#818), each in its place. */
export const renameTabs = (layout: CenterLayout, from: string, to: string): CenterLayout => mapTabs(layout, (ref) => renamedRef(ref, from, to));

/** The buffer a tab shows (#717, #668, #818): a file's or its changes', an untitled tab's own; none for any other tab. */
export function bufferPath(ref: CenterTabRef): string | undefined {
  if (ref.kind === 'file' || ref.kind === 'changes') return ref.path;
  return ref.kind === 'untitled' ? untitledPath(ref.n) : undefined;
}

/** The layouts as the view state keeps them (#818): an untitled tab has no file to read back, so it never outlives the page; a layout left
 *  with no tab goes. */
export function storableLayouts(layouts: Record<string, CenterLayout>): Record<string, CenterLayout> {
  return Object.fromEntries(Object.entries(layouts).flatMap(([key, layout]) => {
    const untitled = groupsOf(layout.root).flatMap((group) => group.tabs).filter((ref) => ref.kind === 'untitled').map(refKey);
    const kept = untitled.reduce<CenterLayout | undefined>((rest, tabKey) => rest && closeRef(rest, tabKey), layout);
    return kept === undefined ? [] : [[key, kept] as const];
  }));
}
