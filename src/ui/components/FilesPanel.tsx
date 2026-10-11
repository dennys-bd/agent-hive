import { type CSSProperties, type Dispatch, Fragment, type MouseEvent, type ReactNode, type SetStateAction, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import type { GitMark } from '../../types';
import { act } from '@/components/actions';
import { FileMenu, FolderMenu, RootMenu, TrashConfirm } from '@/components/tree-menus';
import { folderOf, isInDropBlock, type RowDragHandlers, type TreeDrag, useTreeDrag } from '@/components/tree-drag';
import { runTreeKey, useTreeKeys } from '@/components/tree-keys';
import { type TreeEditing, TreeNameInput, useTreeEditing } from '@/components/tree-name-input';
import { type TreeActions, useTreeActions } from '@/components/tree-ops';
import { treeClipboard } from '@/components/tree-paste';
import { actedOn, clicked, modeOf, NO_SELECTION, single, type TreeSelection } from '@/components/tree-selection';
import { useOpenFile } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type FileIconsView, useFileIcons } from '@/hooks/use-file-icons';
import { useDiagnostics } from '@/hooks/use-diagnostics';
import { useIgnoredFolders } from '@/hooks/use-ignored-folders';
import { type TreeState, useTaskTree } from '@/hooks/use-task-tree';
import { t, tPlural } from '@/i18n';
import { activityCounts, type Counts, foldersWithErrors } from '@/lib/diagnostics-store';
import { type Activity, activityKey, isTask } from '@/lib/activities';
import { ancestorsOf, buildTree, type TreeNode, type TreeRow, visibleRows } from '@/lib/file-tree';
import { isMac } from '@/lib/shortcut-bindings';
import { expandedOf, onTreeSelect, rememberExpanded, rememberFolder } from '@/lib/tree-place';
import { readView, writeView } from '@/lib/view-state';

/** Which of the activity sidebar's two views shows (redesign 07). */
export type SideTab = 'files' | 'details';

const MARK_TEXT: Record<GitMark, string> = { M: 'text-waiting', A: 'text-working' };

// A file's diagnostic as the tree shows it (#780): the most severe count, errors before warnings; infos never show
interface Worst { n: number; tone: string; family: 'editor.diag.errors' | 'editor.diag.warnings' }
function worstOf(counts: Counts | undefined): Worst | undefined {
  if (counts === undefined) return undefined;
  if (counts.errors > 0) return { n: counts.errors, tone: 'text-destructive', family: 'editor.diag.errors' };
  return counts.warnings > 0 ? { n: counts.warnings, tone: 'text-waiting', family: 'editor.diag.warnings' } : undefined;
}

// The name's colour by priority (#780): an error, a warning, then the git mark; what git ignores is dimmed (HIVE-22), never coloured. A
// folder only reds for an error under it
function nameTone(node: TreeNode, worst: Worst | undefined, hasError: boolean): string {
  if (node.children !== undefined && hasError) return 'text-destructive';
  if (worst !== undefined) return worst.tone;
  if (node.mark) return MARK_TEXT[node.mark];
  return node.isIgnored ? 'text-muted-foreground' : 'text-foreground';
}

const INDENT_PX = 12;
const FIRST_INDENT_PX = 6;
const MUTED = 'px-3 text-muted-foreground text-xs';
// The detail stays mounted behind arquivos, as a dock tab's body does (#452), so a feedback being written survives the switch; collapsed
// inline for the reason DockGroup gives
const SHOWN: CSSProperties = { flex: '1 1 0%', opacity: 1, pointerEvents: 'auto' };
const COLLAPSED: CSSProperties = { flex: '0 0 0%', opacity: 0, pointerEvents: 'none' };

const activityUrl = (activityId: string, route: string): string => `/activities/${encodeURIComponent(activityId)}/${route}`; // #629

interface FilesView { expanded: ReadonlySet<string>; showHidden: boolean }

// What the tree remembers (#947): show hidden files is the user's, in the view state across activities and restarts; the open folders are the
// activity's, for the page only. Anything stored but true reads as off.
function useFilesView(activityId: string): [FilesView, Dispatch<SetStateAction<FilesView>>] {
  const [view, setView] = useState<FilesView>(() => ({ expanded: expandedOf(activityId), showHidden: readView('filesShowHidden') === true }));
  useEffect(() => { // only a change posts: the sidebar remounts on every switch of activity
    if ((readView('filesShowHidden') === true) !== view.showHidden) writeView('filesShowHidden', view.showHidden);
  }, [view.showHidden]);
  useEffect(() => rememberExpanded(activityId, view.expanded), [activityId, view.expanded]);
  return [view, setView];
}

interface HeaderProps { tab: SideTab; hasDetails: boolean; activityId: string; view: FilesView; onTab(tab: SideTab): void; onView(view: FilesView): void }

// The 36px header: arquivos | detalhes on a task's activity (a local one has arquivos alone, #633), then the files' ⋯ (recolher tudo,
// mostrar arquivos ocultos, mostrar na pasta) while they show.
function SideHeader({ tab, hasDetails, activityId, view, onTab, onView }: HeaderProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 px-2">
      {hasDetails && (
        <ToggleGroup type="single" value={tab} onValueChange={(value) => value && onTab(value as SideTab)} spacing={0.5} aria-label={t('files.tab.label')} className="rounded-md bg-muted p-0.5">
          {(['files', 'details'] as const).map((value) => (
            <ToggleGroupItem key={value} value={value} className="h-6 rounded-sm px-2 font-medium text-foreground text-xs data-[state=on]:bg-background data-[state=on]:text-foreground">
              {t(`files.tab.${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {tab === 'files' && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon-xs" variant="ghost" className="ml-auto text-muted-foreground" aria-label={t('detail.more')}><MoreHorizontalIcon /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => onView({ ...view, expanded: new Set() })}>{t('files.menu.collapseAll')}</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={view.showHidden} onCheckedChange={(checked) => onView({ ...view, showHidden: checked === true })}>
              {t('files.menu.showHidden')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void act(activityUrl(activityId, 'reveal'))}>{t('files.menu.reveal')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

interface RowIconProps { icons: FileIconsView; node: TreeNode; isOpen: boolean }

// The icon slot between the caret and the name (#754): drawn whenever a set is on, and left empty while it loads or for a file under folders
// only, so the names never shift. Decorative: the name already says what the row is. Its colours are the icon theme's own, the design
// system's third exception; the git mark keeps painting the name and the letter.
function RowIcon({ icons, node, isOpen }: RowIconProps) {
  if (!icons.isOn) return null;
  const isFolder = node.children !== undefined;
  const isShown = icons.resolve !== undefined && (isFolder || icons.scope === 'all');
  const src = isShown ? icons.resolve?.({ name: node.name, isFolder, isOpen, theme: icons.theme }) ?? '' : '';
  const isMuted = icons.muted || node.isIgnored === true; // HIVE-22: an ignored row's icon dims with its name
  return (
    <span data-file-icon className="flex size-4 shrink-0">
      {src !== '' && <img src={src} alt="" draggable={false} className={isMuted ? 'size-4 file-icon-muted' : 'size-4'} />}
    </span>
  );
}

interface RowProps {
  node: TreeNode; depth: number; isOpen: boolean; isDropTarget: boolean; isSelected: boolean; worst?: Worst; hasError: boolean; icons: FileIconsView;
  drag: RowDragHandlers; actions: TreeActions; selected: string[]; onToggle(path: string): void; onSelect(node: TreeNode, event: MouseEvent): void; onMenu(path: string): void;
}

// A 24px row: the caret column, the file-type icon (#754), the name in its colour by priority (#780), the diagnostic count, the git mark. A
// click selects it (#818: ⌘ toggles, ⇧ ranges) and a plain click on a file opens it; a folder opens on a double click, on its caret, or on
// Enter (a keyboard click, detail 0). The selected rows take bg-accent; a right-click on a row out of the selection selects it alone. Every
// row drags, and the rows of the folder a drag would land in take bg-muted as one block (#594). Each has its menu (#818).
function TreeRowView({ node, depth, isOpen, isDropTarget, isSelected, worst, hasError, icons, drag, actions, selected, onToggle, onSelect, onMenu }: RowProps) {
  const isFolder = node.children !== undefined;
  const tone = nameTone(node, worst, hasError);
  const Caret = isOpen ? ChevronDownIcon : ChevronRightIcon;
  const onClick = (event: MouseEvent): void => {
    onSelect(node, event);
    if (isFolder && event.detail === 0) onToggle(node.path);
  };
  const row = (
    <button
      type="button" title={node.path} aria-expanded={isFolder ? isOpen : undefined} onClick={onClick} onDoubleClick={isFolder ? () => onToggle(node.path) : undefined}
      onContextMenu={() => onMenu(node.path)} {...drag}
      style={{ paddingLeft: FIRST_INDENT_PX + depth * INDENT_PX }}
      className={`flex h-6 w-full shrink-0 items-center gap-1.5 rounded-sm pr-1.5 text-left hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none${isDropTarget ? ' bg-muted' : ''}${isSelected ? ' bg-accent' : ''}`}
      data-drop-target={isDropTarget || undefined} data-tree-folder={folderOf(node)} data-tree-path={node.path} data-selected={isSelected || undefined}
    >
      <span className="flex w-2.5 shrink-0 text-[11px] text-muted-foreground">
        {isFolder && <Caret className="size-2.5" onClick={(event) => { event.stopPropagation(); if (event.detail < 2) onToggle(node.path); }} onDoubleClick={(event) => event.stopPropagation()} />}
      </span>
      <RowIcon icons={icons} node={node} isOpen={isOpen} />
      <span className={`min-w-0 flex-1 truncate ${tone}`}>{node.name}</span>
      {worst && (
        <>
          <span aria-hidden data-diag-count className={`${worst.tone} text-xs`}>{worst.n}</span>
          <span className="sr-only">{`, ${tPlural(worst.family, worst.n, { n: worst.n })}`}</span>
        </>
      )}
      {node.mark && (
        <>
          <span aria-hidden data-git-mark title={t(`files.mark.${node.mark}`)} className={`${MARK_TEXT[node.mark]} text-xs`}>{node.mark}</span>
          <span className="sr-only">{`, ${t(`files.mark.${node.mark}`)}`}</span>
        </>
      )}
    </button>
  );
  const Menu = isFolder ? FolderMenu : FileMenu;
  return <Menu actions={actions} path={node.path} selected={selected}>{row}</Menu>;
}

interface BodyProps {
  tree: TreeState; rows: TreeRow[]; activityId: string; expanded: ReadonlySet<string>; drag: TreeDrag; selection: TreeSelection; actions: TreeActions; edit: TreeEditing;
  onToggle(path: string): void; onSelect(node: TreeNode, event: MouseEvent): void; onMenu(path: string): void;
}

// The tree as the latest poll has it, or why there is none
function TreeBody({ tree, rows, activityId, expanded, drag, selection, actions, edit, onToggle, onSelect, onMenu }: BodyProps) {
  const icons = useFileIcons(); // once per tree: every row shares the loaded set
  useDiagnostics(); // #780: the counts follow the language servers
  const counts = activityCounts(activityId);
  const errorFolders = foldersWithErrors(counts);
  if (tree.status === 'loading') return <p className={MUTED}>{t('files.loading')}</p>;
  if (tree.status === 'error') return <p role="alert" className="px-3 text-destructive text-xs">{tree.message}</p>;
  if (rows.length === 0 && edit.editing === undefined) return <p className={MUTED}>{t('files.empty')}</p>;
  return <RowList rows={rows} expanded={expanded} drag={drag} selection={selection} actions={actions} edit={edit} counts={counts} errorFolders={errorFolders} icons={icons} onToggle={onToggle} onSelect={onSelect} onMenu={onMenu} />;
}

interface RowListProps extends Omit<BodyProps, 'tree' | 'activityId'> {
  counts: ReturnType<typeof activityCounts>; errorFolders: ReturnType<typeof foldersWithErrors>; icons: FileIconsView;
}

// The rows, with the inline input where an edit stands (#818): a rename in its row's place, a new item at the top of its folder (the root's
// above every row)
function RowList({ rows, expanded, drag, selection, actions, edit, counts, errorFolders, icons, onToggle, onSelect, onMenu }: RowListProps) {
  const { editing } = edit;
  const input = (key: string, depth: number, initial: string) => (
    <TreeNameInput key={key} indent={FIRST_INDENT_PX + depth * INDENT_PX} initial={initial} error={editing?.error} onSubmit={edit.submit} onCancel={edit.cancel} />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-1.5 text-[13px]">
      {editing?.kind === 'new' && editing.folder === '' && input('new:', 0, '')}
      {rows.map(({ node, depth }) => {
        if (editing?.kind === 'rename' && editing.path === node.path) return input(`rename:${node.path}`, depth, node.name);
        const isOpen = expanded.has(node.path);
        const row = (
          <TreeRowView
            key={node.path} node={node} depth={depth} isOpen={isOpen} isDropTarget={isInDropBlock(node.path, drag.hovered)} isSelected={selection.paths.has(node.path)}
            worst={node.children === undefined ? worstOf(counts.get(node.path)) : undefined} hasError={errorFolders.has(node.path)} icons={icons}
            drag={drag.rowProps(node, isOpen)} actions={actions} selected={actedOn(selection, node.path)} onToggle={onToggle} onSelect={onSelect} onMenu={onMenu}
          />
        );
        return editing?.kind === 'new' && editing.folder === node.path ? <Fragment key={node.path}>{row}{input(`new:${node.path}`, depth + 1, '')}</Fragment> : row;
      })}
    </div>
  );
}

// The view's folders: a caret's toggle, and the folders a spring-loaded drag (#594) or an edit (#818) opens. The updater reads the view as it
// is then: a spring opens from a timer
function folderOps(onView: Dispatch<SetStateAction<FilesView>>): { toggle(path: string): void; expand(paths: readonly string[]): void } {
  return {
    toggle: (path) => onView((current) => {
      const expanded = new Set(current.expanded);
      if (!expanded.delete(path)) expanded.add(path);
      return { ...current, expanded };
    }),
    expand: (paths) => onView((current) => ({ ...current, expanded: new Set([...current.expanded, ...paths]) })),
  };
}

// The folder the selection's anchor stands for (#818): a folder row's own path, a file row's folder; the root with no anchor shown
function anchorFolder(rows: TreeRow[], selection: TreeSelection): string {
  const node = rows.find((row) => row.node.path === selection.anchor)?.node;
  return node === undefined ? '' : folderOf(node);
}

// What the rest of the page reads of the selection (#818): the untitled save's dialog starts in its folder, and selects the file it saved
function useSelectionPlace(activityId: string, rows: TreeRow[], selection: TreeSelection, setSelection: Dispatch<SetStateAction<TreeSelection>>, onView: Dispatch<SetStateAction<FilesView>>): void {
  useEffect(() => rememberFolder(activityId, anchorFolder(rows, selection)));
  useEffect(() => onTreeSelect(activityId, (path) => {
    setSelection(single(path));
    onView((current) => ({ ...current, expanded: new Set([...current.expanded, ...ancestorsOf(path)]) }));
  }), [activityId, setSelection, onView]);
}

interface FilesBodyProps { target: Activity; view: FilesView; isShown: boolean; onView: Dispatch<SetStateAction<FilesView>>; onOpen(path: string): void }

// The branch, then the tree. The wrapper of every body state (loading, error, empty, rows) is the root's drop target (#594), the empty area's
// menu and the clipboard's events' target (#818).
function FilesBody({ target, view, isShown, onView, onOpen }: FilesBodyProps) {
  const { activity } = target;
  const tree = useTaskTree(activity.id, isShown);
  const ready = tree.status === 'ready' ? tree.tree : undefined;
  const loaded = useIgnoredFolders(activity.id, isShown, view.expanded, ready?.ignored.folders);
  const root = ready?.root;
  const rows = ready ? visibleRows(buildTree(ready.files, ready.marks, view.showHidden, ready.folders, ready.ignored, loaded), view.expanded) : [];
  const [selection, setSelection] = useState<TreeSelection>(NO_SELECTION);
  useSelectionPlace(activity.id, rows, selection, setSelection, onView);
  const selectedOf = (path: string): string[] => actedOn(selection, path);
  const folders = folderOps(onView);
  const edit = useTreeEditing({ activityId: activity.id, expand: folders.expand, select: (path) => setSelection(single(path)), onOpen });
  const ops = useTreeActions(target, root, {
    newItem: (type, folder) => edit.start({ kind: 'new', type, folder }),
    rename: (path) => edit.start({ kind: 'rename', path }),
  });
  const container = useRef<HTMLDivElement>(null);
  useTreeKeys(container, (key) => runTreeKey(key, ops.actions, selectedOf));
  const drag = useTreeDrag(activity.id, (path) => folders.expand([path]), selectedOf);
  const select = (node: TreeNode, event: MouseEvent): void => {
    const mode = modeOf(event, isMac());
    setSelection((current) => clicked(current, node.path, mode, rows.map((row) => row.node.path)));
    if (mode === 'single' && node.children === undefined) onOpen(node.path);
  };
  const onMenu = (path: string): void => setSelection((current) => (current.paths.has(path) ? current : single(path)));
  const isRootTarget = drag.hovered === '';
  return (
    <>
      {activity.branch !== undefined && <p className="truncate px-3 pb-2 font-mono text-muted-foreground text-xs">{activity.branch}</p>}
      <RootMenu actions={ops.actions}>
        <div ref={container} data-testid="files-tree" data-drop-target={isRootTarget || undefined} tabIndex={-1} {...treeClipboard(activity.id, root, selectedOf)} className={`flex min-h-0 flex-1 flex-col focus:outline-none${isRootTarget ? ' bg-muted' : ''}`} {...drag.area}>
          <TreeBody tree={tree} rows={rows} activityId={activity.id} expanded={view.expanded} drag={drag} selection={selection} actions={ops.actions} edit={edit} onToggle={folders.toggle} onSelect={select} onMenu={onMenu} />
        </div>
      </RootMenu>
      <TrashConfirm paths={ops.trashing} onConfirm={ops.confirmTrash} onCancel={ops.cancelTrash} />
    </>
  );
}

export interface ActivitySideProps { target: Activity; tab: SideTab; isShown: boolean; details?: ReactNode; onTab(tab: SideTab): void }

/** The right sidebar under Atividades with an activity open (redesign 07): arquivos, the activity's worktree (the workspace checkout for a
 *  local run, or for a workspace's local activity, #633) as a tree that follows git status, or detalhes, the task's detail. A local activity
 *  has no task to detail, so it shows arquivos alone, whatever tab a task left. MainDock keys it by activity, so another activity starts
 *  collapsed. */
export function ActivitySide({ target, tab, isShown, details, onTab }: ActivitySideProps) {
  const [view, setView] = useFilesView(target.activity.id);
  const task = isTask(target) ? target.task : undefined;
  const openFile = useOpenFile();
  const onOpen = (path: string): void => { openFile?.(activityKey(target), path); }; // a click or abrir: the editor pane (#717)
  const shown: SideTab = task ? tab : 'files'; // the stored tab may be a task's detalhes; read shown, never tab, below
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <SideHeader tab={shown} hasDetails={task !== undefined} activityId={target.activity.id} view={view} onTab={onTab} onView={setView} />
      {shown === 'files' && <FilesBody target={target} view={view} isShown={isShown} onView={setView} onOpen={onOpen} />}
      {task && <div style={shown === 'details' ? SHOWN : COLLAPSED} inert={shown !== 'details'} className="flex min-h-0 min-w-0 flex-col overflow-hidden">{details}</div>}
    </div>
  );
}
