// The dock's file opener (#717): a click on one of an activity's files opens it as an editor pane tab of that activity, at the click's line when
// it carries one. Also what the open files need of the page: a gone activity's models closed, and an
// unload over unsaved edits asked about.
import { useEffect } from 'react';
import { focusOrOpen } from '@/components/actions';
import { isHiveDesign, type OpenFile, type OpenFileHow } from '@/components/terminal-tabs';
import type { FileTabKind } from '@/hooks/use-activity';
import { type Activity, activityKey } from '@/lib/activities';
import { fileRefPath, refKey } from '@/lib/center-layout';
import * as models from '@/lib/editor-models';
import { treeRootOf } from '@/lib/tree-place';
import type { FileAt } from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';

// The browser asks before the page goes while a buffer holds unsaved edits; inside the viewer, main answers with its own dialog (main.ts)
function askBeforeUnload(event: BeforeUnloadEvent): void {
  if (models.anyDirty()) event.preventDefault();
}

// The tab a click asks for (#697, #668, #109): a preview, the changes or the editor when asked; else a Hive design's pane for a .hv.html, the
// editor for any other file. Every file click comes through here, so a design opens as one from the tree, a result file or a terminal link
function tabKindOf(path: string, how?: OpenFileHow): FileTabKind {
  if (how?.preview === true) return 'preview';
  if (how?.changes === true) return 'changes';
  return how?.editor !== true && isHiveDesign(path) ? 'design' : 'file';
}

/** focusOut (#554): a file whose tab is out in a detached window raises that window. Only the main window asks: main answers focusTab to it alone. */
export interface FileOpenerOptions { focusOut?: boolean }

/** The opener FileOpenerContext hands down (#717), over the listed activities. `open` is useActivity's openFile: the activity picked and the
 * file's editor tab requested, its preview's (#697), its changes' (#668) or its design's (#109). With `focusOut` the main window's click
 * raises the window that holds the tab instead of opening a second copy (#554). */
export function useFileOpener(activities: Activity[], open: (key: string, path: string, kind: FileTabKind) => void, { focusOut = false }: FileOpenerOptions = {}): OpenFile {
  const ids = activities.map((activity) => activity.activity.id).join('\n'); // one string: the effect runs only when the list changes
  useEffect(() => {
    models.closeExcept(new Set(ids.split('\n'))); // a deleted activity has no tab left to close its models, and a dirty one would hold the unload
    fileBase.closeExcept(new Set(ids.split('\n'))); // nor its files' bases (#668)
  }, [ids]);
  useEffect(() => {
    window.addEventListener('beforeunload', askBeforeUnload);
    return () => window.removeEventListener('beforeunload', askBeforeUnload);
  }, []);
  // The tab a resolved path opens in, the cursor at `at` for an editor's
  const show = (activityId: string, key: string, ref: string, at?: FileAt, how?: OpenFileHow): void => {
    const kind = tabKindOf(ref, how);
    // The cursor only for a tab that opens here: a tab out in a window keeps its own (#554)
    const here = (): void => {
      if (kind === 'file' && at !== undefined) models.revealAt(activityId, ref, at);
      open(key, ref, kind); // a preview or a changes tab has no cursor: `at` is the editor's
    };
    if (focusOut) focusOrOpen(key, refKey({ kind, path: ref }), here);
    else here();
  };
  const opener: OpenFile = (key, path, at, how) => {
    const target = activities.find((activity) => activityKey(activity) === key);
    if (target === undefined) return false;
    const ref = fileRefPath(path, target.activity.worktree); // inside the worktree: relative; anywhere else: absolute (#697)
    if (ref !== undefined) {
      show(target.activity.id, key, ref, at, how);
      return true;
    }
    // A relative path that climbs out of a folder the page does not know (a local activity's checkout): against the tree's root, an
    // absolute path the editor opens (#818). The IDE that took it before is gone
    void treeRootOf(target.activity.id).then((root) => {
      const resolved = root === undefined ? undefined : fileRefPath(path, root);
      if (resolved !== undefined) show(target.activity.id, key, resolved, at, how);
    });
    return true;
  };
  return opener;
}
