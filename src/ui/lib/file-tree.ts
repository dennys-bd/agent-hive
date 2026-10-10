// The files sidebar's tree (redesign 07): the flat path list GET /activities/:id/tree answers, as folders and files, and the rows an expanded set
// shows. Pure, so node:test covers it.
import type { GitMark } from '../../types.js';

export interface TreeNode {
  name: string;
  path: string; // relative to the worktree
  mark?: GitMark; // a file's own; a folder has none
  children?: TreeNode[]; // present on a folder
}

export interface TreeRow { node: TreeNode; depth: number }

// A dotfile or anything under a dot folder: what mostrar arquivos ocultos brings back
const isHidden = (path: string): boolean => path.split('/').some((part) => part.startsWith('.'));

// Folders first, then by name, as Finder and every editor list them
const byKindThenName = (a: TreeNode, b: TreeNode): number =>
  Number(b.children !== undefined) - Number(a.children !== undefined) || a.name.localeCompare(b.name);

interface Folder { files: TreeNode[]; folders: Map<string, Folder> }

function toNodes(folder: Folder, prefix: string): TreeNode[] {
  const folders = [...folder.folders].map(([name, child]): TreeNode => ({ name, path: `${prefix}${name}`, children: toNodes(child, `${prefix}${name}/`) }));
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

/** The paths as a sorted tree, the hidden ones left out unless asked for; an empty folder (#818) is a folder with no children. */
export function buildTree(files: string[], marks: Record<string, GitMark>, showHidden: boolean, folders: readonly string[] = []): TreeNode[] {
  const root: Folder = { files: [], folders: new Map() };
  const isShown = (path: string): boolean => showHidden || !isHidden(path);
  for (const path of folders.filter(isShown)) descend(root, path.split('/'));
  for (const path of files.filter(isShown)) {
    const parts = path.split('/');
    const name = parts.pop() as string;
    descend(root, parts).files.push({ name, path, ...(marks[path] ? { mark: marks[path] } : {}) });
  }
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
