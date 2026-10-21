import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { nestedPathProblem } from './config-nested.js';
import { originRepository } from './repos/repositories.js';
import type { Exec, NestedCause, NestedProblem, NestedRepoRead, NestedReposAnswer } from './types.js';
import { gitAnswers, gitOrWords } from './worktree-base.js';
import { nestedBase } from './worktree-nested.js';

// Settings' side of a workspace's nested repos (#653): why a path cannot be one, the ones the Hive suggests, and what the card shows. Always the
// real git and read-only (no fetch, no set-head), as workspacePathProblem: the settings save and GET /settings/nested-repos run it.

const execFileAsync: Exec = promisify(execFile);
const GITLINK = /^160000 /m; // ls-files --stage's mode for a submodule
const HIVE_PREFIX = '.hive/';

const realOrNone = (path: string): Promise<string | undefined> => realpath(path).catch(() => undefined);

// git's top level for `dir` relative to the workspace, both real paths; undefined when there is none or it is outside the workspace
async function topLevelIn(workspacePath: string, dir: string, exec: Exec): Promise<{ root: string; isDir: boolean } | undefined> {
  const top = await gitOrWords(dir, ['rev-parse', '--show-toplevel'], exec).then((out) => out.trim(), () => '');
  if (top === '') return undefined;
  const [realTop, realWs, realDir] = await Promise.all([realOrNone(top), realpath(workspacePath), realOrNone(dir)]);
  const root = realTop === undefined ? '..' : relative(realWs, realTop);
  return root === '' || root.startsWith('..') ? undefined : { root: root.split(sep).join('/'), isDir: realTop === realDir };
}

/** Why `path` cannot be one of the workspace's nested repos (#653), undefined when it can, checked in order: its shape (the parser's rule),
 * a git repository at all (a plain folder answers the workspace's own top level: no repository), its own top level (naming it), a
 * submodule, tracked by the workspace's git, ignored by it. */
export async function nestedRepoProblem(workspacePath: string, path: string, exec: Exec = execFileAsync): Promise<NestedProblem | undefined> {
  if (nestedPathProblem(path) !== undefined) return { cause: 'badPath' };
  const top = await topLevelIn(workspacePath, join(workspacePath, path), exec);
  if (top === undefined) return { cause: 'notRepo' };
  if (!top.isDir) return { cause: 'notTopLevel', root: top.root };
  const ws = (args: string[]): Promise<string> => gitOrWords(workspacePath, args, exec);
  if (GITLINK.test(await ws(['ls-files', '--stage', '--', path]))) return { cause: 'submodule' };
  if ((await ws(['ls-files', '--', path])).trim() !== '') return { cause: 'tracked' };
  return (await gitAnswers(workspacePath, ['check-ignore', '-q', '--', path], exec)) ? undefined : { cause: 'notIgnored' };
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
 * not another repository's worktree), minus `skip`. */
export async function detectNested(workspacePath: string, skip: readonly string[], exec: Exec = execFileAsync): Promise<string[]> {
  const listed = await gitOrWords(workspacePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], exec);
  const folders = listed.split('\0').filter((entry) => entry.endsWith('/') && !entry.startsWith(HIVE_PREFIX)).map((entry) => entry.slice(0, -1));
  const candidates = folders.filter((path) => !skip.includes(path));
  const isRepo = await Promise.all(candidates.map((path) => stat(join(workspacePath, path, '.git')).then((s) => s.isDirectory(), () => false)));
  return candidates.filter((_, i) => isRepo[i]);
}

const withRepository = <T extends { path: string }>(row: T, repository: string | undefined): T & { repository?: string } =>
  (repository === undefined ? row : { ...row, repository });

// One listed path: its problem, or its GitHub repository and the base its branches would start from
async function readOne(workspacePath: string, path: string, baseName: string, exec: Exec): Promise<NestedRepoRead> {
  const problem = await nestedRepoProblem(workspacePath, path, exec);
  if (problem) return { path, problem };
  const dir = join(workspacePath, path);
  const read = withRepository({ path }, await originRepository(exec, dir));
  return { ...read, base: await nestedBase(dir, baseName, exec, false) };
}

/** GET /settings/nested-repos' answer (#653): each listed path read, then the suggestions with their repository. */
export async function readNestedRepos(workspacePath: string, baseName: string, repos: readonly string[], exec: Exec = execFileAsync): Promise<NestedReposAnswer> {
  const read = await Promise.all(repos.map((path) => readOne(workspacePath, path, baseName, exec)));
  const found = await detectNested(workspacePath, repos, exec);
  const suggested = await Promise.all(found.map(async (path) => withRepository({ path }, await originRepository(exec, join(workspacePath, path)))));
  return { repos: read, suggested };
}
