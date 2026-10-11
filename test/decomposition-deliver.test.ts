import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverDecomposition, type DeliverTarget, fileCheckout } from '../src/decomposition-deliver.js';
import { CREATE_PULL_REQUEST } from '../src/sources/github-queries.js';
import type { Exec } from '../src/types.js';
import { fakeGqlJson } from './fakes.js';

// Where a decomposition's file lives and its delivery (#936): its checkout, then the file committed when dirty (that path only), the
// checkout's branch pushed, one PR in the file's repository recorded as pr; skipped once recorded.

const FILE = '/docs-repo/agent/specs/2026-10-11-site-decomposition.md';
const PATH = 'agent/specs/2026-10-11-site-decomposition.md';

// git as the checkout read meets it: `answers` by subcommand; a missing one throws, as git does outside a checkout
function checkoutGit(answers: Partial<Record<'rev-parse' | 'get-url' | 'branch', string>>) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
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
  assert.deepEqual(await fileCheckout(exec, FILE), { toplevel: '/docs-repo', repository: 'acme/docs', branch: 'hive/7-site', path: PATH });
  assert.deepEqual(calls, [
    ['git', '-C', '/docs-repo/agent/specs', 'rev-parse', '--show-toplevel'],
    ['git', '-C', '/docs-repo', 'remote', 'get-url', 'origin'],
    ['git', '-C', '/docs-repo', 'branch', '--show-current'],
  ]);
});

test('fileCheckout refuses a file in no checkout, a checkout off GitHub and a detached HEAD, with fixed words (#936)', async () => {
  await assert.rejects(fileCheckout(checkoutGit({}).exec, FILE), { message: 'the decomposition file is in no git checkout' });
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, 'get-url': 'https://gitlab.com/acme/docs.git' }).exec, FILE), { message: 'the decomposition file\'s checkout has no GitHub origin' });
  await assert.rejects(fileCheckout(checkoutGit({ ...FULL, branch: '' }).exec, FILE), { message: 'the decomposition file\'s checkout is on no branch: nothing to push' });
});

const TARGET: DeliverTarget = {
  checkout: { toplevel: '/docs-repo', repository: 'acme/docs', branch: 'hive/7-site', path: PATH }, repositoryId: 'RD', base: 'main', root: 7, goal: 'acme/site',
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
    ['git', '-C', '/docs-repo', 'status', '--porcelain', '--', PATH],
    ['git', '-C', '/docs-repo', 'add', '--', PATH],
    ['git', '-C', '/docs-repo', 'commit', '-m', 'docs: decomposition for #7', '--', PATH],
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
  assert.deepEqual(calls.map((c) => c[3]), ['status', 'push']);
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
