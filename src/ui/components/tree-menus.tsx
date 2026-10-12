import type { ReactNode } from 'react';
import { Confirm } from '@/components/Confirm';
import { FixedKeyHint, KeyHint } from '@/components/KeyHint';
import { focusName } from '@/components/tree-name-input';
import { isHiveDesign } from '@/components/terminal-tabs';
import type { TreeActions } from '@/components/tree-ops';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { t } from '@/i18n';
import { parentOf } from '@/lib/file-tree';

// The files tree's right-click menus (#818), apart from FilesPanel.tsx: a file's, a folder's and the empty area's (the root). An item that
// takes one path acts on the clicked row; cut, copy and delete on `selected`, the selection when the row is in it (actedOn). Each item shows
// its key.

interface MenuProps { actions: TreeActions; path: string; selected: string[]; children: ReactNode }

// A closing menu hands the focus back to its row after its exit animation; while an inline name input stands (#818: a new item, a rename),
// the input takes it instead (it could not while the menu held it), or its blur would cancel it
const keepInputFocus = (event: Event): void => {
  const input = document.querySelector<HTMLInputElement>('[data-tree-input] input');
  if (input === null) return;
  event.preventDefault();
  focusName(input);
};

function NewItems({ actions, folder }: { actions: TreeActions; folder: string }) {
  return (
    <>
      <ContextMenuItem onSelect={() => actions.newItem('file', folder)}>{t('files.newFile')}<KeyHint id="treeNewFile" /></ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.newItem('folder', folder)}>{t('files.newFolder')}<KeyHint id="treeNewFolder" /></ContextMenuItem>
    </>
  );
}

function RenameItem({ actions, path }: { actions: TreeActions; path: string }) {
  return <ContextMenuItem onSelect={() => actions.rename(path)}>{t('files.rename')}<KeyHint id="treeRename" /></ContextMenuItem>;
}

function PlaceItems({ actions, folder, path }: { actions: TreeActions; folder: string; path: string }) {
  return (
    <>
      <ContextMenuItem onSelect={() => actions.openTerminal(folder)}>{t('files.openTerminal')}<KeyHint id="treeOpenTerminal" /></ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.reveal(path)}>{t('files.reveal')}<KeyHint id="treeReveal" /></ContextMenuItem>
    </>
  );
}

function ClipboardItems({ actions, selected, into }: { actions: TreeActions; selected: string[]; into: string }) {
  return (
    <>
      <ContextMenuItem onSelect={() => actions.cut(selected)}>{t('files.cut')}<FixedKeyHint id="treeCut" /></ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.copy(selected)}>{t('files.copy')}<FixedKeyHint id="treeCopy" /></ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.paste(into)}>{t('files.paste')}<FixedKeyHint id="treePaste" /></ContextMenuItem>
    </>
  );
}

function PathItems({ actions, path }: { actions: TreeActions; path: string }) {
  return (
    <>
      <ContextMenuItem onSelect={() => actions.copyPath(path)}>{t('files.copyPath')}<KeyHint id="treeCopyPath" /></ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.copyRelativePath(path)}>{t('files.copyRelativePath')}<KeyHint id="treeCopyRelativePath" /></ContextMenuItem>
    </>
  );
}

function DeleteItem({ actions, selected }: { actions: TreeActions; selected: string[] }) {
  return <ContextMenuItem onSelect={() => actions.trash(selected)}>{t('files.delete')}<KeyHint id="treeDelete" /></ContextMenuItem>;
}

/** A file's menu: for a Hive design, open in the editor pane first (#109: a click opens its design pane); Open Changes (the changes pane of
 *  that file, #668), the terminal in its folder, reveal; cut, copy, paste into its folder; the copy paths; rename, delete. */
export function FileMenu({ actions, path, selected, children }: MenuProps) {
  const folder = parentOf(path);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64" onCloseAutoFocus={keepInputFocus}>
        {isHiveDesign(path) && <ContextMenuItem onSelect={() => actions.openInEditor(path)}>{t('files.openInEditor')}</ContextMenuItem>}
        <ContextMenuItem onSelect={() => actions.openChanges(path)}>{t('files.openChanges')}</ContextMenuItem>
        <PlaceItems actions={actions} folder={folder} path={path} />
        <ContextMenuSeparator />
        <ClipboardItems actions={actions} selected={selected} into={folder} />
        <ContextMenuSeparator />
        <PathItems actions={actions} path={path} />
        <ContextMenuSeparator />
        <RenameItem actions={actions} path={path} />
        <DeleteItem actions={actions} selected={selected} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A folder's menu: new file, new folder; the terminal in it, reveal; cut, copy, paste into it; the copy paths; rename, delete. */
export function FolderMenu({ actions, path, selected, children }: MenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64" onCloseAutoFocus={keepInputFocus}>
        <NewItems actions={actions} folder={path} />
        <PlaceItems actions={actions} folder={path} path={path} />
        <ContextMenuSeparator />
        <ClipboardItems actions={actions} selected={selected} into={path} />
        <ContextMenuSeparator />
        <PathItems actions={actions} path={path} />
        <ContextMenuSeparator />
        <RenameItem actions={actions} path={path} />
        <DeleteItem actions={actions} selected={selected} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The empty area's menu, the root's: new file, new folder, the terminal and reveal at the root, and paste into it. A row's own menu takes its right-click first. */
export function RootMenu({ actions, children }: { actions: TreeActions; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64" onCloseAutoFocus={keepInputFocus}>
        <NewItems actions={actions} folder="" />
        <PlaceItems actions={actions} folder="" path="" />
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.paste('')}>{t('files.paste')}<FixedKeyHint id="treePaste" /></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// The dialog's question: the item by its name, or the count
function trashMessage(paths: string[] | undefined): string {
  if (paths === undefined) return '';
  if (paths.length !== 1) return t('files.trashMany', { n: paths.length });
  return t('files.trashOne', { name: paths[0].split('/').at(-1) ?? paths[0] });
}

/** Delete's question (#818): always asked, Enter confirming it, its focus on the action. */
export function TrashConfirm({ paths, onConfirm, onCancel }: { paths?: string[]; onConfirm(): void; onCancel(): void }) {
  return (
    <Confirm
      open={paths !== undefined} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}
      message={trashMessage(paths)} confirmLabel={t('files.trash')} onConfirm={onConfirm} focusConfirm
    />
  );
}
