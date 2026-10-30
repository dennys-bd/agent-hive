import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverDecomposition, type DeliverTarget, deliveryRefusal, fileCheckout } from '../src/decomposition-deliver.js';
import { CREATE_PULL_REQUEST, OPEN_PULL_REQUEST } from '../src/sources/github-queries.js';
import type { Exec } from '../src/types.js';
import { fakeGqlJson } from './fakes.js';

// Where a decomposition's file lives and its delivery (#936): its checkout, then the file committed when dirty (that path only), the
// checkout's branch pushed, one PR in the file's repository recorded as pr; skipped once recorded.

const FILE = '/docs-repo/agent/specs/2026-10-11-site-decomposition.md';
const PATH = 'agent/specs/2026-10-11-site-decomposition.md';

// git as the checkout read meets it: `answers` by subcommand; a missing one throws, as git does outside a checkout
// `ignore` is check-ignore's exit code: 0 ignored, 1 not (the default), else a failure. Like git 2.50, check-ignore refuses --literal-pathspecs
function checkoutGit(answers: Partial<Record<'rev-parse' | 'get-url' | 'branch', string>>, ignore = 1) {
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
  return { calls, exec };
}
const FULL = { 'rev-parse': '/docs-repo', 'get-url': 'git@github.com:acme/docs.git', branch: 'hive/7-site' };

test('fileCheckout reads the toplevel from the file\'s folder, then that checkout\'s origin and branch; the path is relative to it (#936)', async () => {
  const { calls, exec } = checkoutGit(FULL);
  assert.deepEqual(await fileCheckout(exec, FILE), { toplevel: '/docs-repo', repository: 'acme/docs', branch: 'hive/7-site', path: PATH, ignored: false });
  assert.deepEqual(calls, [
    ['git', '-C', '/docs-repo/agent/specs', 'rev-parse', '--show-toplevel'],
    ['git', '-C', '/docs-repo', 'remote', 'get-url', 'origin'],
    ['git', '-C', '/docs-repo', 'branch', '--show-current'],
    ['git', '-C', '/docs-repo', 'check-ignore', '-q', '--', PATH],
  ]);
});

test('check-ignore runs without --literal-pathspecs, which it refuses: a file with glob characters still reads (#544)', async () => {
  const { exec } = checkoutGit(FULL);
  assert.equal((await fileCheckout(exec, '/docs-repo/agent/specs/[a]*?.md')).ignored, false);
});

test('fileCheckout marks a file git ignores (exit 0), and a check-ignore failure other than exit 1 is an error (#936)', async () => {
  assert.equal((await fileCheckout(checkoutGit(FULL, 0).exec, FILE)).ignored, true);
  await assert.rejects(fileCheckout(checkoutGit(FULL, 128).exec, FILE), { message: 'fatal: bad' });
});

test('fileCheckout refuses a file in no checkout, a checkout off GitHub and a detached HEAD, with fixed words (#936)', async () => {
  await assert.rejects(fileCheckout(checkoutGit({}).exec, FILE), { message: 'the decomposition file is in no git checkout' });
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, 'get-url': 'https://gitlab.com/acme/docs.git' }).exec, FILE), { message: 'the decomposition file\'s checkout has no GitHub origin' });
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, branch: '' }).exec, FILE), { message: 'the decomposition file\'s checkout is on no branch: nothing to push' });
});

const TARGET: DeliverTarget = {
  checkout: { toplevel: '/docs-repo', repository: 'acme/docs', branch: 'hive/7-site', path: PATH, ignored: false }, repositoryId: 'RD', base: 'main', root: 7, goal: 'acme/site',
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
  assert.equal(await deliverDecomposition({ exec, gql, record }, TARGET, {}), undefined);
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
  assert.equal(await deliverDecomposition({ exec, gql: github().gql, record: recorder().record }, TARGET, {}), undefined);
  assert.deepEqual(calls.map((c) => c.find((a) => ['status', 'push'].includes(a))), ['status', 'push']);
});

test('a recorded pr skips the delivery: nothing committed, pushed or opened (#936)', async () => {
  const { calls, exec } = deliverGit(true);
  const { calls: asked, gql } = github();
  assert.equal(await deliverDecomposition({ exec, gql, record: recorder().record }, TARGET, { pr: 300 }), undefined);
  assert.deepEqual([calls, asked], [[], []]);
});

test('a failed push answers git\'s own words and opens no PR (#936)', async () => {
  const { exec } = deliverGit(false, 'push');
  const { calls: asked, gql } = github();
  const { recorded, record } = recorder();
  assert.equal(await deliverDecomposition({ exec, gql, record }, TARGET, {}), 'rejected: non-fast-forward');
  assert.deepEqual([asked, recorded], [[], []]);
});

test('git reads the file\'s path literally: a name with glob characters matches only itself (#936)', async () => {
  const { calls, exec } = deliverGit(true);
  const odd = { ...TARGET, checkout: { ...TARGET.checkout, path: 'agent/specs/[a]*?.md' } };
  assert.equal(await deliverDecomposition({ exec, gql: github().gql, record: recorder().record }, odd, {}), undefined);
  const withPath = calls.filter((c) => c.includes('agent/specs/[a]*?.md'));
  assert.equal(withPath.length, 3);
  assert.ok(withPath.every((c) => c[1] === '--literal-pathspecs' && c[2] === '-C'));
});

test('credentials in git\'s words are removed before they are answered (#936)', async () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('push')) throw Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access \'https://octo:ghp_secret@github.com/acme/docs.git/\': denied\n' });
    return { stdout: '' };
  };
  const answer = await deliverDecomposition({ exec, gql: github().gql, record: recorder().record }, TARGET, {});
  assert.equal(answer, 'fatal: unable to access \'https://github.com/acme/docs.git/\': denied');
});

test('the whole userinfo is removed, even a password with an @ (#936)', async () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('push')) throw Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access \'https://user:p@ss@host/x\': denied\n' });
    return { stdout: '' };
  };
  assert.equal(await deliverDecomposition({ exec, gql: github().gql, record: recorder().record }, TARGET, {}), 'fatal: unable to access \'https://host/x\': denied');
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
  assert.equal(await deliverDecomposition({ exec: deliverGit(false).exec, gql, record }, TARGET, {}), undefined);
  assert.deepEqual(recorded, [['pr', 299]]);
  assert.deepEqual(calls.find((c) => c.query === OPEN_PULL_REQUEST)?.variables, { owner: 'acme', name: 'docs', head: 'hive/7-site', base: 'main' });
});

test('a fork\'s open PR of the same branch name is not adopted: the head must be the checkout\'s own repository (#936)', async () => {
  const { recorded, record } = recorder();
  const answer = await deliverDecomposition({ exec: deliverGit(false).exec, gql: refusingGithub(299, 'someone/docs').gql, record }, TARGET, {});
  assert.equal(answer, 'A pull request already exists for acme:hive/7-site.');
  assert.deepEqual(recorded, []);
});

test('when GitHub refuses the PR and none is open, the original error is answered and nothing is recorded (#936)', async () => {
  const { recorded, record } = recorder();
  assert.equal(await deliverDecomposition({ exec: deliverGit(false).exec, gql: refusingGithub(undefined).gql, record }, TARGET, {}), 'A pull request already exists for acme:hive/7-site.');
  assert.deepEqual(recorded, []);
});

test('deliveryRefusal: the default branch, a file that is not .md and a recorded pr (#936)', () => {
  const checkout = TARGET.checkout;
  assert.equal(deliveryRefusal(checkout, 'main', {}), undefined);
  assert.match(String(deliveryRefusal({ ...checkout, branch: 'main' }, 'main', {})), /default branch/);
  assert.match(String(deliveryRefusal({ ...checkout, path: 'agent/notes.txt' }, 'main', {})), /\.md/);
  assert.match(String(deliveryRefusal({ ...checkout, ignored: true }, 'main', {})), /ignored by git/);
  assert.equal(deliveryRefusal({ ...checkout, branch: 'main' }, 'main', { pr: 3 }), undefined, 'delivered already: nothing will be pushed');
});
