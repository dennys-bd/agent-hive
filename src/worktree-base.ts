import { type ForkRepos, failureOf, forkRepos, ownerOf, syncFork, type WorkspaceBase } from './fork.js';
import { type BranchRelation, type Exec, type ForkSyncAnswer, type ForkSyncResult, isBranchName } from './types.js';

// The start point of a new worktree or checkout branch (#119, #131), out of worktree.ts, which was at 398 lines when a fork's sync came around
// it (#854). Every git call goes through `gitOrWords` bound to a folder (the caller's `git`), so a refusal carries git's own words.

/** git in one folder; a failure rejects with git's words. */
export type Git = (...args: string[]) => Promise<string>;

// git's own words for a failure: its stderr, else the error's message (execFile's would bury them under the command line). Here since #267, so
// the branch's class can read them without an import cycle; worktree.ts re-exports both. Exported for the task diff (#270), which must tell
// execFile's overflow apart before it rewords anything.
export const wordsOf = (err: unknown): string => {
  const e = err as { stderr?: string; message: string };
  return (e.stderr ?? '').trim() || e.message;
};

// A failure carries git's own words (stderr) so the task says why; restart.ts runs its git the same way (#283).
export async function gitOrWords(repo: string, args: string[], exec: Exec): Promise<string> {
  try {
    return (await exec('git', ['-C', repo, ...args])).stdout;
  } catch (err) {
    throw new Error(wordsOf(err));
  }
}

/** A git question whose exit 1 is an answer (#267): exit 0 is true, exit 1 false (no merge base, not an ancestor, not merged), any other
 * failure rejects with git's words. */
export function gitAnswers(repo: string, args: string[], exec: Exec): Promise<boolean> {
  return exec('git', ['-C', repo, ...args]).then(() => true, (err: { code?: unknown }) => {
    if (err.code === 1) return false;
    throw new Error(wordsOf(err));
  });
}

/** How an existing branch relates to `start` (#267): `unrelated` with no merge base (#105's branch from before the docs split), `stale` when it
 * is an ancestor of the start with nothing of its own, `own` otherwise. Read-only. The ref is built here and the start is the Hive's, never
 * a client's: neither can start with `-`. */
export async function branchRelation(repo: string, branch: string, start: string, exec: Exec): Promise<BranchRelation> {
  const ref = `refs/heads/${branch}`;
  if (!(await gitAnswers(repo, ['merge-base', '--', ref, start], exec))) return 'unrelated';
  return (await gitAnswers(repo, ['merge-base', '--is-ancestor', ref, start], exec)) ? 'stale' : 'own';
}

const OLD = '-old-';
const SHORT_SHA = 7;

/** Moves a branch out of the way without losing a commit (#267): renamed to `<branch>-old-<sha7>`, or deleted when that name already holds the
 * very same commit; a short name another commit took gets the full sha. Answers the name the work now lives under. `branch` is always the
 * name the Hive rendered, never a client's, so it cannot start with `-`. */
export async function setAside(repo: string, branch: string, exec: Exec): Promise<string> {
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  const tip = (await git('rev-parse', '--verify', `refs/heads/${branch}`)).trim();
  const short = `${branch}${OLD}${tip.slice(0, SHORT_SHA)}`;
  const taken = await git('rev-parse', '--verify', '--quiet', `refs/heads/${short}`).then((out) => out.trim(), () => undefined);
  const name = taken === undefined || taken === tip ? short : `${branch}${OLD}${tip}`;
  if (!isBranchName(name)) throw new Error(`${name}: not a branch name`);
  if (taken === tip) await git('branch', '-D', '--', branch);
  else await git('branch', '-m', '--', branch, name);
  return name;
}

/** What the base step decided (#854): the start point and its short sha, the `base: …` line, a GitHub sync already run, and a local merge to
 * run in the new tree once it exists. */
export interface DecidedBase { start?: string; sha?: string; line: string; sync?: ForkSyncAnswer; merge?: { remote: string; branch: string; owner: string } }

const FALLBACK_BASE = 'main';

/** The line the server logs when the start falls back to whatever the checkout points at: the reason first, git's own words. */
const localBase = (why: string): string => `base: ${why}, starting from the local base`;

/** The remote's default branch, from the local refs/remotes/<remote>/HEAD symref (`origin/main` → `main`). When git cannot read it (a `git remote
 * add` never sets one), `canSet` runs `remote set-head <remote> --auto` once, which writes only that local ref, and reads again; still none:
 * main, the issue's own default. Never rejects. */
export async function remoteHead(git: Git, remote: string, canSet = true): Promise<string> {
  const read = (): Promise<string | undefined> => git('symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`).then((out) => out.trim(), () => undefined);
  const first = await read();
  const ref = first ?? (canSet ? await git('remote', 'set-head', remote, '--auto').then(read, () => undefined) : undefined) ?? '';
  return (ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref) || FALLBACK_BASE;
}

// The one case where the user's own checkout may be written to: already on the base, with nothing staged or unstaged (untracked files never
// block a fast-forward). A detached HEAD answers nothing. Both reads always run, so the git sequence keeps its shape.
async function onBaseAndClean(git: Git, base: string): Promise<boolean> {
  const head = (await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')).trim();
  const clean = (await git('status', '--porcelain', '--untracked-files=no')).trim() === '';
  return head === base && clean;
}

// The fetch both bases run: a failure is the line's note, never fatal. --end-of-options: a branch named `--upload-pack=<cmd>` stays a refspec.
const fetchNote = (git: Git, remote: string, name: string): Promise<string> =>
  git('fetch', remote, '--end-of-options', name).then(() => '', (err: Error) => ` (fetch failed: ${err.message})`);

// The #119 start: `<remote>/<base>` fetched, the checkout fast-forwarded when it sits clean on the base. Never rejects: a failure is the line
async function baseFor(git: Git, remote: string, base: string): Promise<Omit<DecidedBase, 'sync' | 'merge'>> {
  try {
    const note = await fetchNote(git, remote, base);
    const merged = (await onBaseAndClean(git, base)) && (await git('merge', '--ff-only', `${remote}/${base}`).then(() => true, () => false));
    const head = merged ? (await git('rev-parse', '--short', 'HEAD').catch(() => '')).trim() : ''; // the merge already moved HEAD
    const ff = merged ? ` (checkout fast-forwarded${head === '' ? '' : ` to ${head}`})` : '';
    const sha = (await git('rev-parse', '--verify', '--quiet', '--short', `refs/remotes/${remote}/${base}`).catch(() => '')).trim();
    if (sha === '') return { line: `${localBase(`${remote}/${base} unknown${note}`)}${ff}` };
    return { start: `${remote}/${base}`, sha, line: `base: ${remote}/${base} (${sha})${ff}${note}` };
  } catch (err) {
    return { line: localBase((err as Error).message) }; // one invariant for the whole step: a line, never a rejection
  }
}

/** The default start (#119, #854): the effective base resolved on the base remote; a fork whose PRs may go to it syncs on GitHub before the
 * fetch, or plans the local merge for after the add (pr fork only). Never rejects: a failure is the line or the sync's result. */
export async function defaultBase(git: Git, repo: string, base: WorkspaceBase, exec: Exec): Promise<DecidedBase> {
  const branch = base.branch ?? (await remoteHead(git, base.remote));
  const own = base.fork;
  const fork = own && own.pr !== 'original' ? own : undefined;
  const repos: ForkRepos | undefined = fork === undefined || fork.sync === 'manual' ? undefined : await forkRepos(exec, { path: repo, fork });
  const sync = fork?.sync === 'github' ? await syncFork(exec, repos, branch) : undefined;
  const found = await baseFor(git, base.remote, branch);
  const owner = repos === undefined ? 'origin' : ownerOf(repos.fork);
  const merge = fork?.pr === 'fork' && fork.sync === 'local' ? { remote: fork.remote, branch, owner } : undefined;
  return { ...found, ...(sync === undefined ? {} : { sync }), ...(merge === undefined ? {} : { merge }) };
}

/** The start point the user picked in the popup (#131): `<remote>/<x>` is fetched first and must resolve as refs/remotes/<remote>/<x>; anything
 * else is a local branch, as it is. Rejects, with git's words, when it does not resolve: starting from another would put the work on the
 * wrong base. No fork sync: the user chose this code. */
export async function chosenBase(git: Git, remote: string, chosen: string): Promise<DecidedBase> {
  const name = chosen.startsWith(`${remote}/`) ? chosen.slice(remote.length + 1) : undefined;
  const note = name === undefined ? '' : await fetchNote(git, remote, name);
  const ref = name === undefined ? `refs/heads/${chosen}` : `refs/remotes/${chosen}`;
  const sha = await git('rev-parse', '--verify', '--short', ref).catch((err: Error) => {
    throw new Error(`base: ${chosen} unknown (${err.message})${note}`);
  });
  return { start: chosen, line: `base: ${chosen} (${sha.trim()}), chosen by hand${note}` };
}

type MergeAnswer = Pick<ForkSyncResult, 'result' | 'commits' | 'files' | 'reason'>;

// The local mode (#854): the original's base fetched, then merged into the new tree only. A conflict is undone after its files are read
async function mergeOriginal(git: Git, remote: string, branch: string): Promise<MergeAnswer> {
  const ref = `${remote}/${branch}`;
  try {
    await git('fetch', remote, '--end-of-options', branch);
    const commits = Number((await git('rev-list', '--count', `HEAD..${ref}`)).trim());
    if (commits === 0) return { result: 'current', commits: 0 };
    const refused = await git('merge', '--no-edit', ref).then(() => undefined, (err: unknown) => err);
    if (refused === undefined) return { result: 'synced', commits };
    const files = (await git('diff', '--name-only', '--diff-filter=U')).split('\n').filter((file) => file !== '');
    await git('merge', '--abort').catch(() => ''); // nothing to abort when the merge never started
    return files.length > 0 ? { result: 'conflict', files } : failureOf(refused);
  } catch (err) {
    return failureOf(err);
  }
}

/** The fork's sync for a worktree just made (#854), with the start's short sha and the time: defaultBase's GitHub sync, or the local merge run
 * now in the new tree (`inTree`; undefined when the branch already existed). */
export async function settleSync(decided: DecidedBase, inTree: Git | undefined): Promise<ForkSyncResult | undefined> {
  const stamp = { sha: decided.sha ?? '', at: new Date().toISOString() };
  if (decided.merge !== undefined && inTree !== undefined) {
    const { remote, branch, owner } = decided.merge;
    return { ...(await mergeOriginal(inTree, remote, branch)), mode: 'local', base: `${owner}:${branch}`, ...stamp };
  }
  return decided.sync === undefined ? undefined : { ...decided.sync, ...stamp };
}

/** The `base: …` line with the sync's result after it (#854). The reason stays out: the line is logged, and the reason is gh's or git's words. */
export const withSync = (line: string, sync: ForkSyncResult | undefined): string =>
  (sync === undefined ? line : `${line} · sync ${sync.mode} ${sync.result}${sync.commits === undefined ? '' : ` ${sync.commits}`}`);

/** What ensureWorktree does with a branch that already exists (#267): reuse it, recreate it at the start (`reset`, `worktree add -B`), or set
 * it aside and start it fresh (`fresh`), with the note its `base:` line gets. Without a start (the base could not be refreshed) there is
 * nothing to classify against: reused, as before #267. */
export interface ExistingBranch { action: 'reuse' | 'reset' | 'fresh'; note?: string }

export async function existingBranch(repo: string, branch: string, start: string | undefined, exec: Exec): Promise<ExistingBranch> {
  if (start === undefined) return { action: 'reuse' };
  const relation = await branchRelation(repo, branch, start, exec);
  if (relation === 'own') return { action: 'reuse' };
  if (relation === 'stale') return { action: 'reset', note: `branch ${branch} was behind ${start} with nothing of its own: recreated from ${start}` };
  const kept = await setAside(repo, branch, exec);
  return { action: 'fresh', note: `branch ${branch} shares no history with ${start}: kept as ${kept}, started from ${start}` };
}
