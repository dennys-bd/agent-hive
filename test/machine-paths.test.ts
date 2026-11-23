import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceBase } from '../src/fork.js';
import type { MachineFs, RunProcess } from '../src/machine.js';
import type { Exec, Workspace } from '../src/types.js';
import { excludeFromGit } from '../src/hooks-settings.js';
import { ensureWorktree } from '../src/worktree.js';
import { runSetup } from '../src/worktree-setup.js';
import { fakeMachine, statsOf } from './fake-machine.js';
import { runResult } from './fakes.js';

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

interface StepSide { platform: NodeJS.Platform; main: string; worktree: string; gitDir: string; copied: string; marker: string; foreign: string }
const STEP_SIDES: readonly StepSide[] = [
  { platform: 'linux', main: '/m', worktree: '/r/.hive/worktrees/wt', gitDir: '/r/.git/worktrees/wt', copied: '/r/.hive/worktrees/wt/config/.env', marker: '/r/.git/worktrees/wt/hive-setup-done', foreign: '\\' },
  { platform: 'win32', main: 'C:\\m', worktree: 'C:\\r\\.hive\\worktrees\\wt', gitDir: 'C:/r/.git/worktrees/wt', copied: 'C:\\r\\.hive\\worktrees\\wt\\config\\.env', marker: 'C:\\r\\.git\\worktrees\\wt\\hive-setup-done', foreign: '/' },
];
const missing = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });

for (const side of STEP_SIDES) {
  test(`a setup's COPY and RUN on a ${side.platform} machine reach its fs and run with that machine's paths only, on any host (#928)`, async () => {
    const touched: string[] = [];
    const seen = (path: string): void => { touched.push(path); };
    const exec: Exec = async (_file, args) => {
      assert.deepEqual(args.slice(2), ['rev-parse', '--absolute-git-dir']); // the steps run no git: only gitDirOf asks
      return { stdout: `${side.gitDir}\n` };
    };
    const fs: Partial<MachineFs> = {
      realpath: async (path) => { seen(path); return path; },
      lstat: (async (path: string) => { seen(path); return statsOf('file'); }) as MachineFs['lstat'],
      access: async (path) => { seen(path); throw missing(path); },
      readFile: (async (path: string) => { seen(path); throw missing(path); }) as MachineFs['readFile'],
      cp: async (from, to) => { seen(from); seen(to); },
      writeFile: async (path) => { seen(path); },
      rm: async (path) => { seen(path); },
    };
    const run = async (p: RunProcess) => { seen(p.cwd); return runResult(0); };
    const machine = fakeMachine({ exec, fs, run, info: { platform: side.platform } });
    const workspace: Workspace = { name: 'hive', path: side.main, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)', setup: 'COPY .env config/\nRUN make' };
    assert.equal(await runSetup(machine, workspace, side.worktree, { log: { info: () => undefined }, onStep: () => undefined }), 2);
    assert.ok(touched.includes(side.copied), `the COPY wrote ${side.copied}`);
    assert.ok(touched.includes(side.worktree), 'the RUN ran in the worktree');
    assert.ok(touched.includes(side.marker), `the marker went to ${side.marker}`);
    assert.deepEqual(touched.filter((path) => path.includes(side.foreign)), [], "no path is joined the other platform's way");
  });
}

const EXCLUDE_SIDES = [
  { platform: 'linux', repo: '/r', info: '/r/.git/info', exclude: '/r/.git/info/exclude' },
  { platform: 'win32', repo: 'C:\\r', info: 'C:\\r\\.git\\info', exclude: 'C:\\r\\.git\\info\\exclude' },
] as const;

for (const side of EXCLUDE_SIDES) {
  test(`excludeFromGit on a ${side.platform} machine reads and appends that machine's .git/info/exclude, on any host (#928)`, async () => {
    const touched: string[] = [];
    const machine = fakeMachine({ info: { platform: side.platform }, fs: {
      stat: async (path) => { touched.push(path); return statsOf('folder'); },
      readFile: (async (path: string) => { touched.push(path); return ''; }) as unknown as MachineFs['readFile'],
      appendFile: async (path, data) => { touched.push(`${path} << ${String(data)}`); },
    } });
    await excludeFromGit(machine, side.repo);
    assert.deepEqual(touched, [side.info, side.exclude, `${side.exclude} << .hive/\n`]);
  });
}
