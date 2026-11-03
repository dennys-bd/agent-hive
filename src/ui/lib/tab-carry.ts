// A moved tab's carry on this page (#551): taken from the editor's models before the tab leaves, applied to them when it arrives. Only a dirty
// buffer travels: a clean one re-reads from the disk, and the daemon already holds runs, diffs, consoles and designs.
import type { CenterTabRef, TabCarry } from '../../tab-carry.js';
import { bufferPath } from './center-files.js';
import * as models from './editor-models.js';

/** What the tab takes with it (#551): its buffer's text as save sends it (BOM kept) over the base it stands on, and the editor's view state
 *  while a pane shows it; undefined for a clean buffer and for a tab with none. */
export function takeCarry(activity: string, ref: CenterTabRef): TabCarry | undefined {
  const path = bufferPath(ref);
  if (path === undefined || !models.isDirty(activity, path)) return undefined;
  const text = models.textOf(activity, path, true);
  const base = models.baseOf(activity, path);
  if (text === undefined || base === undefined) return undefined; // a dirty buffer always has both: this only narrows the types
  const viewState = models.viewOf(activity, path);
  return viewState === undefined ? { text, base } : { text, base, viewState };
}

// An untitled number can repeat after the main window reloads (spec decision 13): one already open here would take the arriving text over
// another buffer's and share its tab key, so the arriving tab gets a fresh number instead
function arriving(activity: string, ref: CenterTabRef): CenterTabRef {
  if (ref.kind !== 'untitled' || models.baseOf(activity, models.untitledPath(ref.n)) === undefined) return ref;
  return { kind: 'untitled', n: models.nextUntitled() };
}

/** The arriving tab's buffer seeded dirty from its carry, its view state waiting for the pane (#551); answers the ref the window opens, an
 *  untitled one renumbered when its number is taken here. No carry seeds nothing: the tab reads its file as any tab opened does. */
export async function applyCarry(activity: string, ref: CenterTabRef, carry?: TabCarry): Promise<CenterTabRef> {
  const target = arriving(activity, ref);
  const path = bufferPath(target);
  if (carry === undefined || path === undefined) return target;
  await models.seed(activity, path, carry.text, carry.base);
  if (carry.viewState !== undefined) models.restoreView(activity, path, carry.viewState);
  return target;
}
