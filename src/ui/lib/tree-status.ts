// The files tree's row statuses (#903): a checker's error or warning, or a git mark, worst first. A folder takes the worst of every file under
// it at any depth, so a collapsed one still shows that something inside needs a look. Pure, so node:test covers it.
import type { FolderEntries, GitMark } from '../../types.js';
import { ancestorsOf } from './file-tree.js';

/** What a tree row's name shows (#903). */
export type TreeStatus = 'error' | 'warning' | GitMark;

/** A file's checker counts as the tree reads them. problems.ts's Counts fits; it is not imported because the node build leaves it out. */
export type StatusCounts = Readonly<{ errors: number; warnings: number }>;

// Lower is worse. Checkers before git; a change to an existing file outweighs a deletion, and a deletion a new file (the user's order)
const RANK: Record<TreeStatus, number> = { error: 0, warning: 1, M: 2, D: 3, A: 4 };

/** A git mark's text token (#903): the marks have their own, so a modified file never reads as a warning. */
export const MARK_TEXT: Record<GitMark, string> = { M: 'text-git-modified', A: 'text-git-added', D: 'text-git-deleted' };

/** The worse of two statuses; `a` may be absent, as a folder's first one is. */
export const worse = (a: TreeStatus | undefined, b: TreeStatus): TreeStatus => (a !== undefined && RANK[a] <= RANK[b] ? a : b);

/** A file's own status (#780, #903): an error, then a warning, then its git mark; infos never show. */
export function fileStatus(counts: StatusCounts | undefined, mark: GitMark | undefined): TreeStatus | undefined {
  if (counts !== undefined && counts.errors > 0) return 'error';
  if (counts !== undefined && counts.warnings > 0) return 'warning';
  return mark;
}

/** The nested repositories' marks (#1) by full path, after a round of folder reads (#289): each folder read replaces its own children's marks
 *  and forgets what was under a child folder it no longer lists; a folder not read this round, collapsed since, keeps its last marks so
 *  they still raise the folders above it. A new object: neither input changes. */
export function rememberMarks(prev: Readonly<Record<string, GitMark>>, read: ReadonlyMap<string, FolderEntries>): Record<string, GitMark> {
  const isStale = (path: string): boolean => [...read].some(([folder, entries]) => {
    if (!path.startsWith(`${folder}/`)) return false;
    const rest = path.slice(folder.length + 1).split('/');
    return rest.length === 1 || !entries.folders.includes(rest[0]);
  });
  const kept = Object.entries(prev).filter(([path]) => !isStale(path));
  const fresh = [...read].flatMap(([folder, entries]) => Object.entries(entries.repo?.marks ?? {}).map(([name, mark]) => [`${folder}/${name}`, mark] as const));
  return Object.fromEntries([...kept, ...fresh]);
}

/** Every folder above a path with a status, with the worst status under it (#903). A deleted path (D) is in `marks` but not in the tree's
 *  files: it raises its folders only. */
export function folderStatuses(counts: ReadonlyMap<string, StatusCounts>, marks: Readonly<Record<string, GitMark>>): ReadonlyMap<string, TreeStatus> {
  const folders = new Map<string, TreeStatus>();
  for (const path of new Set([...counts.keys(), ...Object.keys(marks)])) {
    const status = fileStatus(counts.get(path), marks[path]);
    if (status === undefined) continue;
    for (const folder of ancestorsOf(path)) folders.set(folder, worse(folders.get(folder), status));
  }
  return folders;
}
