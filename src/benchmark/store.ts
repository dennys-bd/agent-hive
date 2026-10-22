// The experiment folder (#459): <home>/benchmark/<id>/, mode 0700. Every path comes from an id that passed EXPERIMENT_ID, an upload name
// that passed UPLOAD_NAME or a repo path that passed safeFilePath (ls-tree's too), so no request names a file outside the folder. Git goes
// through the caller's Git, argv only.
import { cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { experimentDir } from '../benchmark-guards.js';
import { safeFilePath } from '../custom-versions.js';
import { workspaceBase } from '../fork.js';
import { customRoot } from '../item-sources.js';
import { COMMIT } from '../state-guards.js';
import { type BenchScenario, type BenchSeed, type Config, EXPERIMENT_ID, type Workspace } from '../types.js';
import { type Git, remoteHead } from '../worktree-base.js';
import { UPLOAD_NAME, UPLOAD_PREFIX } from './names.js';
import { pluginTrees } from './pin.js';
import { privateDir } from './run-home.js';

export { UPLOAD_NAME, UPLOAD_PREFIX }; // #463: node-free in names.ts, so the config tab checks a name against the route's own pattern

// What duplicate and fork carry: repo.git, clone/ and runs/ belong to the source's rounds (3.1 makes a new experiment's on its first run)
const COPIED = ['plugin', 'seed'] as const;
export const UPLOAD_NAME_MESSAGE = 'an upload name is up to 128 letters, digits, dots, dashes and underscores, starting with a letter or a digit';

/** A seed entry (a repo path, `upload:<name>` or the commit) that is not there: the route answers 404 naming it. */
export class SeedFileMissing extends Error {}

/** #471's experimentDir, for an id that passed EXPERIMENT_ID only: the routes build paths from request ids. */
export function experimentFolder(home: string, id: string): string {
  if (!EXPERIMENT_ID.test(id)) throw new Error('not an experiment id');
  return experimentDir(home, id);
}
const seedDir = (dir: string): string => join(dir, 'seed');
export const seedRepo = (dir: string): string => join(seedDir(dir), 'repo');
export const isUpload = (entry: string): boolean => entry.startsWith(UPLOAD_PREFIX);

/** Every entry the seed lists, once, in sorted order. */
export const seedEntries = (seed: BenchSeed): string[] => [...new Set([...seed.reference, ...seed.sample.files])].sort();

export function seedFilePath(dir: string, entry: string): string {
  const name = isUpload(entry) ? entry.slice(UPLOAD_PREFIX.length) : undefined;
  if (name !== undefined && UPLOAD_NAME.test(name)) return join(seedDir(dir), 'upload', name);
  const path = name === undefined ? safeFilePath(entry) : undefined;
  if (path !== undefined) return join(seedRepo(dir), path);
  throw new SeedFileMissing(entry);
}

export const createFolder = (dir: string): Promise<void> => privateDir(dir); // mkdir + chmod: mkdir's mode alone is cut by the umask
export const removeFolder = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

// A link in a copied tree could point outside the folder: it is skipped, so a pin never carries one
const notLink = async (src: string): Promise<boolean> => !(await lstat(src)).isSymbolicLink();
const copyTree = (from: string, to: string): Promise<void> => cp(from, to, { recursive: true, filter: notLink });

export async function copyFolder(from: string, to: string): Promise<void> {
  await createFolder(to);
  for (const part of COPIED) await copyTree(join(from, part), join(to, part));
}

const onlyMissing = (err: unknown): void => {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
};

/** The render's inputs as they are now: every run of the experiment renders from this copy, never from the current Hive (spec, decision 1). */
export async function pinPlugin(dir: string, pluginSource: string, home: string): Promise<void> {
  const trees = pluginTrees(dir);
  await createFolder(dir);
  await copyTree(pluginSource, trees.source);
  await mkdir(trees.custom, { recursive: true });
  await copyTree(customRoot(home), trees.custom).catch(onlyMissing); // no custom store yet: an empty pin
}

/** The sha of <base remote>/<base> as normal tasks start from it (#119, #854): read-only, never set-head. */
export async function seedCommit(config: Pick<Config, 'baseBranch'>, workspace: Pick<Workspace, 'fork' | 'baseBranch'>, git: Git): Promise<string> {
  const base = workspaceBase(config, workspace);
  const branch = base.branch ?? (await remoteHead(git, base.remote, false));
  const sha = (await git('rev-parse', '--verify', `${base.remote}/${branch}^{commit}`)).trim();
  if (!COMMIT.test(sha)) throw new Error('rev-parse answered no commit');
  return sha;
}

// Any git failure reads as "not there", which the route answers 404
const typeAt = (git: Git, spec: string): Promise<string> => git('cat-file', '-t', spec).then((out) => out.trim(), () => '');

// The files a repo entry names at the commit: itself as a blob, every file under it as a tree; undefined when it is neither
async function repoFiles(git: Git, commit: string, entry: string): Promise<string[] | undefined> {
  const type = await typeAt(git, `${commit}:${entry}`);
  if (type === 'blob') return [entry];
  if (type !== 'tree') return undefined;
  const listed = (await git('ls-tree', '-r', '-z', '--name-only', commit, '--', entry)).split('\0');
  return listed.filter((path) => path.startsWith(`${entry}/`) && safeFilePath(path) !== undefined);
}

// Everything the sync will write, resolved before anything is removed: a refused edit leaves seed/ as it was
async function resolveSeed(dir: string, seed: BenchSeed, git: Git): Promise<string[]> {
  if ((await typeAt(git, seed.commit)) !== 'commit') throw new SeedFileMissing(seed.commit);
  const files = new Set<string>();
  for (const entry of seedEntries(seed)) {
    const found = isUpload(entry) ? await stat(seedFilePath(dir, entry)).then(() => [], () => undefined) : await repoFiles(git, seed.commit, entry);
    if (found === undefined) throw new SeedFileMissing(entry);
    for (const path of found) files.add(path);
  }
  return [...files].sort();
}

async function pruneUploads(dir: string, seed: BenchSeed): Promise<void> {
  const listed = new Set(seedEntries(seed).filter(isUpload).map((e) => e.slice(UPLOAD_PREFIX.length)));
  const uploads = join(seedDir(dir), 'upload');
  const names = await readdir(uploads).catch((err: unknown) => {
    onlyMissing(err);
    return [] as string[];
  });
  for (const name of names.filter((n) => !listed.has(n))) await rm(join(uploads, name), { force: true });
}

export const scenariosMarkdown = (scenarios: readonly BenchScenario[]): string => scenarios.map((s) => `## ${s.title}\n\n${s.text}\n`).join('\n');

async function writeRepoFiles(root: string, files: string[], seed: BenchSeed, git: Git): Promise<void> {
  for (const path of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    // ponytail: exec answers utf8 text under its default maxBuffer, so a seed read from the repository is text only; a binary or very large
    // file goes through the upload route, an encoding option on Exec if the repository must supply one
    await writeFile(target, await git('show', `${seed.commit}:${path}`));
  }
}

/** seed/ from the seed: the repo files read at its commit (a folder expanded), scenarios.md, and only the uploads it lists. */
export async function syncSeed(dir: string, seed: BenchSeed, git: Git): Promise<void> {
  const files = await resolveSeed(dir, seed, git);
  // Built beside the old copy and renamed over it last: a failed write leaves the old seed intact
  const temp = join(seedDir(dir), `.sync-${process.pid}-${Date.now()}`);
  try {
    await mkdir(join(temp, 'repo'), { recursive: true });
    await writeRepoFiles(join(temp, 'repo'), files, seed, git);
    await writeFile(join(temp, 'scenarios.md'), scenariosMarkdown(seed.scenarios));
    await rm(seedRepo(dir), { recursive: true, force: true });
    await rename(join(temp, 'repo'), seedRepo(dir));
    await rename(join(temp, 'scenarios.md'), join(seedDir(dir), 'scenarios.md'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await pruneUploads(dir, seed);
}

export async function writeUpload(dir: string, name: string, bytes: Buffer): Promise<void> {
  if (!UPLOAD_NAME.test(name)) throw new Error('not an upload name');
  const uploads = join(seedDir(dir), 'upload');
  await mkdir(uploads, { recursive: true });
  await writeFile(join(uploads, name), bytes);
}
