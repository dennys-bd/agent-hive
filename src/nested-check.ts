import { nestedPathProblem } from './config-nested.js';
import type { Machine } from './machine.js';
import { originRepository } from './repos/repositories.js';
import type { NestedCause, NestedProblem, NestedRepoRead, NestedReposAnswer } from './types.js';
import { isWin32Paths } from './same-path.js';
import { toWire } from './wire-path.js';
import { gitAnswers, gitOrWords } from './worktree-base.js';
import { nestedBase } from './worktree-nested.js';

// Settings' side of a workspace's nested repos (#653): why a path cannot be one, the ones the Hive suggests, and what the card shows. Always
// read-only (no fetch, no set-head), as workspacePathProblem: the settings save and GET /settings/nested-repos run it, each on the machine of
// the workspace it checks (#882).

type NestedMachine = Pick<Machine, 'exec' | 'fs' | 'paths'>;
const GITLINK = /^160000 /m; // ls-files --stage's mode for a submodule
const HIVE_PREFIX = '.hive/';

const realOrNone = (machine: Pick<Machine, 'fs'>, path: string): Promise<string | undefined> => machine.fs.realpath(path).catch(() => undefined);

// git's top level for `dir` relative to the workspace, both real paths; undefined when there is none or it is outside the workspace
async function topLevelIn(machine: NestedMachine, workspacePath: string, dir: string): Promise<{ root: string; isDir: boolean } | undefined> {
  const top = await gitOrWords(dir, ['rev-parse', '--show-toplevel'], machine.exec).then((out) => out.trim(), () => '');
  if (top === '') return undefined;
  const [realTop, realWs, realDir] = await Promise.all([realOrNone(machine, top), machine.fs.realpath(workspacePath), realOrNone(machine, dir)]);
  const root = realTop === undefined ? '..' : machine.paths.relative(realWs, realTop);
  return root === '' || root.startsWith('..') ? undefined : { root: toWire(root, isWin32Paths(machine.paths) ? 'win32' : 'linux'), isDir: realTop === realDir };
}

/** Why `path` cannot be one of the workspace's nested repos (#653), undefined when it can, checked in order: its shape (the parser's rule),
 * a git repository at all (a plain folder answers the workspace's own top level: no repository), its own top level (naming it), a
 * submodule, tracked by the workspace's git, ignored by it. */
export async function nestedRepoProblem(machine: NestedMachine, workspacePath: string, path: string): Promise<NestedProblem | undefined> {
  if (nestedPathProblem(path) !== undefined) return { cause: 'badPath' };
  const top = await topLevelIn(machine, workspacePath, machine.paths.join(workspacePath, path));
  if (top === undefined) return { cause: 'notRepo' };
  if (!top.isDir) return { cause: 'notTopLevel', root: top.root };
  const ws = (args: string[]): Promise<string> => gitOrWords(workspacePath, args, machine.exec);
  if (GITLINK.test(await ws(['ls-files', '--stage', '--', path]))) return { cause: 'submodule' };
  if ((await ws(['ls-files', '--', path])).trim() !== '') return { cause: 'tracked' };
  return (await gitAnswers(workspacePath, ['check-ignore', '-q', '--', path], machine.exec)) ? undefined : { cause: 'notIgnored' };
}

const TEXTS: Readonly<Record<NestedCause, (path: string, root: string) => string>> = {
  badPath: (path) => `${path} is not a folder inside this workspace · write a relative path outside .hive, like docs`,
  notRepo: (path) => `${path} is not a git repository · clone the repository there, or remove it from the list`,
  notTopLevel: (path, root) => `${path} is not a git repository's top level · the top level is ${root} · use ${root}`,
  submodule: (path) => `${path} is a submodule of this workspace · the workspace's git already brings it into every worktree`,
  tracked: (path) => `this workspace's git tracks files in ${path} · stop tracking them (git rm -r --cached ${path}) and add ${path}/ to the workspace's .gitignore`,
  notIgnored: (path) => `this workspace's git does not ignore ${path} · add ${path}/ to the workspace's .gitignore`,
};

/** The save's 400 for a nested repo's problem (#653), in English with its fix: the card shows the same in the user's language. */
export const nestedProblemText = (path: string, { cause, root = '' }: NestedProblem): string => TEXTS[cause](path, root);

/** The nested repos the Hive suggests (#653): every folder the workspace's git ignores, outside .hive/, whose .git is a directory (a checkout,
 * not another repository's worktree), minus `skip`. fsmonitor off: #747 runs this in a repo no longer in Settings, whose config could name a
 * monitor command. */
export async function detectNested(machine: NestedMachine, workspacePath: string, skip: readonly string[]): Promise<string[]> {
  const listed = await gitOrWords(workspacePath, ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], machine.exec);
  const folders = listed.split('\0').filter((entry) => entry.endsWith('/') && !entry.startsWith(HIVE_PREFIX)).map((entry) => entry.slice(0, -1));
  const candidates = folders.filter((path) => !skip.includes(path));
  const isRepo = await Promise.all(candidates.map((path) => machine.fs.stat(machine.paths.join(workspacePath, path, '.git')).then((s) => s.isDirectory(), () => false)));
  return candidates.filter((_, i) => isRepo[i]);
}

const withRepository = <T extends { path: string }>(row: T, repository: string | undefined): T & { repository?: string } =>
  (repository === undefined ? row : { ...row, repository });

// One listed path: its problem, or its GitHub repository and the base its branches would start from
async function readOne(machine: NestedMachine, workspacePath: string, path: string, baseName: string): Promise<NestedRepoRead> {
  const problem = await nestedRepoProblem(machine, workspacePath, path);
  if (problem) return { path, problem };
  const dir = machine.paths.join(workspacePath, path);
  const read = withRepository({ path }, await originRepository(machine, dir));
  return { ...read, base: await nestedBase(dir, baseName, machine.exec, false) };
}

/** GET /settings/nested-repos' answer (#653): each listed path read, then the suggestions with their repository. */
export async function readNestedRepos(machine: NestedMachine, workspacePath: string, baseName: string, repos: readonly string[]): Promise<NestedReposAnswer> {
  const read = await Promise.all(repos.map((path) => readOne(machine, workspacePath, path, baseName)));
  const found = await detectNested(machine, workspacePath, repos);
  const suggested = await Promise.all(found.map(async (path) => withRepository({ path }, await originRepository(machine, machine.paths.join(workspacePath, path)))));
  return { repos: read, suggested };
}
