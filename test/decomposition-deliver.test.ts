import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileCheckout } from '../src/decomposition-deliver.js';
import type { Exec } from '../src/types.js';

// Where a decomposition's file lives (#936): its git checkout, that checkout's GitHub origin and branch, and its path there.

const FILE = '/docs-repo/agent/specs/2026-10-11-site-decomposition.md';

// git as the checkout read meets it: `answers` by subcommand; a missing one throws, as git does outside a checkout
function git(answers: Partial<Record<'rev-parse' | 'get-url' | 'branch', string>>) {
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
  const { calls, exec } = git(FULL);
  assert.deepEqual(await fileCheckout(exec, FILE), { toplevel: '/docs-repo', repository: 'acme/docs', branch: 'hive/7-site', path: 'agent/specs/2026-10-11-site-decomposition.md' });
  assert.deepEqual(calls, [
    ['git', '-C', '/docs-repo/agent/specs', 'rev-parse', '--show-toplevel'],
    ['git', '-C', '/docs-repo', 'remote', 'get-url', 'origin'],
    ['git', '-C', '/docs-repo', 'branch', '--show-current'],
  ]);
});

test('fileCheckout refuses a file in no checkout, a checkout off GitHub and a detached HEAD, with fixed words (#936)', async () => {
  await assert.rejects(fileCheckout(git({}).exec, FILE), { message: 'the decomposition file is in no git checkout' });
  await assert.rejects(fileCheckout(git({ ...FULL, 'get-url': 'https://gitlab.com/acme/docs.git' }).exec, FILE), { message: 'the decomposition file\'s checkout has no GitHub origin' });
  await assert.rejects(fileCheckout(git({ ...FULL, branch: '' }).exec, FILE), { message: 'the decomposition file\'s checkout is on no branch: nothing to push' });
});
