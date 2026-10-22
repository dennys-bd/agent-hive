import type { Exec, GitMark } from './types.js';
import { wordsOf } from './worktree.js';

// The tree's git runs (redesign 07, #1, #502): their parser, and the helper every one of them goes through.

export const TREE_MAX_BYTES = 16 * 1024 * 1024; // a monorepo's path list passes execFile's 1 MB default long before it bothers the page
// #502: the marks, the deleted paths, what git ignores (outermost: `normal` with `traditional` names a folder of only ignored files `dir/`,
// as the tree draws it) and the branch, in one run
export const TREE_STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=traditional'];

// --no-optional-locks: a status refreshes the index, and its lock would race the worker's own git; core.fsmonitor=false as in diff.ts.
export const gitIn = (worktree: string, args: string[], exec: Exec): Promise<string> =>
  exec('git', ['--no-optional-locks', '-C', worktree, '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args], { maxBuffer: TREE_MAX_BYTES })
    .then(({ stdout }) => stdout, (err: unknown) => { throw new Error(wordsOf(err)); });

/** One status run, read (#502): the marks, the deleted paths, the ignored entries as git wrote them (`dir/` for a folder), the untracked
 *  folders (`dir/`, which `normal` names once instead of every file) and the branch. */
export interface GitStatus { marks: Record<string, GitMark>; deleted: ReadonlySet<string>; ignored: string[]; untracked: string[]; branch?: string }

const RENAME_OR_COPY = /^[RC]/;
const BRANCH_HEAD = '# branch.head ';
const DETACHED = '(detached)';
// The fields before the path: `1 XY sub mH mI mW hH hI`, `2 … Xscore` (its old path is the next entry), `u XY sub m1 m2 m3 mW h1 h2 h3`
const FIELDS_BEFORE_PATH: Readonly<Record<string, number>> = { 1: 8, 2: 9, u: 10 };

// D first (#903): an entry deleted in the index or the worktree is gone from the disk, whatever its other letter says. v2's `.` (unchanged)
// is no letter here
const markOf = (xy: string): GitMark => {
  if (xy.includes('D')) return 'D';
  return RENAME_OR_COPY.test(xy) || xy.startsWith('A') ? 'A' : 'M';
};

// A path may hold spaces: it is everything after the fixed fields
function pathAfter(entry: string, fields: number): string {
  let at = 0;
  for (let i = 0; i < fields; i++) at = entry.indexOf(' ', at) + 1;
  return entry.slice(at);
}

type Entry =
  | { kind: 'head'; branch?: string }
  | { kind: 'ignored' | 'untracked'; path: string }
  | { kind: 'changed'; path: string; mark: GitMark; hasOrigin: boolean }
  | { kind: 'other' };

function entryOf(entry: string): Entry {
  if (entry.startsWith(BRANCH_HEAD)) {
    const name = entry.slice(BRANCH_HEAD.length);
    return name === DETACHED ? { kind: 'head' } : { kind: 'head', branch: name };
  }
  if (entry.startsWith('! ')) return { kind: 'ignored', path: entry.slice(2) };
  if (entry.startsWith('? ')) return { kind: 'untracked', path: entry.slice(2) };
  const fields = FIELDS_BEFORE_PATH[entry.charAt(0)];
  if (fields === undefined || entry.charAt(1) !== ' ') return { kind: 'other' }; // the other `#` headers, the trailing empty entry
  return { kind: 'changed', path: pathAfter(entry, fields), mark: markOf(entry.slice(2, 4)), hasOrigin: entry.charAt(0) === '2' };
}

/** `git status --porcelain=v2 -z` (#502), replacing the v1 reader of redesign 07. A removed path is marked D and listed as deleted (#903);
 *  a staged delete re-created on disk comes back after its D, and the later entry wins. Pure: no git. */
export function parseStatus(text: string): GitStatus {
  const entries = text.split('\0');
  const marks: Record<string, GitMark> = {};
  const deleted = new Set<string>();
  const ignored: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entryOf(entries[i]);
    if (entry.kind === 'head') branch = entry.branch;
    else if (entry.kind === 'ignored') ignored.push(entry.path);
    else if (entry.kind === 'untracked' && entry.path.endsWith('/')) untracked.push(entry.path);
    else if (entry.kind === 'untracked' || entry.kind === 'changed') {
      if (entry.kind === 'changed' && entry.hasOrigin) i++;
      const mark = entry.kind === 'changed' ? entry.mark : 'A';
      marks[entry.path] = mark;
      if (mark === 'D') deleted.add(entry.path);
      else deleted.delete(entry.path);
    }
  }
  return { marks, deleted, ignored, untracked, ...(branch === undefined ? {} : { branch }) };
}
