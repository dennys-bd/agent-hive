// The files sidebar's tree (redesign 07): the flat path list GET /activities/:id/tree answers, as folders and files, and the rows an expanded set
// shows. Pure, so node:test covers it.
import type { FolderEntries, GitMark, IgnoredEntries } from '../../types.js';

export interface TreeNode {
  name: string;
  path: string; // relative to the worktree
  mark?: GitMark; // a file's own; a folder has none
  children?: TreeNode[]; // present on a folder
  isIgnored?: true; // HIVE-22: git ignores it, or it lies in a nested repository; never marked
  isUnloaded?: true; // HIVE-22: an ignored folder whose children were not read yet (children: [])
}

export interface TreeRow { node: TreeNode; depth: number }

// A dotfile or anything under a dot folder: what mostrar arquivos ocultos brings back
const isHidden = (path: string): boolean => path.split('/').some((part) => part.startsWith('.'));

// Folders first, then by name, as Finder and every editor list them
const byKindThenName = (a: TreeNode, b: TreeNode): number =>
  Number(b.children !== undefined) - Number(a.children !== undefined) || a.name.localeCompare(b.name);

const IGNORED = { isIgnored: true } as const;
const NO_IGNORED: IgnoredEntries = { files: [], folders: [] };
const NOTHING_LOADED: ReadonlyMap<string, FolderEntries> = new Map();

interface Folder { files: TreeNode[]; folders: Map<string, Folder>; flags?: Pick<TreeNode, 'isIgnored' | 'isUnloaded'> }

function toNodes(folder: Folder, prefix: string): TreeNode[] {
  const folders = [...folder.folders].map(([name, child]): TreeNode => ({ name, path: `${prefix}${name}`, children: toNodes(child, `${prefix}${name}/`), ...child.flags }));
  return [...folders, ...folder.files].sort(byKindThenName);
}

// The folder at `parts` under `root`, every folder on the way added when missing. `root` is the calling buildTree's own tree
function descend(root: Folder, parts: readonly string[]): Folder {
  let folder = root;
  for (const part of parts) {
    const next = folder.folders.get(part) ?? { files: [], folders: new Map() };
    folder.folders.set(part, next);
    folder = next;
  }
  return folder;
}

// A file under `root` at `path`, its folders added on the way
function addFile(root: Folder, path: string, extra: Pick<TreeNode, 'mark' | 'isIgnored'>): void {
  const parts = path.split('/');
  const name = parts.pop() as string;
  descend(root, parts).files.push({ name, path, ...extra });
}

// An ignored folder (HIVE-22): its children as read from disk when the map has them, each loaded subfolder's own from the same map; else
// unloaded, so the panel shows it collapsed and empty
function addIgnoredFolder(root: Folder, path: string, loaded: ReadonlyMap<string, FolderEntries>, isShown: (path: string) => boolean): void {
  const entries = loaded.get(path);
  descend(root, path.split('/')).flags = entries ? IGNORED : { ...IGNORED, isUnloaded: true };
  if (!entries) return;
  for (const name of entries.folders) if (isShown(`${path}/${name}`)) addIgnoredFolder(root, `${path}/${name}`, loaded, isShown);
  for (const name of entries.files) if (isShown(`${path}/${name}`)) addFile(root, `${path}/${name}`, IGNORED);
}

/** The paths as a sorted tree, the hidden ones left out unless asked for; an empty folder (#818) is a folder with no children; what git
 *  ignores is marked ignored, an ignored folder's children coming from `loaded` (HIVE-22). */
export function buildTree(files: string[], marks: Record<string, GitMark>, showHidden: boolean, folders: readonly string[] = [], ignored: IgnoredEntries = NO_IGNORED, loaded: ReadonlyMap<string, FolderEntries> = NOTHING_LOADED): TreeNode[] {
  const root: Folder = { files: [], folders: new Map() };
  const isShown = (path: string): boolean => showHidden || !isHidden(path);
  for (const path of folders.filter(isShown)) descend(root, path.split('/'));
  for (const path of files.filter(isShown)) addFile(root, path, marks[path] ? { mark: marks[path] } : {});
  for (const path of ignored.folders.filter(isShown)) addIgnoredFolder(root, path, loaded, isShown);
  for (const path of ignored.files.filter(isShown)) addFile(root, path, IGNORED);
  return toNodes(root, '');
}

/** The rows shown: every node whose folders up to the root are all expanded, with its depth. */
export function visibleRows(nodes: TreeNode[], expanded: ReadonlySet<string>, depth = 0): TreeRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.children && expanded.has(node.path) ? visibleRows(node.children, expanded, depth + 1) : []),
  ]);
}

/** The folder a path sits in, '' at the top (#818). */
export const parentOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

/** Where `path` is after `from` became `to` (#818): `to` itself, or the same place under it for a path inside a renamed folder; undefined for
 *  a path the rename does not touch. */
export function renamedPath(path: string, from: string, to: string): string | undefined {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : undefined;
}

/** The folders above a path, outermost first: 'a/b/c' gives ['a', 'a/b'] (#818). */
export const ancestorsOf = (path: string): string[] => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

/** The expanded folders the tree reads from disk (HIVE-22): an ignored folder, or one under it whose folders from that ignored one down are
 *  all expanded, so a collapsed ignored folder is never read. Sorted. */
export function ignoredToRead(expanded: ReadonlySet<string>, ignoredFolders: readonly string[]): string[] {
  const ignoredRootOf = (path: string): string | undefined => ignoredFolders.find((folder) => path === folder || path.startsWith(`${folder}/`));
  return [...expanded].filter((path) => {
    const root = ignoredRootOf(path);
    return root !== undefined && ancestorsOf(path).every((above) => above.length < root.length || expanded.has(above));
  }).sort();
}
