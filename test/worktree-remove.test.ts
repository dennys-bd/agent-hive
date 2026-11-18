import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Activity, Exec, TaskPr } from '../src/types.js';
import { cleanWorktree, removeWorktree } from '../src/worktree-remove.js';
import { worktreePath } from '../src/worktree.js';
import { fakeMachine } from './fakes.js';
import { tempDir, type AfterHost } from './temp-dir.js';
import { BRANCH, CLEAN_BRANCH, fakeExec, gone, listing, porcelain, repoWith, SLUG } from './worktree-fakes.js';

const TASK = { slug: 'hive-7-fix' };
const NOT_FOUND = "Command failed: git -C /r branch -D -- hive-7-fix\nerror: branch 'hive-7-fix' not found.\n";

test('lists, removes <repo>/.hive/worktrees/<slug> with --force twice, prunes, deletes the branch git had checked out there and the prompt file, in that order', async (t) => {
  const { repo, promptsDir, prompt, worktree } = await repoWith(t, { worktree: true });
  const { exec, calls } = fakeExec({ listing: listing(repo, worktree) });
  await removeWorktree(fakeMachine({ exec }), repo, TASK, BRANCH, promptsDir);
  assert.deepEqual(calls, [
    ['git', '-C', repo, 'worktree', 'list', '--porcelain'],
    ['git', '-C', repo, 'worktree', 'remove', '--force', '--force', '--', worktree],
    ['git', '-C', repo, 'worktree', 'prune'],
    ['git', '-C', repo, 'branch', '-D', '--', 'feat/x'],
  ]);
  await gone(prompt);
});

test('removeWorktree deletes the prompt file through the machine\'s fs, after git (#159)', async (t) => {
  const repo = await tempDir(t, 'repo-');
  const promptsDir = await tempDir(t, 'prompts-');
  const { exec, calls } = fakeExec({ listing: listing(repo, worktreePath(repo, TASK.slug)) });
  const unlinked: string[] = [];
  const machine = fakeMachine({ exec, fs: { unlink: async (path) => { unlinked.push(path); } } });
  await removeWorktree(machine, repo, TASK, BRANCH, promptsDir);
  assert.deepEqual(unlinked, [join(promptsDir, `${TASK.slug}.md`)]);
  assert.ok(calls.length > 0, 'git ran first, through the same machine');
});

test('the task never chooses the path or the branch: only the slug is read off it, and the path is derived from it', async (t) => {
  const { repo, promptsDir, worktree } = await repoWith(t, { worktree: true });
  const { exec, calls } = fakeExec({ listing: listing(repo, worktree) });
  await removeWorktree(fakeMachine({ exec }), repo, { ...TASK, ...({ worktree: '/elsewhere', branch: 'main' } as object) }, BRANCH, promptsDir);
  assert.deepEqual(calls.map((c) => c.slice(3)), [
    ['worktree', 'list', '--porcelain'], ['worktree', 'remove', '--force', '--force', '--', worktree], ['worktree', 'prune'], ['branch', '-D', '--', 'feat/x'],
  ], 'a forged path or branch on the task changes nothing');
});

test('not listed by git (removed by hand, pruned): the remove is skipped, prune still runs and the branch the Hive rendered for the task goes; a prompt file already gone is not an error', async (t) => {
  const { repo, promptsDir, prompt } = await repoWith(t);
  await rm(prompt);
  const { exec, calls } = fakeExec({ listing: listing(repo, worktreePath(repo, 'hive-7-fix-2')) });
  await removeWorktree(fakeMachine({ exec }), repo, TASK, BRANCH, promptsDir);
  assert.deepEqual(calls.map((c) => c.slice(3)), [['worktree', 'list', '--porcelain'], ['worktree', 'prune'], ['branch', '-D', '--', BRANCH]]);
});

test('a listed worktree with a detached HEAD: the worktree goes, no branch is deleted', async (t) => {
  const { repo, promptsDir, worktree } = await repoWith(t, { worktree: true });
  const { exec, calls } = fakeExec({ listing: `worktree ${worktree}\nHEAD 2222\ndetached\n` });
  await removeWorktree(fakeMachine({ exec }), repo, TASK, BRANCH, promptsDir);
  assert.deepEqual(calls.map((c) => c[3]), ['worktree', 'worktree', 'worktree'], 'list, remove, prune; no branch -D');
});

test('a branch that does not exist is swallowed; any other git error propagates and stops the rest', async (t) => {
  const { repo, promptsDir, prompt } = await repoWith(t);
  await removeWorktree(fakeMachine({ exec: fakeExec({ failing: '-D', message: NOT_FOUND }).exec }), repo, TASK, BRANCH, promptsDir);
  await gone(prompt);
  const checkedOut = fakeExec({ failing: '-D', message: "Command failed: git -C /r branch -D -- hive-7-fix\nerror: cannot delete branch 'hive-7-fix' used by worktree at '/w'\n" });
  await assert.rejects(removeWorktree(fakeMachine({ exec: checkedOut.exec }), repo, TASK, BRANCH, promptsDir), { message: /cannot delete branch/ });
  const again = await repoWith(t);
  const prune = fakeExec({ failing: 'prune' });
  await assert.rejects(removeWorktree(fakeMachine({ exec: prune.exec }), again.repo, TASK, BRANCH, again.promptsDir), { message: 'prune boom' });
  assert.deepEqual(prune.calls.map((c) => c[4]), ['list', 'prune'], 'nothing after the failing step');
  assert.equal(await readFile(again.prompt, 'utf8'), 'prompt', 'the prompt file stays when git failed before it');
});

// ---- cleanWorktree: the delete activity stage's action, no force ----


const UPSTREAM_FORMAT = '--format=%(upstream)%00%(upstream:track)'; // mergeCheck's one read: the upstream and whether git calls it gone (#660)
const GONE_UPSTREAM = 'refs/remotes/origin/hive/58-clear-worktree';

// cleanWorktree's git: lists `listed`, knows `branches`, answers the status read inside the worktree with `answers.status` and the
// branch's upstream and its track with `answers.upstream` / `answers.track`, refuses the commands in `refuse` (key: the first two words) with their stderr and exit
// code 1, and records every argv after `-C <dir>`.
function cleanGit(repo: string, listed: string, branches: string[], refuse: Record<string, string> = {}, answers: { status?: string; upstream?: string; track?: string } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const fail = (command: string[], stderr: string): never => {
    throw Object.assign(new Error(`Command failed: git ${command.join(' ')}`), { stderr, code: 1 });
  };
  const exec: Exec = async (file, args) => {
    assert.equal(file, 'git');
    const command = args.slice(2);
    const dir = command[0] === 'status' ? worktreePath(repo, SLUG) : repo;
    assert.deepEqual(args.slice(0, 2), ['-C', dir], 'the status is read inside the worktree; every other command runs against the main checkout');
    calls.push(command);
    const key = command.slice(0, 2).join(' ');
    if (key in refuse) return fail(command, refuse[key]);
    if (key === 'worktree list') return { stdout: listed };
    if (key === 'rev-parse --verify') return branches.includes(command.at(-1)!.replace('refs/heads/', '')) ? { stdout: '0123456\n' } : fail(command, '');
    if (key === 'status --porcelain') return { stdout: answers.status ?? '' };
    if (key === `for-each-ref ${UPSTREAM_FORMAT}`) return { stdout: `${answers.upstream ?? ''}\0${answers.track ?? ''}\n` };
    return { stdout: '' };
  };
  return { exec, calls };
}

// What the pre-check runs for CLEAN_BRANCH with no upstream: the upstream lookup, then the ancestry test against HEAD.
const MERGE_CHECK = [['for-each-ref', UPSTREAM_FORMAT, `refs/heads/${CLEAN_BRANCH}`], ['merge-base', '--is-ancestor', `refs/heads/${CLEAN_BRANCH}`, 'HEAD']];

async function cleanRepo(t: AfterHost, worktree: boolean): Promise<{ repo: string; path: string }> {
  const repo = await tempDir(t, 'wt-');
  const path = worktreePath(repo, SLUG);
  if (worktree) await mkdir(path, { recursive: true });
  return { repo, path };
}

test('a registered worktree whose directory exists is removed, then its branch deleted; the branch is the one the listing names', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const { exec, calls } = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH]);
  await cleanWorktree(fakeMachine({ exec }), repo, { slug: SLUG, branch: CLEAN_BRANCH }, CLEAN_BRANCH);
  assert.deepEqual(calls, [
    ['worktree', 'list', '--porcelain'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${CLEAN_BRANCH}`],
    ['status', '--porcelain'],
    ...MERGE_CHECK,
    ['worktree', 'remove', '--', path],
    ['branch', '-d', '--', CLEAN_BRANCH],
  ], 'everything git would refuse is checked before anything is removed (#182)');
});

test('a registered worktree whose directory is gone is pruned; the path is derived from the slug, without task.branch the branch comes from the listing', async (t) => {
  const { repo, path } = await cleanRepo(t, false);
  const { exec, calls } = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH]);
  await cleanWorktree(fakeMachine({ exec }), repo, { slug: SLUG }, CLEAN_BRANCH);
  assert.deepEqual(calls, [
    ['worktree', 'list', '--porcelain'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${CLEAN_BRANCH}`],
    ...MERGE_CHECK, // no directory: no status to read
    ['worktree', 'prune'],
    ['branch', '-d', '--', CLEAN_BRANCH],
  ]);
});

test('not registered and no branch anywhere: only the listing runs; not registered but a known branch on the task: only the branch goes; a branch git does not know is done', async (t) => {
  const { repo } = await cleanRepo(t, false);
  const nothing = cleanGit(repo, porcelain(repo, []), []);
  await cleanWorktree(fakeMachine({ exec: nothing.exec }), repo, { slug: SLUG }, CLEAN_BRANCH);
  assert.deepEqual(nothing.calls, [['worktree', 'list', '--porcelain']], 'a task that never ran here still advances');
  const branchOnly = cleanGit(repo, porcelain(repo, []), [CLEAN_BRANCH]);
  await cleanWorktree(fakeMachine({ exec: branchOnly.exec }), repo, { slug: SLUG, branch: CLEAN_BRANCH }, CLEAN_BRANCH);
  assert.deepEqual(branchOnly.calls.map((c) => c[0]), ['worktree', 'rev-parse', 'for-each-ref', 'merge-base', 'branch'], 'the worktree is already gone: the branch is still ours to delete, once merged');
  const unknownBranch = cleanGit(repo, porcelain(repo, []), []);
  await cleanWorktree(fakeMachine({ exec: unknownBranch.exec }), repo, { slug: SLUG, branch: CLEAN_BRANCH }, CLEAN_BRANCH);
  assert.deepEqual(unknownBranch.calls.map((c) => c[0]), ['worktree', 'rev-parse'], 'rev-parse says no: nothing to delete, no error');
});

test('git refusing the remove (dirty) or the delete (unmerged) rejects with git\'s own stderr; after a refused remove the branch is left alone', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const dirty = `fatal: '${path}' contains modified or untracked files, use --force to delete it`;
  const refusedRemove = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], { 'worktree remove': dirty });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: refusedRemove.exec }), repo, { slug: SLUG, branch: CLEAN_BRANCH }, CLEAN_BRANCH), { message: dirty });
  assert.deepEqual(refusedRemove.calls.map((c) => c[0]), ['worktree', 'rev-parse', 'status', 'for-each-ref', 'merge-base', 'worktree'], 'the checks passed and git refused anyway (a locked worktree): the branch is not touched');
  const unmerged = `error: The branch '${CLEAN_BRANCH}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${CLEAN_BRANCH}'.`;
  const refusedDelete = cleanGit(repo, porcelain(repo, []), [CLEAN_BRANCH], { 'branch -d': unmerged });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: refusedDelete.exec }), repo, { slug: SLUG, branch: CLEAN_BRANCH }, CLEAN_BRANCH), { message: unmerged });
  const noStderr = cleanGit(repo, '', [], { 'worktree list': '' });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: noStderr.exec }), repo, { slug: SLUG }, CLEAN_BRANCH), /Command failed: git worktree list/, 'no stderr: the error message itself');
});

test('the path is always <repo>/.hive/worktrees/<slug>: the activity\'s worktree (a SessionStart cwd any local process can post) is display only, never read', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  for (const worktree of [repo, '/etc', worktreePath(repo, 'hive-other-task'), `${join(repo, '.hive', 'worktrees')}-evil/x`, undefined]) {
    const { exec, calls } = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH]);
    const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: SLUG, worktree, branch: CLEAN_BRANCH }; // #629: the worktree fields are the activity's
    await cleanWorktree(fakeMachine({ exec }), repo, activity, CLEAN_BRANCH);
    assert.deepEqual(calls.map((c) => c.slice(0, 3)), [
      ['worktree', 'list', '--porcelain'], ['rev-parse', '--verify', '--quiet'], ['status', '--porcelain'],
      ['for-each-ref', UPSTREAM_FORMAT, `refs/heads/${CLEAN_BRANCH}`], ['merge-base', '--is-ancestor', `refs/heads/${CLEAN_BRANCH}`],
      ['worktree', 'remove', '--'], ['branch', '-d', '--'],
    ], String(worktree));
  }
});

test('an upstream git reads [gone] (GitHub deleted the remote branch after the merge) counts as none: merged into HEAD, the worktree and the branch go (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const gone = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], {}, { upstream: GONE_UPSTREAM, track: '[gone]' });
  await cleanWorktree(fakeMachine({ exec: gone.exec }), repo, { slug: SLUG }, CLEAN_BRANCH);
  assert.deepEqual(gone.calls.slice(3), [...MERGE_CHECK, ['worktree', 'remove', '--', path], ['branch', '-d', '--', CLEAN_BRANCH]], 'checked against HEAD, never the gone ref');
});

test('an upstream git reads [gone] with the branch not in HEAD refuses with unmerged and HEAD as its target, removing nothing (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const gone = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], { 'merge-base --is-ancestor': '' }, { upstream: GONE_UPSTREAM, track: '[gone]' });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: gone.exec }), repo, { slug: SLUG }, CLEAN_BRANCH), { refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD' } });
  assert.equal(gone.calls.some((c) => c[1] === 'remove' || c[0] === 'branch'), false);
});

const PR = 'https://github.com/acme/app/pull/58';
const OPEN_PR = 'https://github.com/acme/app/pull/59';
const CLOSED_PR = 'https://github.com/acme/app/pull/57';
const TIP = '0123456'; // what cleanGit's rev-parse --verify answers for a branch it knows
const mergedPr = (url = PR): TaskPr => ({ url, state: 'merged' });

// cleanGit's exec with gh in front (#660): `gh pr view <url>` answers heads[url] as a MERGED PR at that head; any other url fails as gh does.
// Every gh argv is recorded.
function withGh(git: Exec, heads: Record<string, string>): { exec: Exec; gh: string[][] } {
  const gh: string[][] = [];
  const exec: Exec = async (file, args, opts) => {
    if (file !== 'gh') return git(file, args, opts);
    gh.push(args);
    const head = heads[args[2] ?? ''];
    if (head === undefined) throw Object.assign(new Error('Command failed: gh pr view'), { stderr: 'GraphQL: Could not resolve to a PullRequest\n', code: 1 });
    return { stdout: JSON.stringify({ state: 'MERGED', headRefOid: head }) };
  };
  return { exec, gh };
}

// A squash-merged branch as git sees it: never an ancestor of HEAD; gh answers `heads`
function squashed(repo: string, path: string, heads: Record<string, string>): { exec: Exec; calls: string[][]; gh: string[][] } {
  const git = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], { 'merge-base --is-ancestor': '' });
  const { exec, gh } = withGh(git.exec, heads);
  return { exec, calls: git.calls, gh };
}

test('a squashed branch whose tip is the head its merged PR merged goes with update-ref -d at that tip after its worktree, the PR read once through gh (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const f = squashed(repo, path, { [PR]: TIP });
  await cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr()] });
  assert.deepEqual(f.gh, [['pr', 'view', PR, '--json', 'state,headRefOid']]);
  assert.deepEqual(f.calls.slice(5), [['rev-parse', '--verify', `refs/heads/${CLEAN_BRANCH}`], ['worktree', 'remove', '--', path], ['update-ref', '-d', `refs/heads/${CLEAN_BRANCH}`, TIP]]);
});

test('a squashed branch whose tip moved past its merged PR\'s head (a commit made after the merge) refuses with unmerged and removes nothing (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const f = squashed(repo, path, { [PR]: 'fedcba9' });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr()] }), { refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD' } });
  assert.equal(f.calls.some((c) => c[1] === 'remove' || c[0] === 'branch'), false);
});

test('a PR still open keeps the branch: unmerged, and no gh call at all (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const f = squashed(repo, path, { [PR]: TIP });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr(), { url: OPEN_PR, state: 'open' }] }), { refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD' } });
  assert.deepEqual(f.gh, []);
});

test('a gh read that fails counts as not merged: unmerged, and the PR\'s url with gh\'s words logged at info (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const f = squashed(repo, path, {});
  const lines: string[] = [];
  const log = { info: (line: string): void => { lines.push(line); } };
  await assert.rejects(cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr()], log }), { refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD' } });
  assert.deepEqual(lines, [`mergedByPr ${PR}: GraphQL: Could not resolve to a PullRequest`]);
});

test('a PR closed without a merge beside a merged one neither blocks nor is read: the branch goes at its verified tip (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const f = squashed(repo, path, { [PR]: TIP });
  await cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [{ url: CLOSED_PR, state: 'closed' }, mergedPr()] });
  assert.deepEqual(f.gh.map((args) => args[2]), [PR]);
  assert.deepEqual(f.calls.at(-1), ['update-ref', '-d', `refs/heads/${CLEAN_BRANCH}`, TIP]);
});

test('a PR the record holds as merged that GitHub no longer calls MERGED (reopened since the poll) counts as not merged, logged at info (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const git = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], { 'merge-base --is-ancestor': '' });
  const exec: Exec = async (file, args, opts) => (file === 'gh' ? { stdout: JSON.stringify({ state: 'OPEN', headRefOid: TIP }) } : git.exec(file, args, opts));
  const lines: string[] = [];
  const log = { info: (line: string): void => { lines.push(line); } };
  await assert.rejects(cleanWorktree(fakeMachine({ exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr()], log }), { refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD' } });
  assert.equal(git.calls.some((c) => c[1] === 'remove' || c[0] === 'branch' || c[0] === 'update-ref'), false);
  assert.deepEqual(lines, [`mergedByPr ${PR}: not merged on GitHub`]);
});

test('a live upstream ahead and behind is still the merge target: only [gone] falls back to HEAD (#660)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const live = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], { 'merge-base --is-ancestor': '' }, { upstream: GONE_UPSTREAM, track: '[ahead 1, behind 2]' });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: live.exec }), repo, { slug: SLUG }, CLEAN_BRANCH), { refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: GONE_UPSTREAM } });
  assert.ok(live.calls.some((c) => c.join(' ') === `merge-base --is-ancestor refs/heads/${CLEAN_BRANCH} ${GONE_UPSTREAM}`));
});

test('a task.branch that is neither the name the Hive\'s template renders nor what the listing names is never deleted: it came from a hook', async (t) => {
  const { repo, path } = await cleanRepo(t, false);
  const forged = cleanGit(repo, porcelain(repo, []), ['release']);
  await cleanWorktree(fakeMachine({ exec: forged.exec }), repo, { slug: SLUG, branch: 'release' }, CLEAN_BRANCH);
  assert.deepEqual(forged.calls, [['worktree', 'list', '--porcelain']], 'not listed, not ours: only the listing runs');
  const listedWins = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH, 'release']);
  await cleanWorktree(fakeMachine({ exec: listedWins.exec }), repo, { slug: SLUG, branch: 'release' }, CLEAN_BRANCH);
  assert.deepEqual(listedWins.calls.at(-1), ['branch', '-d', '--', CLEAN_BRANCH], 'the branch the worktree is on, not the one the task says');
});

test('all or nothing (#182): a worktree with changes is refused before anything is removed, and the reason lists git\'s status lines', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const dirty = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], {}, { status: ' M src/login.ts\n?? notes.md\n' });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: dirty.exec }), repo, { slug: SLUG }, CLEAN_BRANCH), {
    message: `${path} has changes that are not committed:\n M src/login.ts\n?? notes.md`,
    refusal: { reason: 'dirty', path, files: ' M src/login.ts\n?? notes.md' }, // #660: the route answers the code, the UI words it
  });
  assert.deepEqual(dirty.calls, [
    ['worktree', 'list', '--porcelain'], ['rev-parse', '--verify', '--quiet', `refs/heads/${CLEAN_BRANCH}`], ['status', '--porcelain'],
  ], 'nothing removed, nothing deleted');
});

test('all or nothing (#182): a branch not merged into HEAD, or into its upstream when it has one (git branch -d\'s rule), is refused before the worktree is removed', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const listed = porcelain(repo, [[path, CLEAN_BRANCH]]);
  const intoHead = cleanGit(repo, listed, [CLEAN_BRANCH], { 'merge-base --is-ancestor': '' }); // exit 1: not an ancestor
  await assert.rejects(cleanWorktree(fakeMachine({ exec: intoHead.exec }), repo, { slug: SLUG }, CLEAN_BRANCH), {
    message: `the branch '${CLEAN_BRANCH}' is not fully merged into HEAD`,
    refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD' },
  });
  assert.deepEqual(intoHead.calls.slice(-2), MERGE_CHECK);
  assert.equal(intoHead.calls.some((c) => c[1] === 'remove' || c[0] === 'branch'), false, 'the worktree and the branch both stay');
  const upstream = 'refs/remotes/origin/hive/58-clear-worktree';
  const intoUpstream = cleanGit(repo, listed, [CLEAN_BRANCH], { 'merge-base --is-ancestor': '' }, { upstream });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: intoUpstream.exec }), repo, { slug: SLUG }, CLEAN_BRANCH), {
    message: `the branch '${CLEAN_BRANCH}' is not fully merged into ${upstream}`,
    refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: upstream },
  });
  assert.deepEqual(intoUpstream.calls.at(-1), ['merge-base', '--is-ancestor', `refs/heads/${CLEAN_BRANCH}`, upstream], 'the upstream, not HEAD');
});

test('a task a Restart moved to <branch>-r<n> is trusted like the template\'s own branch: not listed, the variant goes; the forced removal falls back to it too (#283)', async (t) => {
  const { repo } = await cleanRepo(t, false);
  const variant = `${CLEAN_BRANCH}-r2`;
  const clean = cleanGit(repo, porcelain(repo, []), [variant]);
  await cleanWorktree(fakeMachine({ exec: clean.exec }), repo, { slug: SLUG, branch: variant }, CLEAN_BRANCH);
  assert.deepEqual(clean.calls.at(-1), ['branch', '-d', '--', variant]);
  const { repo: other, promptsDir } = await repoWith(t);
  const { exec, calls } = fakeExec({ listing: listing(other, worktreePath(other, 'hive-7-fix-2')) });
  await removeWorktree(fakeMachine({ exec }), other, { slug: 'hive-7-fix', branch: `${BRANCH}-r2` }, BRANCH, promptsDir);
  assert.deepEqual(calls.at(-1)?.slice(3), ['branch', '-D', '--', `${BRANCH}-r2`]);
});

test('cleanWorktree calls beforeRemove after both refusal checks and before the remove, with the path and whether it is there; its rejection removes neither the worktree nor the branch (#654)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const ok = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH]);
  const seen: [string, boolean, number][] = [];
  await cleanWorktree(fakeMachine({ exec: ok.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, async (at, present) => { seen.push([at, present, ok.calls.length]); });
  assert.deepEqual(seen, [[path, true, 5]], 'after the listing, the branch check, the status and the merge check');
  assert.deepEqual(ok.calls.slice(5), [['worktree', 'remove', '--', path], ['branch', '-d', '--', CLEAN_BRANCH]]);
  const failing = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH]);
  const teardown = async (): Promise<void> => { throw new Error('teardown failed at line 1 (RUN down): exit 1'); };
  await assert.rejects(cleanWorktree(fakeMachine({ exec: failing.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, teardown), { message: 'teardown failed at line 1 (RUN down): exit 1' });
  assert.equal(failing.calls.some((c) => c[1] === 'remove' || c[0] === 'branch'), false, 'all or nothing (#182)');
});

test('a refusal check that fails never calls beforeRemove; a listed worktree whose folder is gone calls it with present false (#654)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const called: boolean[] = [];
  const dirty = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], {}, { status: '?? notes.md\n' });
  await assert.rejects(cleanWorktree(fakeMachine({ exec: dirty.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, async (_at, present) => { called.push(present); }));
  assert.deepEqual([...called], [], 'refused by git\'s check: the teardown never ran');
  const gone = await cleanRepo(t, false);
  const pruned = cleanGit(gone.repo, porcelain(gone.repo, [[gone.path, CLEAN_BRANCH]]), [CLEAN_BRANCH]);
  await cleanWorktree(fakeMachine({ exec: pruned.exec }), gone.repo, { slug: SLUG }, CLEAN_BRANCH, async (_at, present) => { called.push(present); });
  assert.deepEqual(called, [false]);
});
