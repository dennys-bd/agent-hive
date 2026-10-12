import { useState } from 'react';
import { toast } from 'sonner';
import type { OpenResult } from '../../types';
import { act, attachRun } from '@/components/actions';
import { copyFiles, cutFiles, pasteInto } from '@/components/tree-paste';
import { localRunTab, type OpenFileHow, type OpenRun, useOpenChanges, useOpenFile, useOpenRun } from '@/components/terminal-tabs';
import { t } from '@/i18n';
import { activityKey, type RunTarget } from '@/lib/activities';
import { treeChanged } from '@/lib/tree-place';
import { shownSize } from '@/lib/xterm-setup';

// The files tree's operations (#818), apart from FilesPanel.tsx as tree-drag.ts and tree-paste.ts are: what a menu item or a key does. A
// refusal is act's toast.

/** What the menus and the keys act with (#818): an item taking one path acts on the clicked or focused row, the others on actedOn. */
export interface TreeActions {
  newItem(type: 'file' | 'folder', folder: string): void; // the inline input at the top of `folder` ('' = the root)
  rename(path: string): void; // the inline input in the row
  trash(paths: string[]): void; // asks first
  cut(paths: string[]): void;
  copy(paths: string[]): void;
  paste(into: string): void;
  copyPath(path: string): void;
  copyRelativePath(path: string): void;
  reveal(path: string): void; // '' = the root
  openTerminal(folder: string): void; // '' = the root
  openChanges(path: string): void;
  openInEditor(path: string): void; // #109: a Hive design's text, in the editor pane
}

const route = (activityId: string, name: string): string => `/activities/${encodeURIComponent(activityId)}/${name}`; // #629
const EDITOR: OpenFileHow = { editor: true }; // #109: past the design pane a click opens

// Copy path and copy relative path: text on the clipboard
function copyText(text: string): void {
  navigator.clipboard.writeText(text).then(() => toast.success(t('detail.copied')), (err: Error) => toast.error(err.message));
}

/** Open in the integrated terminal (#818): a terminal tab of the activity in `folder` ('' = where the + opens one), through the shell route
 *  the terminal panel's + posts; the run it answered lands as the +'s does. */
export function openTerminalIn(target: RunTarget, folder: string, openRun?: OpenRun): void {
  const body = folder === '' ? { size: shownSize() } : { folder, size: shownSize() };
  void act<OpenResult>(route(target.activity.id, 'shell'), body).then((result) => {
    if (result?.ptyId === undefined) return;
    if (target.kind === 'local') openRun?.(localRunTab(result.ptyId, target.workspace, 'terminal'));
    else attachRun(result, target.task, 'terminal', openRun);
  });
}

export interface TreeOps { actions: TreeActions; trashing?: string[]; confirmTrash(): void; cancelTrash(): void }

/** The tree's actions over the activity and its root (undefined until the tree answers: what needs it does nothing), the inline input's two
 *  from `edits`. Delete waits for its dialog: `trashing` holds what it asks about. */
export function useTreeActions(target: RunTarget, root: string | undefined, edits: Pick<TreeActions, 'newItem' | 'rename'>): TreeOps {
  const openRun = useOpenRun();
  const openChanges = useOpenChanges(activityKey(target));
  const openFile = useOpenFile();
  const [trashing, setTrashing] = useState<string[]>();
  const id = target.activity.id;
  const withRoot = (run: (known: string) => void): void => {
    if (root !== undefined) run(root);
  };
  const actions: TreeActions = {
    ...edits,
    trash: setTrashing,
    cut: (paths) => withRoot((known) => cutFiles(id, known, paths)),
    copy: (paths) => withRoot((known) => copyFiles(known, paths)),
    paste: (into) => pasteInto(id, into),
    copyPath: (path) => withRoot((known) => copyText(`${known}/${path}`)),
    copyRelativePath: copyText,
    reveal: (path) => void act(route(id, 'reveal'), path === '' ? undefined : { path }),
    openTerminal: (folder) => openTerminalIn(target, folder, openRun),
    openChanges: (path) => openChanges?.(path),
    openInEditor: (path) => { openFile?.(activityKey(target), path, undefined, EDITOR); },
  };
  const confirmTrash = (): void => {
    if (trashing !== undefined) void act(route(id, 'tree/trash'), { paths: trashing }).then(() => treeChanged(id));
    setTrashing(undefined);
  };
  return { actions, trashing, confirmTrash, cancelTrash: () => setTrashing(undefined) };
}
