// An untitled file's ⌘S (#818): the OS's save dialog, from the tree's selected folder (else its root) with the tab's name, then tree/file,
// which refuses a path outside the activity's tree; the dialog's own Replace? already answered for an existing file. A plain browser has no
// dialog, and says why.
import { toast } from 'sonner';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import * as models from '@/lib/editor-models';
import { selectInTree, selectionFolderOf, treeChanged, treeRootOf } from '@/lib/tree-place';

const errorOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Saves untitled buffer `n` of the activity: the path it was written to, relative to the tree's root, or undefined while it stays untitled
 *  (cancelled, refused, no bridge), a refusal toasted. */
export async function saveUntitled(activityId: string, n: number): Promise<string | undefined> {
  const bridge = window.hive;
  if (bridge === undefined) {
    toast.error(t('editor.untitled.noBridge'));
    return undefined;
  }
  const root = await treeRootOf(activityId);
  const folder = selectionFolderOf(activityId);
  const start = root === undefined ? undefined : `${folder === '' ? root : `${root}/${folder}`}/${t('editor.untitled', { n })}`;
  const chosen = await bridge.saveDialog(start);
  if (chosen === undefined) return undefined;
  try {
    const text = models.textOf(activityId, models.untitledPath(n)) ?? '';
    const saved = await postJson<{ path: string; version: string }>(`/activities/${encodeURIComponent(activityId)}/tree/file`, { path: chosen, text, replace: true });
    models.adopt(activityId, n, saved.path, saved.version);
    treeChanged(activityId); // the new file shows now, not at the next poll
    selectInTree(activityId, saved.path);
    return saved.path;
  } catch (err) {
    toast.error(errorOf(err));
    return undefined;
  }
}
