import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSync } from '../src/worktree-base.js';
import { baseRemote, failureOf, forkRepos, remotesOf, runEnv, syncFork, workspaceBase } from '../src/fork.js';
import type { Exec, Workspace } from '../src/types.js';

// A fork workspace (#854): the base remote, the base, the two repositories, the run env, and the GitHub sync, fast-forward only.

const REPOS = { original: 'acme/app', fork: 'me/app' };
const COMPARE = 'repos/me/app/compare/main...acme:main';
const MERGE = 'repos/me/app/merge-upstream';
// gh as syncFork runs it, with its 60 s timeout: every argv recorded, the compare answering `compare`, the merge-upstream nothing
function fakeGh(compare: () => string): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args, opts) => {
    assert.deepEqual([file, opts?.timeout], ['gh', 60_000]);
    calls.push(args);
    return { stdout: args.includes(COMPARE) ? compare() : '{"merge_type":"fast-forward"}' };
  };
  return { exec, calls };
}
const failing = (stderr: string) => (): string => { throw Object.assign(new Error('Command failed: gh api'), { stderr }); };
const answer = (extra: Record<string, unknown>) => ({ mode: 'github', base: 'me:main', ...extra });

test('baseRemote is the original\'s remote with PRs to it or ask, origin with PRs to the fork and for a workspace that is not a fork; workspaceBase puts the workspace\'s base over the general one (#854)', () => {
  assert.equal(baseRemote({ fork: { remote: 'upstream', pr: 'original' } }), 'upstream');
  assert.equal(baseRemote({ fork: { remote: 'up', pr: 'ask', sync: 'github' } }), 'up');
  assert.equal(baseRemote({ fork: { remote: 'upstream', pr: 'fork', sync: 'local' } }), 'origin');
  assert.equal(baseRemote({ fork: false }), 'origin');
  assert.equal(baseRemote({ fork: null }), 'origin');
  const fork = { remote: 'upstream', pr: 'original' as const };
  assert.deepEqual(workspaceBase({ baseBranch: 'main' }, { fork, baseBranch: 'devtest' }), { remote: 'upstream', branch: 'devtest', fork });
  assert.deepEqual(workspaceBase({ baseBranch: 'main' }, { fork: null }), { remote: 'origin', branch: 'main', fork: null });
  assert.deepEqual(workspaceBase({}, undefined), { remote: 'origin', fork: null });
});

test('syncFork compares the fork\'s base with the original\'s: nothing to receive is current, commits only on the fork are diverged with no merge-upstream, else merge-upstream with the branch (#854)', async () => {
  const current = fakeGh(() => '{"ahead_by":0,"behind_by":0}');
  assert.deepEqual(await syncFork(current.exec, REPOS, 'main'), answer({ result: 'current', commits: 0 }));
  assert.deepEqual(current.calls, [['api', COMPARE]]);
  const diverged = fakeGh(() => '{"ahead_by":4,"behind_by":2}');
  assert.deepEqual(await syncFork(diverged.exec, REPOS, 'main'), answer({ result: 'diverged', commits: 2 }));
  assert.equal(diverged.calls.length, 1, 'never a merge commit on the fork');
  const synced = fakeGh(() => '{"ahead_by":3,"behind_by":0}');
  assert.deepEqual(await syncFork(synced.exec, REPOS, 'main'), answer({ result: 'synced', commits: 3 }));
  assert.deepEqual(synced.calls[1], ['api', '-X', 'POST', MERGE, '-f', 'branch=main']);
  assert.deepEqual(await syncFork(synced.exec, undefined, 'main'), { mode: 'github', base: 'origin:main', result: 'error', reason: 'origin or the original\'s remote is not a GitHub repository' });
});

test('a sync that cannot run is offline when gh or git could not reach the host, else error with the first line of their words; never a throw (#854)', async () => {
  assert.deepEqual(await syncFork(fakeGh(failing('error connecting to api.github.com\ncheck your connection')).exec, REPOS, 'main'), answer({ result: 'offline' }));
  assert.deepEqual(await syncFork(fakeGh(failing('gh: Resource not accessible by integration (HTTP 403)\nmore')).exec, REPOS, 'main'),
    answer({ result: 'error', reason: 'gh: Resource not accessible by integration (HTTP 403)' }));
  assert.deepEqual(await syncFork(fakeGh(() => '{"ahead_by":"x"}').exec, REPOS, 'main'), answer({ result: 'error', reason: 'compare answered no commit counts' }));
  const unreachable = Object.assign(new Error('Command failed: git fetch'), { stderr: "fatal: unable to access 'https://github.com/acme/app/': Could not resolve host: github.com\n" });
  assert.deepEqual(failureOf(unreachable), { result: 'offline' });
  assert.deepEqual(failureOf(Object.assign(new Error('Command failed: gh'), { killed: true })), { result: 'offline' }, 'the 60 s timeout');
});

test('remotesOf reads git remote -v once per remote with the GitHub repository each points at; forkRepos and runEnv resolve the remotes (#854)', async () => {
  const urls: Record<string, string> = { upstream: 'https://github.com/acme/app.git\n', origin: 'git@github.com:me/app.git\n' };
  const exec: Exec = async (_file, args) => {
    if (args.includes('-v')) {
      return { stdout: 'origin\tgit@github.com:me/app.git (fetch)\norigin\tgit@github.com:me/app.git (push)\nupstream\thttps://github.com/acme/app.git (fetch)\nupstream\thttps://github.com/acme/app.git (push)\nmirror\t/srv/mirror.git (fetch)\n' };
    }
    return { stdout: urls[args.at(-1) ?? ''] ?? '' };
  };
  assert.deepEqual(await remotesOf(exec, '/app'), [{ name: 'origin', repository: 'me/app' }, { name: 'upstream', repository: 'acme/app' }, { name: 'mirror' }]);
  const workspace: Workspace = { name: 'app', path: '/app', env: { NODE_ENV: 'development' }, fork: { remote: 'upstream', pr: 'original' } };
  assert.deepEqual(await forkRepos(exec, workspace), REPOS);
  assert.deepEqual(await runEnv(exec, workspace), { GH_REPO: 'acme/app', NODE_ENV: 'development' });
  assert.deepEqual(await runEnv(exec, { ...workspace, fork: { remote: 'upstream', pr: 'fork', sync: 'manual' } }), { GH_REPO: 'me/app', NODE_ENV: 'development' });
  assert.deepEqual(await runEnv(exec, { ...workspace, env: { GH_REPO: 'acme/other' } }), { GH_REPO: 'acme/other' }, 'the workspace\'s own wins');
  assert.equal(await runEnv(exec, { ...workspace, fork: false }), workspace.env, 'not a fork: its env as it is');
  assert.equal(await forkRepos(async () => ({ stdout: 'https://gitlab.com/a/b.git\n' }), workspace), undefined);
});

test('the compare path encodes the branch and the owners, so a branch name never adds a path segment or a query (#854)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => { calls.push(args); return { stdout: '{"ahead_by":0,"behind_by":0}' }; };
  await syncFork(exec, { original: 'acme/app', fork: 'me/app' }, 'rel/1.0?x');
  assert.deepEqual(calls, [['api', 'repos/me/app/compare/rel%2F1.0%3Fx...acme:rel%2F1.0%3Fx']]);
});

test('a merge-upstream that did not fast-forward is a failure, not a sync (#854)', async () => {
  const exec: Exec = async (_file, args) => ({ stdout: args.includes('POST') ? '{"merge_type":"merge"}' : '{"ahead_by":3,"behind_by":0}' });
  assert.deepEqual(await syncFork(exec, REPOS, 'main'), answer({ result: 'diverged', commits: 3 }));
  const ff: Exec = async (_file, args) => ({ stdout: args.includes('POST') ? '{"merge_type":"fast-forward"}' : '{"ahead_by":3,"behind_by":0}' });
  assert.deepEqual(await syncFork(ff, REPOS, 'main'), answer({ result: 'synced', commits: 3 }));
});

test('the base line carries the sync result and counts but never gh\'s words, which the log would repeat (#854)', () => {
  const sync = { mode: 'github' as const, base: 'me:main', result: 'error' as const, reason: 'gh: secret words', sha: '', at: '' };
  assert.equal(withSync('base: origin/main', sync), 'base: origin/main · sync github error');
});
