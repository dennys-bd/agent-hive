import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorkspaceBase } from './fork.js';
import type { Activity, Checkpoint, Task, DiffHunk, DiffLine, DiffScope, Exec, FileDiff } from './types.js';
import { SHORT_SHA } from './tasks.js';
import { gitOrWords, wordsOf } from './worktree.js';

/** The most `git diff` output the viewer takes (#270): past it the route answers 413 instead of freezing the window on a vendored or
 * generated tree. execFile's own 1 MB default would fail sooner, with a less clear error. */
export const DIFF_MAX_BYTES = 5 * 1024 * 1024;

const FILE_START = 'diff --git ';
const HUNK_START = '@@ ';
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const BINARY = /^Binary files .* differ$/;
const SRC_PREFIX = 'a/'; // taskDiff pins both prefixes: a user's diff.noprefix or diff.mnemonicPrefix would change them
const PAIR_OVERHEAD = 'a/ b/'.length; // what `diff --git a/<p> b/<p>` adds around its two copies of the path
const LINE_KIND: Partial<Record<string, DiffLine['kind']>> = { ' ': 'context', '+': 'add', '-': 'del' };
const OVERFLOW_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'; // execFile's code when the output passes maxBuffer
const REMOTE_DEFAULT = 'HEAD'; // <remote>/HEAD: the remote's default branch, when no base is set
const PARENT = 'HEAD^'; // the commit scope's base (#591): the last commit's first parent, a merge's too

/** Every scope a diff tab shows (#270, #591), what the routes accept. */
export const DIFF_SCOPES: readonly DiffScope[] = ['stage', 'worktree', 'commit', 'checkpoint'];
export const isScope = (value: unknown): value is DiffScope => DIFF_SCOPES.includes(value as DiffScope);

/** The commit scope on a root commit (#591): nothing to diff from, the route's 409. */
export class NoParentCommit extends Error {
  constructor() {
    super('the last commit has no parent');
    this.name = 'NoParentCommit';
  }
}

// The indexes of the lines that open a section. A hunk's own lines always start with ' ', '+', '-' or '\', so a `diff --git ` or an `@@ `
// at the start of a line is always a header, never content (a deleted `-- x` reads `--- x`, which is why `---` / `+++` are never matched).
const startsOf = (lines: string[], prefix: string): number[] => lines.flatMap((line, i) => (line.startsWith(prefix) ? [i] : []));
const sections = (lines: string[], starts: number[]): string[][] => starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length));

/** A file as parsed, before its hash (#591). */
export type ParsedFile = Omit<FileDiff, 'hash'>;

/** What a reviewed mark compares (#591): a sha256 of the file's diff, its status, its old path and its hunks; the path is the mark's key. */
export const fileHash = (file: ParsedFile): string =>
  createHash('sha256').update(JSON.stringify({ status: file.status, oldPath: file.oldPath ?? null, hunks: file.hunks })).digest('hex');

export const withHash = (file: ParsedFile): FileDiff => ({ ...file, hash: fileHash(file) });

/** `git diff --no-color -M` output as files, hunks and numbered lines (#270): what the viewer draws and what a later line comment or hunk
 * revert addresses. Pure: no git. */
export function parseDiff(text: string): ParsedFile[] {
  const lines = text.split('\n');
  return sections(lines, startsOf(lines, FILE_START)).map(parseFile);
}

function parseFile(lines: string[]): ParsedFile {
  const hunkStarts = startsOf(lines, HUNK_START);
  return { ...fileHead(lines.slice(0, hunkStarts[0] ?? lines.length)), hunks: sections(lines, hunkStarts).map(parseHunk) };
}

// `diff --git a/<p> b/<p>`: with no rename (copies are not detected) both halves are the same path, so the line's length fixes the path's.
// That also names a file with no hunk: a binary one, a pure mode change, an empty new file.
// ponytail: a path git still quotes (a `"`, a `\` or a control character in it) keeps its quotes; unquote it if one ever shows up.
function headerPath(header: string): string {
  const both = header.slice(FILE_START.length);
  return both.slice(SRC_PREFIX.length, SRC_PREFIX.length + (both.length - PAIR_OVERHEAD) / 2);
}

// A file's status from its extended header: git writes a mode line for a new or deleted file, and rename lines for a rename (-M).
function fileStatus(head: string[], renamed: boolean): FileDiff['status'] {
  if (head.some((l) => l.startsWith('new file mode'))) return 'added';
  if (head.some((l) => l.startsWith('deleted file mode'))) return 'deleted';
  return renamed ? 'renamed' : 'modified';
}

// The extended header before the first hunk: the path, the rename's old path, the status, and whether git called it binary.
function fileHead(head: string[]): Omit<ParsedFile, 'hunks'> {
  const after = (prefix: string): string | undefined => head.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const from = after('rename from ');
  return {
    path: after('rename to ') ?? headerPath(head[0]),
    status: fileStatus(head, from !== undefined),
    ...(from === undefined ? {} : { oldPath: from }),
    ...(head.some((l) => BINARY.test(l)) ? { binary: true as const } : {}),
  };
}

// A hunk's lines, numbered from its header on each side they exist on. `\ No newline at end of file` and the trailing empty line are skipped.
function parseHunk([header, ...body]: string[]): DiffHunk {
  const [, oldStart, newStart] = HUNK_HEADER.exec(header) ?? [];
  let old = Number(oldStart);
  let now = Number(newStart);
  const lines = body.flatMap((raw): DiffLine[] => {
    const kind = LINE_KIND[raw.charAt(0)];
    if (kind === undefined) return [];
    const text = raw.slice(1);
    if (kind === 'add') return [{ kind, text, new: now++ }];
    if (kind === 'del') return [{ kind, text, old: old++ }];
    return [{ kind, text, old: old++, new: now++ }];
  });
  return { header, lines };
}

/** A diff past DIFF_MAX_BYTES (#270): the route's 413. */
export class DiffTooLarge extends Error {
  constructor() {
    super(`git diff passed ${DIFF_MAX_BYTES} bytes`);
    this.name = 'DiffTooLarge';
  }
}

/** Whether a failed exec is execFile's own overflow (#270): a RangeError carrying ERR_CHILD_PROCESS_STDIO_MAXBUFFER. */
export const isOverflow = (err: unknown): boolean => (err as { code?: unknown } | undefined)?.code === OVERFLOW_CODE;

// git on the throwaway index: an output past maxBuffer is DiffTooLarge, any other failure git's own words. Not gitOrWords, which rewords
// every failure into a plain Error the route could no longer tell apart.
// core.fsmonitor=false: the worktree is the worker's, and its config could name a monitor command that every index read would run.
async function diffGit(worktree: string, args: string[], opts: { env: NodeJS.ProcessEnv; maxBuffer: number }, exec: Exec): Promise<string> {
  try {
    return (await exec('git', ['-C', worktree, '-c', 'core.fsmonitor=false', ...args], opts)).stdout;
  } catch (err) {
    throw isOverflow(err) ? new DiffTooLarge() : new Error(wordsOf(err));
  }
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

// The worktree's index copied to a temp dir, every file added there only, and `fn` run against it; the temp dir goes whatever happens (#270)
async function withIndexCopy<T>(worktree: string, exec: Exec, fn: (opts: { env: NodeJS.ProcessEnv; maxBuffer: number }) => Promise<T>): Promise<T> {
  // a linked worktree's index lives under the main repo's .git/worktrees/; git answers a path relative to the worktree or an absolute one
  const index = resolve(worktree, (await gitOrWords(worktree, ['rev-parse', '--git-path', 'index'], exec)).trim());
  const dir = await mkdtemp(join(tmpdir(), 'hive-diff-'));
  try {
    const copy = join(dir, 'index');
    await copyFile(index, copy);
    const opts = { env: { ...process.env, GIT_INDEX_FILE: copy }, maxBuffer: DIFF_MAX_BYTES };
    await diffGit(worktree, ['add', '-A'], opts, exec);
    return await fn(opts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The worktree as it is on disk against `base` (#270): commits, staged and unstaged changes, and untracked files .gitignore does not
 * exclude. The worktree's index is copied to a fresh temp dir and only the copy takes `git add -A`, so the real index, which a worker may be
 * using, is never written; the add does store the untracked files' blobs in the object store, unreferenced, for gc to prune. One `diff
 * --cached -M` then gives renames and a single format to parse. The temp dir goes whatever happens.
 */
export async function taskDiff(worktree: string, base: string, exec: Exec): Promise<FileDiff[]> {
  return withIndexCopy(worktree, exec, async (opts) =>
    parseDiff(await diffGit(worktree, ['-c', 'core.quotepath=off', 'diff', '--cached', ...DIFF_FLAGS, '--end-of-options', base], opts, exec)).map(withHash));
}

/** The worktree against `base` as an evaluation reads it (#877): `--stat` and the patch, on taskDiff's index copy, so untracked files show too. */
export async function taskPatch(worktree: string, base: string, exec: Exec): Promise<{ stat: string; patch: string }> {
  return withIndexCopy(worktree, exec, async (opts) => {
    const diff = (extra: string[]): Promise<string> => diffGit(worktree, ['-c', 'core.quotepath=off', 'diff', '--cached', ...DIFF_FLAGS, ...extra, '--end-of-options', base], opts, exec);
    return { stat: await diff(['--stat']), patch: await diff([]) };
  });
}

/** The commit scope (#591): what the last commit changed, HEAD^ against HEAD, with the pinned flags; no index copy, none of the uncommitted work. */
export async function commitDiff(worktree: string, exec: Exec): Promise<FileDiff[]> {
  const args = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--end-of-options', PARENT, 'HEAD'];
  return parseDiff(await diffGit(worktree, args, { env: process.env, maxBuffer: DIFF_MAX_BYTES }, exec)).map(withHash);
}

// HEAD^ as a sha (#591). A root commit has none and rev-parse --verify fails; any failure reads as that one.
async function parentBase(worktree: string, exec: Exec): Promise<DiffBase> {
  try {
    const commit = (await exec('git', ['-C', worktree, 'rev-parse', '--verify', '--quiet', `${PARENT}^{commit}`])).stdout.trim();
    return { commit, label: `${commit.slice(0, SHORT_SHA)} (${PARENT})` };
  } catch {
    throw new NoParentCommit();
  }
}

/** The commit a scope diffs from, and how the view's header names it (#270). */
export interface DiffBase { commit: string; label: string }

/**
 * The base per scope (#270). Stage: the current stage's recorded start (#283), which refs/hive/<slug>/stage-start keeps alive; a feedback
 * round records none, so the diff covers every round of the stage. Worktree: where HEAD left the ref the worktree was created from (#119,
 * #131), so the diff reads as the PR would: the task's chosen base, else <base remote>/<base>, else <base remote>/HEAD. A failed merge-base rejects
 * with git's words. Commit (#591): HEAD^. --end-of-options: the ref is one the Hive stored, but one starting with `-` must never be an option.
 */
export async function diffBase(_task: Task, activity: Pick<Activity, 'base' | 'stageStart'> | undefined, base: Pick<WorkspaceBase, 'remote' | 'branch'>, worktree: string, scope: DiffScope, exec: Exec, checkpoint?: Pick<Checkpoint, 'n' | 'commit'>): Promise<DiffBase> {
  if (scope === 'checkpoint') { // #619: the checkpoint's restore point; the route answers 400 before an unknown one gets here
    if (checkpoint === undefined) throw new Error('no checkpoint chosen');
    return { commit: checkpoint.commit, label: `${checkpoint.commit.slice(0, SHORT_SHA)} (checkpoint ${checkpoint.n})` };
  }
  if (scope === 'commit') return parentBase(worktree, exec);
  if (scope === 'stage') {
    const start = activity?.stageStart;
    if (start === undefined) throw new Error('no stage start recorded'); // canDiff refuses the task before this runs
    return { commit: start.commit, label: start.commit.slice(0, SHORT_SHA) };
  }
  const ref = activity?.base?.ref ?? `${base.remote}/${base.branch ?? REMOTE_DEFAULT}`; // #854: the workspace's base remote and base
  const commit = (await gitOrWords(worktree, ['merge-base', '--end-of-options', 'HEAD', ref], exec)).trim();
  return { commit, label: `${commit.slice(0, SHORT_SHA)} (${ref})` };
}
