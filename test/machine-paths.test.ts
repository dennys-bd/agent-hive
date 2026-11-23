import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceBase } from '../src/fork.js';
import type { Exec } from '../src/types.js';
import { ensureWorktree } from '../src/worktree.js';
import { fakeMachine } from './fake-machine.js';

// #928: a machine's paths are its own platform's whatever the host: the same calls on a linux and a win32 fake machine, on every lane

interface Side { platform: NodeJS.Platform; repo: string; printed: string; worktree: string }
const SLUG = 'hive-7-fix';
const BRANCH = 'hive/7-fix';
const SIDES: readonly Side[] = [
  { platform: 'linux', repo: '/r', printed: '/r/.hive/worktrees/hive-7-fix', worktree: '/r/.hive/worktrees/hive-7-fix' },
  // git prints C:/… on Windows where the Hive joins C:\… (#640)
  { platform: 'win32', repo: 'C:\\r', printed: 'C:/r/.hive/worktrees/hive-7-fix', worktree: 'C:\\r\\.hive\\worktrees\\hive-7-fix' },
];
const ORIGIN: WorkspaceBase = { remote: 'origin', fork: null };
const ANSWERS: Readonly<Record<string, string>> = { 'symbolic-ref --short': 'origin/main\n', 'refs/remotes/origin/main': 'a1b2c3d\n' };

// ensureWorktree's git, keyed as worktree.test.ts's baseGit keys it: the task's branch does not exist, and `listing` is what worktree list prints
function git(listing = ''): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    const command = args.slice(2);
    if (command[0] === 'worktree' && command[1] === 'list') return { stdout: listing };
    if (command.at(-1) === `refs/heads/${BRANCH}`) throw Object.assign(new Error('not a ref'), { stderr: '' });
    const key = command[0] === 'rev-parse' || command[0] === 'for-each-ref' ? String(command.at(-1)) : command.slice(0, 2).join(' ');
    return { stdout: ANSWERS[key] ?? '' };
  };
  return { exec, calls };
}

for (const side of SIDES) {
  test(`ensureWorktree on a ${side.platform} machine adds the worktree at that machine's path, on any host (#928)`, async () => {
    const { exec, calls } = git();
    const prepared = await ensureWorktree(fakeMachine({ exec, info: { platform: side.platform } }), side.repo, SLUG, BRANCH, ORIGIN, undefined);
    assert.equal(prepared.path, side.worktree);
    assert.deepEqual(calls.find((args) => args[2] === 'worktree' && args[3] === 'add'), ['-C', side.repo, 'worktree', 'add', '-b', BRANCH, '--', side.worktree, 'origin/main']);
  });

  test(`ensureWorktree on a ${side.platform} machine adopts the worktree git lists, probing its disk at that machine's path (#928)`, async () => {
    const accessed: string[] = [];
    const listing = `worktree ${side.repo}\nHEAD 1111\nbranch refs/heads/main\n\nworktree ${side.printed}\nHEAD 2222\nbranch refs/heads/${BRANCH}\n`;
    const machine = fakeMachine({ exec: git(listing).exec, info: { platform: side.platform }, fs: { access: async (path) => { accessed.push(path); } } });
    assert.deepEqual(await ensureWorktree(machine, side.repo, SLUG, BRANCH, ORIGIN, undefined), { path: side.worktree });
    assert.deepEqual(accessed, [side.worktree]);
  });
}
