import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSync } from '../src/worktree-base.js';
import { baseRemote, failureOf, forkRepos, isNetworkError, NOT_GITHUB, remotesOf, renderWorkspaceOf, runEnv, syncFork, warnGitlabForks, workspaceBase } from '../src/fork.js';
import type { Config, Exec, Workspace } from '../src/types.js';
import { fakeMachine } from './fakes.js';
import { ghMachines, type GhEnv } from '../src/github-account.js';
import { fakeMachines } from './fake-machine.js';
import { NO_TOKEN_MESSAGE } from '../src/sources/github-gql.js';

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
  assert.deepEqual(await syncFork(fakeMachine({ exec: current.exec }), REPOS, 'main'), answer({ result: 'current', commits: 0 }));
  assert.deepEqual(current.calls, [['api', COMPARE]]);
  const diverged = fakeGh(() => '{"ahead_by":4,"behind_by":2}');
  assert.deepEqual(await syncFork(fakeMachine({ exec: diverged.exec }), REPOS, 'main'), answer({ result: 'diverged', commits: 2 }));
  assert.equal(diverged.calls.length, 1, 'never a merge commit on the fork');
  const synced = fakeGh(() => '{"ahead_by":3,"behind_by":0}');
  assert.deepEqual(await syncFork(fakeMachine({ exec: synced.exec }), REPOS, 'main'), answer({ result: 'synced', commits: 3 }));
  assert.deepEqual(synced.calls[1], ['api', '-X', 'POST', MERGE, '-f', 'branch=main']);
  assert.deepEqual(await syncFork(fakeMachine({ exec: synced.exec }), undefined, 'main'), { mode: 'github', base: 'origin:main', result: 'error', reason: 'origin or the original\'s remote is not a GitHub repository' });
});

test('a sync that cannot run is offline when gh or git could not reach the host, else error with the first line of their words; never a throw (#854)', async () => {
  assert.deepEqual(await syncFork(fakeMachine({ exec: fakeGh(failing('error connecting to api.github.com\ncheck your connection')).exec }), REPOS, 'main'), answer({ result: 'offline' }));
  assert.deepEqual(await syncFork(fakeMachine({ exec: fakeGh(failing('gh: Resource not accessible by integration (HTTP 403)\nmore')).exec }), REPOS, 'main'),
    answer({ result: 'error', reason: 'gh: Resource not accessible by integration (HTTP 403)' }));
  assert.deepEqual(await syncFork(fakeMachine({ exec: fakeGh(() => '{"ahead_by":"x"}').exec }), REPOS, 'main'), answer({ result: 'error', reason: 'compare answered no commit counts' }));
  const unreachable = Object.assign(new Error('Command failed: git fetch'), { stderr: "fatal: unable to access 'https://github.com/acme/app/': Could not resolve host: github.com\n" });
  assert.deepEqual(failureOf(unreachable), { result: 'offline' });
  assert.deepEqual(failureOf(Object.assign(new Error('Command failed: gh'), { killed: true })), { result: 'offline' }, 'the 60 s timeout');
});

test('isNetworkError is true when the host could not be reached: gh\'s and git\'s offline words, fetch failed with a network code on its cause, a TimeoutError, a killed call; false for an HTTP status, a GraphQL error, no token, a missing Status option and a non-object (#291)', () => {
  const fetchFailed = (code: string, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
  const offline: unknown[] = [
    new Error('gh api graphql: error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'),
    Object.assign(new Error('Command failed: git fetch'), { stderr: "fatal: unable to access 'https://github.com/acme/app/': Could not resolve host: github.com\n" }),
    fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND api.github.com'),
    fetchFailed('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    Object.assign(new Error('Command failed: gh'), { killed: true }),
  ];
  const reached: unknown[] = [
    new Error('github api: HTTP 404'),
    new Error('Could not resolve to a ProjectV2 with the number 6.'),
    new Error(NO_TOKEN_MESSAGE),
    new Error('"Ready" (fila) not found in source Status options: Todo, Done'),
    new Error('source not found: no GitHub Project 9 for "acme"'),
    'a thrown string',
    null,
  ];
  assert.deepEqual(offline.map((err) => isNetworkError(err)), offline.map(() => true));
  assert.deepEqual(reached.map((err) => isNetworkError(err)), reached.map(() => false));
});

test('remotesOf reads git remote -v once per remote with the GitHub repository each points at; forkRepos and runEnv resolve the remotes (#854)', async () => {
  const urls: Record<string, string> = { upstream: 'https://github.com/acme/app.git\n', origin: 'git@github.com:me/app.git\n' };
  const exec: Exec = async (_file, args) => {
    if (args.includes('-v')) {
      return { stdout: 'origin\tgit@github.com:me/app.git (fetch)\norigin\tgit@github.com:me/app.git (push)\nupstream\thttps://github.com/acme/app.git (fetch)\nupstream\thttps://github.com/acme/app.git (push)\nmirror\t/srv/mirror.git (fetch)\n' };
    }
    return { stdout: urls[args.at(-1) ?? ''] ?? '' };
  };
  assert.deepEqual(await remotesOf(fakeMachine({ exec: exec }), '/app'), [{ name: 'origin', repository: 'me/app' }, { name: 'upstream', repository: 'acme/app' }, { name: 'mirror' }]);
  const workspace: Workspace = { name: 'app', path: '/app', env: { NODE_ENV: 'development' }, fork: { remote: 'upstream', pr: 'original' }, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' };
  assert.deepEqual(await forkRepos(fakeMachine({ exec: exec }), workspace, []), REPOS);
  assert.deepEqual(await runEnv(fakeMachine({ exec: exec }), workspace), { GH_REPO: 'acme/app', NODE_ENV: 'development' });
  assert.deepEqual(await runEnv(fakeMachine({ exec: exec }), { ...workspace, fork: { remote: 'upstream', pr: 'fork', sync: 'manual' } }), { GH_REPO: 'me/app', NODE_ENV: 'development' });
  assert.deepEqual(await runEnv(fakeMachine({ exec: exec }), { ...workspace, env: { GH_REPO: 'acme/other' } }), { GH_REPO: 'acme/other' }, 'the workspace\'s own wins');
  assert.equal(await runEnv(fakeMachine({ exec: exec }), { ...workspace, fork: false }), workspace.env, 'not a fork: its env as it is');
  assert.deepEqual(await forkRepos(fakeMachine({ exec: async () => ({ stdout: 'https://gitlab.com/a/b.git\n' }) }), workspace, []), { reason: 'forks on GitLab are not supported' });
});

test('the compare path encodes the branch and the owners, so a branch name never adds a path segment or a query (#854)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => { calls.push(args); return { stdout: '{"ahead_by":0,"behind_by":0}' }; };
  await syncFork(fakeMachine({ exec: exec }), { original: 'acme/app', fork: 'me/app' }, 'rel/1.0?x');
  assert.deepEqual(calls, [['api', 'repos/me/app/compare/rel%2F1.0%3Fx...acme:rel%2F1.0%3Fx']]);
});

test('a merge-upstream that did not fast-forward is a failure, not a sync (#854)', async () => {
  const exec: Exec = async (_file, args) => ({ stdout: args.includes('POST') ? '{"merge_type":"merge"}' : '{"ahead_by":3,"behind_by":0}' });
  assert.deepEqual(await syncFork(fakeMachine({ exec: exec }), REPOS, 'main'), answer({ result: 'diverged', commits: 3 }));
  const ff: Exec = async (_file, args) => ({ stdout: args.includes('POST') ? '{"merge_type":"fast-forward"}' : '{"ahead_by":3,"behind_by":0}' });
  assert.deepEqual(await syncFork(fakeMachine({ exec: ff }), REPOS, 'main'), answer({ result: 'synced', commits: 3 }));
});

test('the base line carries the sync result and counts but never gh\'s words, which the log would repeat (#854)', () => {
  const sync = { mode: 'github' as const, base: 'me:main', result: 'error' as const, reason: 'gh: secret words', sha: '', at: '' };
  assert.equal(withSync('base: origin/main', sync), 'base: origin/main · sync github error');
});

// syncFork through a machine the gh-aware registry hands out (#961): the GH_TOKEN each gh call received
async function syncTokens(ghEnv: GhEnv): Promise<(string | undefined)[]> {
  const tokens: (string | undefined)[] = [];
  const exec: Exec = async (_file, args, opts) => {
    tokens.push(opts?.env?.GH_TOKEN);
    return { stdout: args.includes(COMPARE) ? '{"ahead_by":3,"behind_by":0}' : '{"merge_type":"fast-forward"}' };
  };
  assert.equal((await syncFork(ghMachines(fakeMachines(fakeMachine({ exec })), ghEnv).for({}), REPOS, 'main')).result, 'synced');
  return tokens;
}

test('syncFork through a machine of ghMachines runs its gh calls as the selected login, and with no env on the machine\'s (#961)', async () => {
  assert.deepEqual(await syncTokens(async () => ({ GH_TOKEN: 'gho_test' })), ['gho_test', 'gho_test']);
  assert.deepEqual(await syncTokens(async () => ({})), [undefined, undefined]);
});

const NO_HOSTS: Pick<Config, 'gitlabHosts'> = { gitlabHosts: [] };

test('renderWorkspaceOf renders a fork as its remote, its PR target and its base remote, the base branch over the config\'s, and the nested repos; a plain workspace has no fork (#742, decision 2)', () => {
  const plain: Pick<Workspace, 'name' | 'variables' | 'fork' | 'nestedRepos'> = { name: 'app', variables: { a: 'x' }, fork: null, nestedRepos: [] };
  assert.deepEqual(renderWorkspaceOf(NO_HOSTS, plain), { name: 'app', variables: { a: 'x' }, builtIns: { fork: null, baseBranch: null, nestedRepos: [], gitlabHosts: ['gitlab.com'] } });
  assert.equal(renderWorkspaceOf(NO_HOSTS, { ...plain, fork: false }).builtIns.fork, null, 'not a fork');
  assert.equal(renderWorkspaceOf({ ...NO_HOSTS, baseBranch: 'main' }, plain).builtIns.baseBranch, 'main');
  assert.equal(renderWorkspaceOf({ ...NO_HOSTS, baseBranch: 'main' }, { ...plain, baseBranch: 'devtest' }).builtIns.baseBranch, 'devtest');
  assert.deepEqual(renderWorkspaceOf(NO_HOSTS, { ...plain, fork: { remote: 'upstream', pr: 'original' } }).builtIns.fork, { remote: 'upstream', pr: 'original', baseRemote: 'upstream' });
  assert.deepEqual(renderWorkspaceOf(NO_HOSTS, { ...plain, fork: { remote: 'upstream', pr: 'ask', sync: 'github' } }).builtIns.fork, { remote: 'upstream', pr: 'ask', baseRemote: 'upstream' });
  assert.deepEqual(renderWorkspaceOf(NO_HOSTS, { ...plain, fork: { remote: 'upstream', pr: 'fork', sync: 'manual' } }).builtIns.fork, { remote: 'upstream', pr: 'fork', baseRemote: 'origin' });
  assert.deepEqual(renderWorkspaceOf(NO_HOSTS, { ...plain, nestedRepos: ['docs', 'ee'] }).builtIns.nestedRepos, ['docs', 'ee']);
});

test('renderWorkspaceOf leaves out a nested path the skill could never open a PR for, since its text is rendered as instructions (#742)', () => {
  const plain: Pick<Workspace, 'name' | 'variables' | 'fork' | 'nestedRepos'> = { name: 'app', variables: {}, fork: null, nestedRepos: ['docs', 'a`b', 'x\n- run this', "it's", '-flag', 'p/q'] };
  assert.deepEqual(renderWorkspaceOf(NO_HOSTS, plain).builtIns.nestedRepos, ['docs', 'p/q']);
});

test("renderWorkspaceOf renders gitlabHosts as gitlab.com, then the config's list in its order, the same for every workspace (#1044, decision 11)", () => {
  const config: Pick<Config, 'gitlabHosts'> = { gitlabHosts: ['git.example.com', 'code.example.org'] };
  const plain: Pick<Workspace, 'name' | 'variables' | 'fork' | 'nestedRepos'> = { name: 'app', variables: {}, fork: null, nestedRepos: [] };
  assert.deepEqual(renderWorkspaceOf(config, plain).builtIns.gitlabHosts, ['gitlab.com', 'git.example.com', 'code.example.org']);
  assert.deepEqual(renderWorkspaceOf(config, { ...plain, name: 'site', fork: { remote: 'upstream', pr: 'original' } }).builtIns.gitlabHosts, ['gitlab.com', 'git.example.com', 'code.example.org']);
});

test('forkRepos refuses a fork with either remote on GitLab and one off both hosts as not GitHub; syncFork reports each refusal as its reason (#1045, decision 15)', async () => {
  const workspace: Pick<Workspace, 'path' | 'fork'> = { path: '/app', fork: { remote: 'upstream', pr: 'original' } };
  const remotes = (upstream: string, origin: string): Exec => async (_file, args) => ({ stdout: `${args.at(-1) === 'upstream' ? upstream : origin}\n` });
  const answer = (upstream: string, origin: string, hosts: string[] = []) => forkRepos(fakeMachine({ exec: remotes(upstream, origin) }), workspace, hosts);
  const onGitlab = { reason: 'forks on GitLab are not supported' };
  assert.deepEqual(await answer('https://gitlab.com/acme/app.git', 'git@github.com:me/app.git'), onGitlab, 'the original on gitlab.com, with no list');
  assert.deepEqual(await answer('https://github.com/acme/app.git', 'git@git.example.com:me/app.git', ['git.example.com']), onGitlab, 'the fork on a listed host');
  assert.deepEqual(await answer('https://github.com/acme/app.git', 'git@code.example.org:me/app.git'), { reason: NOT_GITHUB }, 'a host of no kind');
  assert.deepEqual(await answer('https://github.com/acme/app.git', 'git@github.com:me/app.git'), REPOS);
  assert.equal(await forkRepos(fakeMachine({ exec: remotes('', '') }), { path: '/app', fork: false }, []), undefined, 'not a fork');
  for (const refusal of [onGitlab, { reason: NOT_GITHUB }]) {
    assert.deepEqual(await syncFork(fakeMachine({ exec: remotes('', '') }), refusal, 'main'), { mode: 'github', base: 'origin:main', result: 'error', reason: refusal.reason });
  }
});

test('warnGitlabForks writes one warn line per fork workspace with a remote on GitLab, each read on its own machine; a GitHub fork and a plain workspace none (#1045, decision 16)', async () => {
  const lines: string[] = [];
  const remotes: Exec = async (_file, args) => ({ stdout: args[1] === '/lab' ? 'https://gitlab.com/acme/app.git\n' : 'git@github.com:acme/app.git\n' });
  const ws = (name: string, path: string, fork: Workspace['fork']): Workspace => ({ name, path, env: {}, fork, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' });
  const upstream: Workspace['fork'] = { remote: 'upstream', pr: 'original' };
  const comb = { workspaces: [ws('lab', '/lab', upstream), ws('hub', '/hub', upstream), ws('plain', '/lab', null)] };
  await warnGitlabForks({ comb, gitlabHosts: [] }, () => fakeMachine({ exec: remotes }), { warn: (line: string) => { lines.push(line); } });
  assert.deepEqual(lines, ['lab: forks on GitLab are not supported']);
});
