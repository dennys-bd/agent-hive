import { type DragEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { act } from '@/components/actions';
import { followMoves, type MoveAnswer } from '@/components/tree-paste';
import { t } from '@/i18n';
import { parentOf, type TreeNode } from '@/lib/file-tree';

// The files sidebar's drag (#594), apart from FilesPanel.tsx as task-drag.ts is from Flow.tsx: a row dropped on a folder moves there;
// files from Finder are copied into the folder they are dropped on and the original stays. ⌥ changes nothing. A ref holds the dragged
// paths, since dataTransfer is unreadable until the drop.

/** How long a closed folder is hovered while dragging before it opens: Finder's spring-loaded folders. */
export const SPRING_OPEN_MS = 600;
const ROOT = '';

export interface RowDragHandlers { draggable: true; onDragStart(e: DragEvent): void; onDragEnd(): void; onDragOver(e: DragEvent): void; onDrop(e: DragEvent): void }
/** What the rows' scroll area spreads: its empty part is the root. */
export interface AreaDropHandlers { onDragEnter(e: DragEvent): void; onDragOver(e: DragEvent): void; onDragLeave(e: DragEvent): void; onDrop(e: DragEvent): void }

export interface TreeDrag {
  hovered: string | undefined; // the folder a drop would land in now; '' is the root
  rowProps(node: TreeNode, isOpen: boolean): RowDragHandlers;
  area: AreaDropHandlers;
}

// A folder row is its own drop folder; a file row's is the folder it sits in
export const folderOf = (node: TreeNode): string => (node.children === undefined ? parentOf(node.path) : node.path);
/** Whether `path` is in the block a drop on `folder` highlights: the folder's row and everything under it. The root highlights the whole tree, not rows. */
export const isInDropBlock = (path: string, folder: string | undefined): boolean =>
  folder !== undefined && folder !== ROOT && (path === folder || path.startsWith(`${folder}/`));
// Finder does nothing here either: an item onto its own folder, a folder into itself or below it
const isNoOpMove = (path: string, into: string): boolean => parentOf(path) === into || into === path || into.startsWith(`${path}/`);
const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files');
const moveUrl = (activityId: string): string => `/activities/${encodeURIComponent(activityId)}/tree/move`; // #629

// A Finder drop's absolute paths through the viewer's bridge (contextIsolation hides File.path); undefined in a plain browser, or when it gives none
function finderPaths(files: FileList): string[] | undefined {
  const bridge = window.hive;
  if (!bridge) return undefined;
  const paths = Array.from(files).map((file) => bridge.pathForFile(file)).filter((path) => path !== '');
  return paths.length > 0 ? paths : undefined;
}

// What a drop posts: the dragged rows minus the no-op ones, or Finder's files; undefined for a Finder drop outside the viewer
function dropSources(e: DragEvent, internal: string[] | undefined, into: string): string[] | undefined {
  if (internal) return internal.filter((path) => !isNoOpMove(path, into));
  return hasFiles(e) ? finderPaths(e.dataTransfer.files) : [];
}

// Finder's spring-loaded folders: only a closed folder springs, and the dragover that repeats while the pointer rests keeps its timer
function useSpringOpen(expand: (path: string) => void): { arm(node: TreeNode, isOpen: boolean): void; stop(): void } {
  const spring = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  useEffect(() => () => clearTimeout(spring.current?.timer), []);
  const stop = (): void => {
    clearTimeout(spring.current?.timer);
    spring.current = undefined;
  };
  const arm = (node: TreeNode, isOpen: boolean): void => {
    if (spring.current?.path === node.path) return;
    stop();
    if (node.children === undefined || isOpen) return;
    const timer = setTimeout(() => {
      spring.current = undefined;
      expand(node.path);
    }, SPRING_OPEN_MS);
    spring.current = { path: node.path, timer };
  };
  return { arm, stop };
}

/** The tree's drag state and the handlers its rows and scroll area spread. A drop posts through act, which toasts a refusal. `dragSet`: what a
 *  drag of a row carries, the selection when the row is in it (#818). */
export function useTreeDrag(activityId: string, expand: (path: string) => void, dragSet: (path: string) => string[] = (path) => [path]): TreeDrag {
  const dragged = useRef<string[] | undefined>(undefined);
  const [hovered, setHovered] = useState<string>();
  const spring = useSpringOpen(expand);
  const clear = (): void => {
    spring.stop();
    setHovered(undefined);
  };
  const over = (e: DragEvent, folder: string): boolean => {
    if (dragged.current === undefined && !hasFiles(e)) return false; // an activity task or text: no drop here
    e.preventDefault();
    e.stopPropagation(); // the area behind would otherwise show the root
    e.dataTransfer.dropEffect = dragged.current === undefined ? 'copy' : 'move'; // no dragged rows means Finder's files
    if (folder !== hovered) setHovered(folder);
    return true;
  };
  const drop = (e: DragEvent, into: string): void => {
    e.preventDefault();
    e.stopPropagation(); // the area behind would post the same drop into the root
    const sources = dropSources(e, dragged.current, into);
    const isFromFinder = dragged.current === undefined;
    dragged.current = undefined;
    clear();
    if (sources === undefined) toast.error(t('files.drop.noBridge'));
    else if (sources.length > 0) void act<MoveAnswer>(moveUrl(activityId), { sources, into, copy: isFromFinder }).then((answer) => { if (!isFromFinder) followMoves(activityId, answer); });
  };
  const rowProps = (node: TreeNode, isOpen: boolean): RowDragHandlers => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData('text/plain', node.path); // Firefox starts no drag without data
      e.dataTransfer.effectAllowed = 'move';
      dragged.current = dragSet(node.path);
    },
    onDragEnd: () => {
      dragged.current = undefined;
      clear();
    },
    onDragOver: (e) => { if (over(e, folderOf(node))) spring.arm(node, isOpen); },
    onDrop: (e) => drop(e, folderOf(node)),
  });
  const area: AreaDropHandlers = {
    // A Finder drag while the ref still holds rows means the internal drag's dragend never fired (its row unmounted): drop the stale ref
    onDragEnter: (e) => { if (hasFiles(e)) dragged.current = undefined; },
    onDragOver: (e) => { if (over(e, ROOT)) spring.stop(); },
    onDragLeave: (e) => {
      // Chromium (Electron) reports the row entered as relatedTarget, so moving between rows does not count as leaving; Safari/Firefox may not
      const related = e.relatedTarget as Node | null;
      if (!related || !e.currentTarget.contains(related)) clear(); // the pointer left the tree, not just a row
    },
    onDrop: (e) => drop(e, ROOT),
  };
  return { hovered, rowProps, area };
}
