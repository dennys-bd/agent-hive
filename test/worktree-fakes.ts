import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Machine } from '../src/machine.js';
import { HOST_PATHS } from './fake-machine.js';
import { parseSetup, type SetupStep } from '../src/setup-script.js';
import type { Exec, Workspace } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { type Phase, type StepDeps, WORKTREE_NAME } from '../src/worktree-steps.js';
import { fakeMachine } from './fakes.js';
import { tempDir, type AfterHost } from './temp-dir.js';

// Records every command; `worktree list` answers `listing`; `rev-parse` fails unless `branch` says the ref exists; the call
// whose args include `failing` rejects with `message` (execFile's message embeds git's stderr, `stderr` is git's own).
export function fakeExec(options: { listing?: string; failing?: string; message?: string; stderr?: string; branch?: boolean } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const { listing = '', failing, message = `${failing} boom`, stderr, branch = false } = options;
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (failing && args.includes(failing)) throw Object.assign(new Error(message), stderr === undefined ? {} : { stderr });
    if (args.includes('rev-parse') && !branch) throw new Error('not a ref');
    return { stdout: args.includes('list') ? listing : '' };
  };
  return { exec, calls };
}

// A repo dir, and the prompt file the spawn wrote in the home's prompts/ (#202: never the repo's); `worktree` also creates the
// directory the Hive would have made.
export async function repoWith(t: AfterHost, options: { worktree?: boolean } = {}): Promise<{ repo: string; promptsDir: string; prompt: string; worktree: string }> {
  const repo = await tempDir(t, 'worktree-');
  const promptsDir = join(await tempDir(t, 'home-'), 'prompts');
  const prompt = join(promptsDir, 'hive-7-fix.md');
  await mkdir(promptsDir);
  await writeFile(prompt, 'prompt');
  const worktree = worktreePath(HOST_PATHS, repo, 'hive-7-fix');
  if (options.worktree) await mkdir(worktree, { recursive: true });
  return { repo, promptsDir, prompt, worktree };
}

export const BRANCH = 'hive/7-fix-the-login'; // what renderBranch gives the server for this task
export const gone = (path: string): Promise<void> => assert.rejects(readFile(path), { code: 'ENOENT' });
// What git prints: the main checkout, the worker's worktree on `head` (feat/x, the branch the worker checked out), a detached one
export const listing = (repo: string, worktree: string, head = 'branch refs/heads/feat/x'): string =>
  [`worktree ${repo}\nHEAD 1111\nbranch refs/heads/main\n`, `worktree ${worktree}\nHEAD 2222\n${head}\n`, `worktree ${repo}/other\nHEAD 3333\ndetached\n`].join('\n');

export const SLUG = 'hive-58-clear-worktree';
export const CLEAN_BRANCH = 'hive/58-clear-worktree'; // what renderBranch gives the server for that task

// `git worktree list --porcelain`: one block per worktree, the main checkout first, a blank line between blocks.
export const porcelain = (repo: string, entries: [string, string?][]): string =>
  [[repo, 'main'] as [string, string?], ...entries]
    .map(([path, branch]) => `worktree ${path}\nHEAD 0123456789abcdef0123456789abcdef01234567\n${branch ? `branch refs/heads/${branch}` : 'detached'}\n`)
    .join('\n');


export interface StepHarness { workspace: Workspace; main: string; worktree: string; home: string; machine: Machine; deps: StepDeps; output: string[] }

// The main checkout, the worktree and a machine home, each a temp folder; the steps run no git (#159).
export async function stepHarness(t: AfterHost): Promise<StepHarness> {
  const [main, worktree, home] = await Promise.all([tempDir(t, 'main-'), tempDir(t, 'wt-'), tempDir(t, 'home-')]);
  const output: string[] = [];
  const noGit: Exec = async () => assert.fail('the steps run no git');
  const machine = fakeMachine({ exec: noGit, info: { homedir: home } });
  const deps: StepDeps = { log: { info: () => undefined }, output: (text) => output.push(text) };
  return { workspace: { name: 'hive', path: main, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' }, main, worktree, home, machine, deps, output };
}

export const setupPhase = (h: StepHarness): Phase => ({ name: 'setup', from: h.main, fromName: 'hive', to: h.worktree, toName: WORKTREE_NAME });
export const teardownPhase = (h: StepHarness): Phase => ({ name: 'teardown', from: h.worktree, fromName: WORKTREE_NAME, to: h.main, toName: 'hive' });
export const steps = (text: string): SetupStep[] => parseSetup(text, { allowLoad: true, paths: HOST_PATHS });
