import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutPreview, deliverDecomposition, type DeliverTarget, deliveryRefusal, fileCheckout, githubDeliveryWords, hiveDeliveryWords, NoGitlabAccountError, OffGithubError, readDelivery, sourceDeliveryWords } from '../src/decomposition-deliver.js';
import type { GitlabApi } from '../src/gitlab/api.js';
import type { GitlabAccess } from '../src/gitlab/merge-requests.js';
import { fakeGitlabApi } from './fake-gitlab.js';
import { CREATE_PULL_REQUEST, OPEN_PULL_REQUEST } from '../src/sources/github-queries.js';
import type { Exec } from '../src/types.js';
import { fakeMachine } from './fake-machine.js';
import { fakeGqlJson } from './fakes.js';

// Where a decomposition's file lives and its delivery (#936): its checkout, then the file committed when dirty (that path only), the
// checkout's branch pushed, one PR in the file's repository recorded as pr; skipped once recorded.

const FILE = '/docs-repo/agent/specs/2026-10-11-site-decomposition.md';
const PATH = 'agent/specs/2026-10-11-site-decomposition.md';

// git as the checkout read meets it: `answers` by subcommand; a missing one throws, as git does outside a checkout
// `ignore` is check-ignore's exit code: 0 ignored, 1 not (the default), else a failure. Like git 2.50, check-ignore refuses --literal-pathspecs
function checkoutGit(answers: Partial<Record<'rev-parse' | 'get-url' | 'branch', string>>, ignore = 1, platform: NodeJS.Platform = 'linux') {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('check-ignore')) {
      if (args.includes('--literal-pathspecs')) throw Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: pathspec magic not supported by this command: \'literal\'\n' });
      if (ignore === 0) return { stdout: '' };
      throw Object.assign(new Error('Command failed'), { code: ignore, stderr: ignore === 1 ? '' : 'fatal: bad\n' });
    }
    const key = args.includes('rev-parse') ? 'rev-parse' : args.includes('get-url') ? 'get-url' : 'branch';
    const answer = answers[key];
    if (answer === undefined) throw Object.assign(new Error('Command failed'), { stderr: 'fatal: not a git repository\n' });
    return { stdout: `${answer}\n` };
  };
  return { calls, machine: fakeMachine({ exec, info: { platform } }) };
}
const FULL = { 'rev-parse': '/docs-repo', 'get-url': 'git@github.com:acme/docs.git', branch: 'hive/7-site' };
const NO_GITLAB: GitlabAccess = async () => undefined;
const onGitlab = (api: GitlabApi): GitlabAccess => async (host) => (host === 'gitlab.com' ? api : undefined);

test('fileCheckout reads the toplevel from the file\'s folder, then that checkout\'s origin and branch; the path is relative to it (#936)', async () => {
  const { calls, machine } = checkoutGit(FULL);
  assert.deepEqual(await fileCheckout(machine, FILE, []), { toplevel: '/docs-repo', host: 'github.com', repository: 'acme/docs', branch: 'hive/7-site', path: PATH, ignored: false });
  assert.deepEqual(calls, [
    ['git', '-C', '/docs-repo/agent/specs', 'rev-parse', '--show-toplevel'],
    ['git', '-C', '/docs-repo', 'remote', 'get-url', 'origin'],
    ['git', '-C', '/docs-repo', 'branch', '--show-current'],
    ['git', '-C', '/docs-repo', 'check-ignore', '-q', '--', PATH],
  ]);
});

test('check-ignore runs without --literal-pathspecs, which it refuses: a file with glob characters still reads (#544)', async () => {
  const { machine } = checkoutGit(FULL);
  assert.equal((await fileCheckout(machine, '/docs-repo/agent/specs/[a]*?.md', [])).ignored, false);
});

test('fileCheckout marks a file git ignores (exit 0), and a check-ignore failure other than exit 1 is an error (#936)', async () => {
  assert.equal((await fileCheckout(checkoutGit(FULL, 0).machine, FILE, [])).ignored, true);
  await assert.rejects(fileCheckout(checkoutGit(FULL, 128).machine, FILE, []), { message: 'fatal: bad' });
});

test('fileCheckout refuses a file in no checkout, a checkout off GitHub and a detached HEAD, with fixed words (#936)', async () => {
  await assert.rejects(fileCheckout(checkoutGit({}).machine, FILE, []), { message: 'the decomposition file is in no git checkout' });
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, 'get-url': 'https://code.example.org/acme/docs.git' }).machine, FILE, []), { message: 'the decomposition file\'s checkout has no GitHub or GitLab origin' });
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, branch: '' }).machine, FILE, []), { message: 'the decomposition file\'s checkout is on no branch: nothing to push' });
});

const TARGET: DeliverTarget = {
  checkout: { toplevel: '/docs-repo', host: 'github.com', repository: 'acme/docs', branch: 'hive/7-site', path: PATH, ignored: false }, repositoryId: 'RD', base: 'main',
  ...githubDeliveryWords('acme/site', 7, 'github'),
};

// git as the delivery meets it: the file dirty or clean; `failOn` names the git command that fails with stderr
function deliverGit(dirty: boolean, failOn?: string) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (failOn !== undefined && args.includes(failOn)) throw Object.assign(new Error('Command failed: git'), { stderr: 'rejected: non-fast-forward\n' });
    return { stdout: args.includes('--porcelain') && dirty ? `?? ${PATH}\n` : '' };
  };
  return { calls, exec };
}
const github = () => fakeGqlJson((query) => (query === CREATE_PULL_REQUEST ? { createPullRequest: { pullRequest: { number: 300, url: 'https://github.com/acme/docs/pull/300' } } } : {}));
function recorder(): { recorded: [string, number][]; record(id: string, number: number): Promise<void> } {
  const recorded: [string, number][] = [];
  return { recorded, record: async (id, number) => { recorded.push([id, number]); } };
}

test('the PR\'s GraphQL takes every value as a variable (#936)', () => {
  assert.match(CREATE_PULL_REQUEST, /createPullRequest\(input: \{ repositoryId: \$repositoryId, baseRefName: \$baseRefName, headRefName: \$headRefName, title: \$title, body: \$body \}\) \{ pullRequest \{ number url \} \}/);
});

test('a dirty file is committed alone in its checkout, the branch pushed, and one PR to that repository\'s default branch recorded as pr (#936)', async () => {
  const { calls, exec } = deliverGit(true);
  const { calls: asked, gql } = github();
  const { recorded, record } = recorder();
  assert.equal(await deliverDecomposition({ exec, gql, record , gitlabAccess: NO_GITLAB}, TARGET, {}), undefined);
  assert.deepEqual(calls, [
    ['git', '--literal-pathspecs', '-C', '/docs-repo', 'status', '--porcelain', '--', PATH],
    ['git', '--literal-pathspecs', '-C', '/docs-repo', 'add', '--', PATH],
    ['git', '--literal-pathspecs', '-C', '/docs-repo', 'commit', '-m', 'docs: decomposition for #7', '--', PATH],
    ['git', '-C', '/docs-repo', 'push', '-u', 'origin', 'hive/7-site'],
  ]);
  const [pr] = asked.map((c) => c.variables);
  assert.deepEqual({ ...pr, body: undefined }, { repositoryId: 'RD', baseRefName: 'main', headRefName: 'hive/7-site', title: 'docs: decomposition for acme/site#7', body: undefined });
  assert.match(String(pr.body), /acme\/site#7/, 'the root issue named in its own repository');
  assert.deepEqual(recorded, [['pr', 300]]);
});

test('a clean file is not committed again (#936)', async () => {
  const { calls, exec } = deliverGit(false);
  assert.equal(await deliverDecomposition({ exec, gql: github().gql, record: recorder().record , gitlabAccess: NO_GITLAB}, TARGET, {}), undefined);
  assert.deepEqual(calls.map((c) => c.find((a) => ['status', 'push'].includes(a))), ['status', 'push']);
});

test('a recorded pr skips the delivery: nothing committed, pushed or opened (#936)', async () => {
  const { calls, exec } = deliverGit(true);
  const { calls: asked, gql } = github();
  assert.equal(await deliverDecomposition({ exec, gql, record: recorder().record , gitlabAccess: NO_GITLAB}, TARGET, { pr: 300 }), undefined);
  assert.deepEqual([calls, asked], [[], []]);
});

test('a failed push answers git\'s own words and opens no PR (#936)', async () => {
  const { exec } = deliverGit(false, 'push');
  const { calls: asked, gql } = github();
  const { recorded, record } = recorder();
  assert.equal(await deliverDecomposition({ exec, gql, record , gitlabAccess: NO_GITLAB}, TARGET, {}), 'rejected: non-fast-forward');
  assert.deepEqual([asked, recorded], [[], []]);
});

test('git reads the file\'s path literally: a name with glob characters matches only itself (#936)', async () => {
  const { calls, exec } = deliverGit(true);
  const odd = { ...TARGET, checkout: { ...TARGET.checkout, path: 'agent/specs/[a]*?.md' } };
  assert.equal(await deliverDecomposition({ exec, gql: github().gql, record: recorder().record , gitlabAccess: NO_GITLAB}, odd, {}), undefined);
  const withPath = calls.filter((c) => c.includes('agent/specs/[a]*?.md'));
  assert.equal(withPath.length, 3);
  assert.ok(withPath.every((c) => c[1] === '--literal-pathspecs' && c[2] === '-C'));
});

test('credentials in git\'s words are removed before they are answered (#936)', async () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('push')) throw Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access \'https://octo:ghp_secret@github.com/acme/docs.git/\': denied\n' });
    return { stdout: '' };
  };
  const answer = await deliverDecomposition({ exec, gql: github().gql, record: recorder().record , gitlabAccess: NO_GITLAB}, TARGET, {});
  assert.equal(answer, 'fatal: unable to access \'https://github.com/acme/docs.git/\': denied');
});

test('the whole userinfo is removed, even a password with an @ (#936)', async () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('push')) throw Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access \'https://user:p@ss@host/x\': denied\n' });
    return { stdout: '' };
  };
  assert.equal(await deliverDecomposition({ exec, gql: github().gql, record: recorder().record , gitlabAccess: NO_GITLAB}, TARGET, {}), 'fatal: unable to access \'https://host/x\': denied');
});

// GitHub refuses a second PR for the same head: the open one is found and recorded, else the refusal is answered
function refusingGithub(open: number | undefined, headRepository = 'acme/docs') {
  return fakeGqlJson((query) => {
    if (query === CREATE_PULL_REQUEST) throw new Error('A pull request already exists for acme:hive/7-site.');
    if (query === OPEN_PULL_REQUEST) return { repository: { pullRequests: { nodes: open === undefined ? [] : [{ number: open, headRepository: { nameWithOwner: headRepository } }] } } };
    return {};
  });
}

test('when GitHub refuses the PR and one is open for that head and base, it is recorded as pr and the delivery goes on (#936)', async () => {
  const { calls, gql } = refusingGithub(299);
  const { recorded, record } = recorder();
  assert.equal(await deliverDecomposition({ exec: deliverGit(false).exec, gql, record , gitlabAccess: NO_GITLAB}, TARGET, {}), undefined);
  assert.deepEqual(recorded, [['pr', 299]]);
  assert.deepEqual(calls.find((c) => c.query === OPEN_PULL_REQUEST)?.variables, { owner: 'acme', name: 'docs', head: 'hive/7-site', base: 'main' });
});

test('a fork\'s open PR of the same branch name is not adopted: the head must be the checkout\'s own repository (#936)', async () => {
  const { recorded, record } = recorder();
  const answer = await deliverDecomposition({ exec: deliverGit(false).exec, gql: refusingGithub(299, 'someone/docs').gql, record , gitlabAccess: NO_GITLAB}, TARGET, {});
  assert.equal(answer, 'A pull request already exists for acme:hive/7-site.');
  assert.deepEqual(recorded, []);
});

test('when GitHub refuses the PR and none is open, the original error is answered and nothing is recorded (#936)', async () => {
  const { recorded, record } = recorder();
  assert.equal(await deliverDecomposition({ exec: deliverGit(false).exec, gql: refusingGithub(undefined).gql, record , gitlabAccess: NO_GITLAB}, TARGET, {}), 'A pull request already exists for acme:hive/7-site.');
  assert.deepEqual(recorded, []);
});

test('deliveryRefusal: the default branch, a file that is not .md and a recorded pr; an ignored file is never refused, nothing of it is pushed (#936, #741)', () => {
  const checkout = TARGET.checkout;
  assert.equal(deliveryRefusal(checkout, 'main', {}), undefined);
  assert.match(String(deliveryRefusal({ ...checkout, branch: 'main' }, 'main', {})), /default branch/);
  assert.match(String(deliveryRefusal({ ...checkout, path: 'agent/notes.txt' }, 'main', {})), /\.md/);
  assert.equal(deliveryRefusal({ ...checkout, branch: 'main' }, 'main', { pr: 3 }), undefined, 'delivered already: nothing will be pushed');
  const ignored = { ...checkout, ignored: true };
  assert.equal(deliveryRefusal(ignored, 'main', {}), undefined);
  assert.equal(deliveryRefusal({ ...ignored, branch: 'main' }, 'main', {}), undefined, 'the file stays local: the branch does not matter');
  assert.equal(deliveryRefusal({ ...ignored, path: 'agent/notes.txt' }, 'main', {}), undefined, 'and neither does the extension');
});

test('fileCheckout on a win32 machine reads the toplevel from the file\'s folder and answers its path in its checkout with / only, on every OS (#641, #929)', async () => {
  const { calls, machine } = checkoutGit({ ...FULL, 'rev-parse': 'C:\\docs-repo' }, 1, 'win32');
  assert.equal((await fileCheckout(machine, 'C:\\docs-repo\\agent\\specs\\x.md', [])).path, 'agent/specs/x.md');
  assert.deepEqual(calls[0], ['git', '-C', 'C:\\docs-repo\\agent\\specs', 'rev-parse', '--show-toplevel']);
});

test('the GitHub write\'s words are today\'s, byte for byte; the hive write\'s name the goal\'s ref and title (#783)', () => {
  assert.deepEqual(githubDeliveryWords('acme/site', 7, 'github'), {
    title: 'docs: decomposition for acme/site#7',
    body: 'The decomposition of acme/site#7. Its issues are on GitHub already; each one\'s `Design:` link opens this file on the default branch once this PR merges.',
    commit: 'docs: decomposition for #7',
  });
  assert.deepEqual(hiveDeliveryWords('HIVE-1', 'Site for XPTO', 'github'), {
    title: 'docs: decomposition for HIVE-1: Site for XPTO',
    body: 'The decomposition of HIVE-1. Its tasks are in the Hive; each one\'s `Design:` link opens this file on the default branch once this PR merges.',
    commit: 'docs: decomposition for HIVE-1: Site for XPTO',
  });
});

test('sourceDeliveryWords names the Jira goal\'s key and title, and says its issues are in Jira (#832)', () => {
  const line = 'docs: decomposition for ABC-1: Site for XPTO';
  assert.deepEqual(sourceDeliveryWords('ABC-1', 'Site for XPTO', 'github'), {
    title: line, commit: line, body: 'The decomposition of ABC-1. Its issues are in Jira already; each one\'s `Design:` link opens this file on the default branch once this PR merges.',
  });
});

test('a delivery commits and opens its PR with the words it is given: the hive\'s (#783)', async () => {
  const { calls, exec } = deliverGit(true);
  const { calls: asked, gql } = github();
  const words = hiveDeliveryWords('HIVE-1', 'Site for XPTO', 'github');
  assert.equal(await deliverDecomposition({ exec, gql, record: recorder().record , gitlabAccess: NO_GITLAB}, { ...TARGET, ...words }, {}), undefined);
  assert.deepEqual(calls[2], ['git', '--literal-pathspecs', '-C', '/docs-repo', 'commit', '-m', words.commit, '--', PATH]);
  assert.deepEqual([asked[0].variables.title, asked[0].variables.body], [words.title, words.body]);
});

test('fileCheckout tells a file the hive can keep local apart: no checkout and an origin off GitHub throw OffGithubError with their words, the second with the path in its checkout; a detached HEAD does not (#783)', async () => {
  const offGithub = (message: string, path?: string) => (err: unknown): boolean => err instanceof OffGithubError && err.message === message && err.path === path;
  await assert.rejects(fileCheckout(checkoutGit({}).machine, FILE, []), offGithub('the decomposition file is in no git checkout'));
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, 'get-url': 'https://code.example.org/acme/docs.git' }).machine, FILE, []), offGithub('the decomposition file\'s checkout has no GitHub or GitLab origin', PATH));
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, branch: '' }).machine, FILE, []), (err: unknown) => !(err instanceof OffGithubError));
});

test('readDelivery answers the checkout and its repository\'s default branch, or the error it met, and never throws (#783)', async () => {
  const { gql } = fakeGqlJson(() => ({ repository: { id: 'RD', defaultBranchRef: { name: 'main' } } }));
  assert.deepEqual(await readDelivery(checkoutGit(FULL).machine, { gql, gitlabHosts: [], gitlabAccess: NO_GITLAB }, FILE), { delivery: { checkout: TARGET.checkout, docs: { id: 'RD', defaultBranch: 'main' } } });
  const none = await readDelivery(checkoutGit({}).machine, { gql, gitlabHosts: [], gitlabAccess: NO_GITLAB }, FILE);
  assert.ok('error' in none && none.error instanceof OffGithubError);
});

test('checkoutPreview: the checkout as the dialog shows it, local when git ignores the file, with the default branch\'s refusal (#783)', () => {
  const delivery = { checkout: TARGET.checkout, docs: { id: 'RD', defaultBranch: 'main' } };
  assert.deepEqual(checkoutPreview(delivery, {}), { delivery: { repository: 'acme/docs', branch: 'hive/7-site', path: PATH } });
  assert.equal(checkoutPreview({ ...delivery, checkout: { ...TARGET.checkout, branch: 'main' } }, {}).deliveryRefusal, 'the decomposition file\'s checkout is on acme/docs\'s default branch (main): the Hive never pushes it');
  assert.deepEqual(checkoutPreview({ ...delivery, checkout: { ...TARGET.checkout, ignored: true } }, {}), { delivery: { repository: 'acme/docs', branch: 'hive/7-site', path: PATH, local: true } });
});

const GL_CHECKOUT = { ...TARGET.checkout, host: 'gitlab.com' };
const GL_TARGET: DeliverTarget = { ...TARGET, checkout: GL_CHECKOUT, repositoryId: '42', ...githubDeliveryWords('acme/site', 7, 'gitlab') };
const MR_ROUTE = 'projects/acme%2Fdocs/merge_requests';
const MR = { iid: 12, web_url: 'https://gitlab.com/acme/docs/-/merge_requests/12' };
const NO_ACCOUNT = 'no GitLab account for gitlab.com: connect one in Settings › Accounts';

test('fileCheckout reads a GitLab origin\'s host and full project path, gitlab.com always and a self-hosted host only when listed (#1053)', async () => {
  const gitlab = await fileCheckout(checkoutGit({ ...FULL, 'get-url': 'git@gitlab.com:acme/group/docs.git' }).machine, FILE, []);
  assert.deepEqual([gitlab.host, gitlab.repository], ['gitlab.com', 'acme/group/docs']);
  const own = checkoutGit({ ...FULL, 'get-url': 'https://git.example.com/acme/docs.git' }).machine;
  assert.equal((await fileCheckout(own, FILE, ['git.example.com'])).host, 'git.example.com');
  await assert.rejects(fileCheckout(own, FILE, []), (err: unknown) => err instanceof OffGithubError && err.message === 'the decomposition file\'s checkout has no GitHub or GitLab origin');
});

test('readDelivery reads a GitLab checkout\'s project through its host\'s account; with no account it answers NoGitlabAccountError naming the host, not OffGithubError (#1053)', async () => {
  const { gql, calls } = fakeGqlJson(() => ({}));
  const { api } = fakeGitlabApi({ 'GET projects/acme%2Fdocs': { id: 42, default_branch: 'main' } });
  const machine = checkoutGit({ ...FULL, 'get-url': 'git@gitlab.com:acme/docs.git' }).machine;
  assert.deepEqual(await readDelivery(machine, { gql, gitlabHosts: [], gitlabAccess: onGitlab(api) }, FILE), { delivery: { checkout: GL_CHECKOUT, docs: { id: '42', defaultBranch: 'main' } } });
  assert.deepEqual(calls, [], 'GitHub is never asked about a GitLab project');
  const none = await readDelivery(machine, { gql, gitlabHosts: [], gitlabAccess: NO_GITLAB }, FILE);
  assert.ok('error' in none && none.error instanceof NoGitlabAccountError && !(none.error instanceof OffGithubError));
  assert.deepEqual([(none.error as NoGitlabAccountError).host, (none.error as Error).message], ['gitlab.com', NO_ACCOUNT]);
});

test('a GitLab checkout is pushed, then one MR to the default branch opened through the host\'s account and its iid recorded as pr; GitHub is never called (#1053)', async () => {
  const { calls, exec } = deliverGit(true);
  const { calls: asked, gql } = github();
  const gitlab = fakeGitlabApi({ [`POST ${MR_ROUTE}`]: MR });
  const { recorded, record } = recorder();
  assert.equal(await deliverDecomposition({ exec, gql, record, gitlabAccess: onGitlab(gitlab.api) }, GL_TARGET, {}), undefined);
  assert.deepEqual(calls.at(-1), ['git', '-C', '/docs-repo', 'push', '-u', 'origin', 'hive/7-site']);
  assert.deepEqual(gitlab.calls, [{ method: 'POST', path: MR_ROUTE, body: { source_branch: 'hive/7-site', target_branch: 'main', title: 'docs: decomposition for acme/site#7', description: GL_TARGET.body } }]);
  assert.deepEqual([asked, recorded], [[], [['pr', 12]]]);
});

test('when GitLab refuses the MR the project\'s own open one is recorded; with no account the delivery answers the refusal and records nothing (#1053)', async () => {
  const gitlab = fakeGitlabApi({
    [`POST ${MR_ROUTE}`]: new Error('gitlab api: HTTP 409'),
    'GET projects/acme%2Fdocs': { id: 42, default_branch: 'main' },
    [`GET ${MR_ROUTE}?state=opened&source_branch=hive%2F7-site&target_branch=main`]: [{ iid: 11, source_project_id: 42, web_url: 'https://gitlab.com/acme/docs/-/merge_requests/11' }],
  });
  const adopted = recorder();
  assert.equal(await deliverDecomposition({ exec: deliverGit(false).exec, gql: github().gql, record: adopted.record, gitlabAccess: onGitlab(gitlab.api) }, GL_TARGET, {}), undefined);
  assert.deepEqual(adopted.recorded, [['pr', 11]]);
  const none = recorder();
  assert.equal(await deliverDecomposition({ exec: deliverGit(false).exec, gql: github().gql, record: none.record, gitlabAccess: NO_GITLAB }, GL_TARGET, {}), NO_ACCOUNT);
  assert.deepEqual(none.recorded, []);
});

test('a GitLab checkout on its default branch is refused with the present words, the project\'s path as the repository (#1053)', () => {
  assert.equal(deliveryRefusal({ ...GL_CHECKOUT, branch: 'main' }, 'main', {}), 'the decomposition file\'s checkout is on acme/docs\'s default branch (main): the Hive never pushes it');
});

test('on GitLab the body says merge request and links the GitHub goal in full; the title and the commit stay; GitHub\'s words are unchanged (#1053)', () => {
  const tail = 'each one\'s `Design:` link opens this file on the default branch once this merge request merges.';
  assert.deepEqual(githubDeliveryWords('acme/site', 7, 'gitlab'), {
    title: 'docs: decomposition for acme/site#7',
    body: `The decomposition of https://github.com/acme/site/issues/7. Its issues are on GitHub already; ${tail}`,
    commit: 'docs: decomposition for #7',
  });
  assert.equal(hiveDeliveryWords('acme/site#7', 'Site for XPTO', 'gitlab', 'https://github.com/acme/site/issues/7').body, `The decomposition of https://github.com/acme/site/issues/7. Its tasks are in the Hive; ${tail}`);
  assert.equal(hiveDeliveryWords('HIVE-1', 'Site for XPTO', 'gitlab').body, `The decomposition of HIVE-1. Its tasks are in the Hive; ${tail}`);
  assert.equal(hiveDeliveryWords('acme/site#7', 'Site for XPTO', 'github', 'https://github.com/acme/site/issues/7').body, 'The decomposition of acme/site#7. Its tasks are in the Hive; each one\'s `Design:` link opens this file on the default branch once this PR merges.');
  assert.equal(sourceDeliveryWords('ABC-1', 'Site for XPTO', 'gitlab').body, `The decomposition of ABC-1. Its issues are in Jira already; ${tail}`);
});
