// A custom version's update (#324): the three-way merge of the version's files/, its base/ and the shipped files, with git as the engine
// (custom-merge-git.ts). The preview writes nothing; apply recomputes the same merge, and a token over the three inputs proves it is the
// merge the preview showed.
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diffTexts, type Hunk, mergeTexts, resolveMerge, type Segment } from './custom-merge-git.js';
import { BASE_DIR, FILES_DIR, isRefusal, mainFiles, parseVersionJson, refusal, type StoreRefusal, VERSION_FILE, type VersionJson, writeVersionJson } from './custom-versions.js';
import { isInside } from './ide.js';
import { childFolders, customRoot, type FileSet, HIVE_ORIGIN, type ItemSources, listFiles, originFiles, pluginVersion, versionDir, versionFiles } from './item-sources.js';
import { findItem } from './items-catalogue.js';
import type { CatalogueItem, ItemVersion, UpdateChange, UpdateChoice, UpdateConflict, UpdatePreview } from './types.js';

const WHOLE = 'file'; // the id suffix of a whole-file conflict
const HEADING = /^#{1,6}\s/;
const EMPTY = Buffer.alloc(0);
const STAGING_DIR = 'custom-staging'; // beside custom/: the catalogue never lists it, and a rename out of it stays on the same disk

export type UpdateChoices = Readonly<Partial<Record<string, UpdateChoice>>>;

type Side = ReadonlyMap<string, Buffer>;
interface Sides {
  mine: Side;
  base: Side;
  hive: Side;
}
interface Merged {
  kind: 'merged';
  path: string;
  mine: Buffer | undefined;
  result: Buffer | undefined; // undefined: the version ends up without the file
}
interface Whole {
  kind: 'whole';
  path: string;
  mine: Buffer | undefined;
  base: Buffer | undefined;
  hive: Buffer | undefined;
}
interface Blocks {
  kind: 'blocks';
  path: string;
  mine: Buffer;
  segments: Segment[];
}
type FileMerge = Merged | Whole | Blocks;
type Change = UpdateChange | UpdateConflict;
interface Placed {
  at: number; // the lines above the change, for the order inside its file
  change: Change;
}
interface Update {
  item: CatalogueItem;
  version: ItemVersion;
  shipped: Side; // the shipped files as merged: apply writes them as the new base/
  token: string;
  merges: FileMerge[];
  outPath(path: string): string; // where a merged path goes in the new files/
}

const same = (a: Buffer | undefined, b: Buffer | undefined): boolean => (a === undefined || b === undefined ? a === b : a.equals(b));
// git treats a file with a NUL byte as binary even when it is valid UTF-8
const isText = (...files: (Buffer | undefined)[]): boolean => files.every((file) => file === undefined || (isUtf8(file) && !file.includes(0)));
const linesOf = (text: string): string[] => text.split(/\r?\n/);
const bare = (lines: readonly string[]): string[] => lines.map((line) => line.replace(/\r?\n$/, ''));
const headingOf = (lines: readonly string[], above: number, file: string): string => lines.slice(0, above).filter((line) => HEADING.test(line)).pop() ?? file;

// A whole file's lines, for a conflict's side; a file that is not UTF-8 has none to show
function fileLines(file: Buffer): string[] {
  if (!isUtf8(file)) return [];
  const lines = linesOf(file.toString('utf8'));
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

async function readSide({ dir, paths }: FileSet): Promise<Side> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readFile(join(dir, path))] as const)));
}

async function withTempDir<T>(job: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'hive-merge-'));
  try {
    return await job(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// sha256 over the three sides in a fixed order, each as its paths (listFiles answers them sorted) and their bytes
function tokenOf(sides: Sides): string {
  const hash = createHash('sha256');
  for (const name of ['mine', 'base', 'hive'] as const) {
    hash.update(`${name}\0`);
    for (const [path, bytes] of sides[name]) hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

const mainOf = (side: Side, main: readonly string[]): string | undefined => main.find((file) => side.has(file));

function moved(side: Side, from: string | undefined, to: string): Side {
  const bytes = from === undefined ? undefined : side.get(from);
  if (bytes === undefined || from === to) return side;
  return new Map<string, Buffer>([...[...side].filter(([path]) => path !== from), [to, bytes]]);
}

// The main file is one file by role whatever its .liquid suffix (#310): the base and shipped ones merge under the version's name. An
// untouched main file takes the shipped name, so a .md the user never edited never receives a template body
function paired(item: CatalogueItem, raw: Sides): Pick<Update, 'outPath'> & { sides: Sides } {
  const main = mainFiles(item.kind, item.name);
  const shipped = mainOf(raw.hive, main);
  const key = mainOf(raw.mine, main) ?? shipped ?? main[0];
  const sides: Sides = { mine: raw.mine, base: moved(raw.base, mainOf(raw.base, main), key), hive: moved(raw.hive, shipped, key) };
  const named = shipped !== undefined && same(sides.mine.get(key), sides.base.get(key)) ? shipped : key;
  return { sides, outPath: (path) => (path === key ? named : path) };
}

// One path: a side's absence or a file that is not UTF-8 decides it, and git merges three texts that all changed
async function mergePath(dir: string, path: string, sides: Sides): Promise<FileMerge> {
  const [mine, base, hive] = [sides.mine.get(path), sides.base.get(path), sides.hive.get(path)];
  if (same(hive, base) || same(mine, hive)) return { kind: 'merged', path, mine, result: mine };
  if (same(mine, base)) return { kind: 'merged', path, mine, result: hive };
  if (mine === undefined || base === undefined || hive === undefined || !isText(mine, base, hive)) return { kind: 'whole', path, mine, base, hive };
  const segments = await mergeTexts(dir, mine, base, hive);
  if (segments.every((segment): segment is string => typeof segment === 'string')) return { kind: 'merged', path, mine, result: Buffer.from(segments.join('')) };
  return { kind: 'blocks', path, mine, segments };
}

// The three sides of a version's update and their merge, or why there is nothing to merge
async function loadUpdate(s: ItemSources, id: string, name: string, dir: string): Promise<Update | StoreRefusal> {
  const item = await findItem(s, id);
  if (item === undefined) return refusal('unknown_item', `no item ${id}`);
  const version = item.versions.find((v) => v.name === name);
  if (version === undefined) return refusal('unknown_version', `${id} has no version ${name}`);
  const origin = await originFiles(s, item);
  if (origin === undefined) return refusal('no_update', `the Hive no longer ships ${item.name}`);
  if (!version.updateAvailable) return refusal('no_update', `${id}: version ${name} is up to date`);
  const baseDir = join(versionDir(s.home, item, name), BASE_DIR);
  const raw: Sides = { mine: await readSide(await versionFiles(s.home, item, name)), base: await readSide({ dir: baseDir, paths: await listFiles(baseDir) }), hive: await readSide(origin) };
  const { sides, outPath } = paired(item, raw);
  const paths = [...new Set([...sides.mine.keys(), ...sides.base.keys(), ...sides.hive.keys()])].sort();
  const merges: FileMerge[] = [];
  for (const path of paths) merges.push(await mergePath(dir, path, sides)); // one at a time: every merge reuses the temp folder's names
  return { item, version, shipped: raw.hive, token: tokenOf(raw), merges, outPath };
}

const clean = (file: string, mine: readonly string[], hunk: Hunk): Placed => ({
  at: hunk.toAbove,
  change: { kind: 'clean', file, heading: headingOf(mine, hunk.fromAbove, file), removed: hunk.removed, added: hunk.added },
});

const wholeConflict = (merge: Whole): UpdateConflict => ({
  kind: 'conflict',
  id: `${merge.path}#${WHOLE}`,
  file: merge.path,
  heading: merge.path,
  mine: merge.mine === undefined ? null : fileLines(merge.mine),
  hive: merge.hive === undefined ? null : fileLines(merge.hive),
  base: merge.base === undefined ? [] : fileLines(merge.base),
});

// A file with no conflict: its diff from the version's text, hunk by hunk
async function mergedChanges(dir: string, merge: Merged): Promise<Placed[]> {
  if (same(merge.mine, merge.result)) return [];
  // A file that is not UTF-8 has no lines to list: its change is the file as a whole
  if (!isText(merge.mine, merge.result)) return [{ at: 0, change: { kind: 'clean', file: merge.path, heading: merge.path, removed: [], added: [] } }];
  const mine = merge.mine ?? EMPTY;
  const lines = linesOf(mine.toString('utf8'));
  return (await diffTexts(dir, mine, merge.result ?? EMPTY)).map((hunk) => clean(merge.path, lines, hunk));
}

// Each conflict at its line in the text with every conflict kept as mine, labelled by the heading above it there
function conflictsOf(file: string, segments: readonly Segment[], kept: readonly string[]): Placed[] {
  let at = 0;
  let n = 0;
  return segments.flatMap((segment): Placed[] => {
    if (typeof segment === 'string') {
      at += 1;
      return [];
    }
    const placed: Placed = { at, change: { kind: 'conflict', id: `${file}#${n}`, file, heading: headingOf(kept, at, file), mine: bare(segment.mine), hive: bare(segment.hive), base: bare(segment.base) } };
    at += segment.mine.length;
    n += 1;
    return [placed];
  });
}

// A text git merged with conflicts: its clean changes are the diff from the version's text to the merge with every conflict kept as mine
async function blockChanges(dir: string, merge: Blocks): Promise<Placed[]> {
  const kept = resolveMerge(merge.segments, () => 'mine');
  const lines = linesOf(merge.mine.toString('utf8'));
  const hunks = await diffTexts(dir, merge.mine, Buffer.from(kept));
  return [...hunks.map((hunk) => clean(merge.path, lines, hunk)), ...conflictsOf(merge.path, merge.segments, linesOf(kept))];
}

async function changesOf(dir: string, merge: FileMerge): Promise<Change[]> {
  if (merge.kind === 'whole') return [wholeConflict(merge)];
  const placed = merge.kind === 'merged' ? await mergedChanges(dir, merge) : await blockChanges(dir, merge);
  return [...placed].sort((a, b) => a.at - b.at).map((p) => p.change);
}

/** What applying a version's update would change: clean changes and conflicts, ordered by file, then by position. Writes nothing. */
export function previewUpdate(s: ItemSources, id: string, version: string): Promise<UpdatePreview | StoreRefusal> {
  return withTempDir(async (dir) => {
    const update = await loadUpdate(s, id, version, dir);
    if (isRefusal(update)) return update;
    const changes: Change[] = [];
    for (const merge of update.merges) changes.push(...(await changesOf(dir, merge)));
    const from = update.version.hiveVersion;
    const to = update.item.origin === HIVE_ORIGIN ? await pluginVersion(s.pluginSource) : undefined;
    return { version, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), token: update.token, changes };
  });
}

function conflictIds(merge: FileMerge): string[] {
  if (merge.kind === 'whole') return [`${merge.path}#${WHOLE}`];
  if (merge.kind === 'merged') return [];
  return merge.segments.filter((segment) => typeof segment !== 'string').map((_, n) => `${merge.path}#${n}`);
}

// A merge's bytes as chosen; undefined drops the file (a whole-file conflict resolved to the side that has none)
function chosenBytes(merge: FileMerge, choices: UpdateChoices): Buffer | undefined {
  const pick = (id: string): UpdateChoice => choices[id] ?? 'mine'; // applyUpdate refuses a missing choice before it gets here
  if (merge.kind === 'merged') return merge.result;
  if (merge.kind === 'whole') return merge[pick(`${merge.path}#${WHOLE}`)];
  return Buffer.from(resolveMerge(merge.segments, (n) => pick(`${merge.path}#${n}`)));
}

async function writeAll(dir: string, files: Side): Promise<void> {
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), bytes);
  }
}

// Every field kept but hiveVersion, which follows the new base: the plugin's version for a Hive item, none for a workspace's
async function nextJson(s: ItemSources, update: Update, dir: string): Promise<VersionJson> {
  const json = parseVersionJson(await readFile(join(dir, VERSION_FILE), 'utf8'), update.version.name);
  const hiveVersion = update.item.origin === HIVE_ORIGIN ? await pluginVersion(s.pluginSource) : undefined;
  return { name: json.name, from: json.from, workspaces: json.workspaces, ...(hiveVersion === undefined ? {} : { hiveVersion }) };
}

// The version's own work folder, <home>/custom-staging/<origin>/<name>/<version>/: an apply of another item never touches it
const workDir = (s: ItemSources, update: Update): string => join(s.home, STAGING_DIR, update.item.origin, update.item.name, update.version.name);
const OLD = 'old';
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** After a crash between the swap's two renames the only copy of a version is its work folder's old/: it goes back in place. Everything
 * else in the staging area is a crashed apply's leftover and is removed. Runs before every apply and when the store starts. */
export async function recoverStaging(home: string): Promise<void> {
  const staging = join(home, STAGING_DIR);
  for (const origin of await childFolders(staging)) {
    for (const name of await childFolders(join(staging, origin))) {
      for (const version of await childFolders(join(staging, origin, name))) {
        const old = join(staging, origin, name, version, OLD);
        const target = versionDir(home, { origin, name }, version);
        if (isInside(customRoot(home), target) && !(await exists(target)) && (await exists(old))) {
          await mkdir(dirname(target), { recursive: true });
          await rename(old, target);
        }
      }
    }
  }
  await rm(staging, { recursive: true, force: true });
}

// The new version is written whole in its work folder, version.json last, then swapped in by two renames on one disk. A failure before
// the swap leaves the version as it was; a crash between the renames is undone by recoverStaging
async function swapIn(s: ItemSources, update: Update, files: Side): Promise<void> {
  const target = versionDir(s.home, update.item, update.version.name);
  if (!isInside(customRoot(s.home), target)) throw new Error(`${target} is outside the custom store`);
  const work = workDir(s, update);
  const fresh = join(work, randomUUID());
  try {
    await mkdir(fresh, { recursive: true });
    await writeAll(join(fresh, FILES_DIR), files);
    await writeAll(join(fresh, BASE_DIR), update.shipped);
    await writeVersionJson(fresh, await nextJson(s, update, target));
  } catch (err) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined); // the write's own error is the one to report
    throw err;
  }
  const old = join(work, OLD);
  await rename(target, old);
  try {
    await rename(fresh, target);
  } catch (err) {
    await rename(old, target);
    throw err;
  }
  // The update is in place: a cleanup that fails must not turn it into a failed write; the next recoverStaging removes the leftover.
  // The whole area goes: applies are queued one at a time, and recoverStaging already put back anything a crash had left there
  await rm(join(s.home, STAGING_DIR), { recursive: true, force: true }).catch(() => undefined);
}

/** Applies a version's update as previewed: stale when the three inputs changed since the token, unresolved while a conflict has no
 * choice. Choices that match no conflict are ignored. Answers the version's workspaces. */
export function applyUpdate(s: ItemSources, id: string, version: string, token: string, choices: UpdateChoices): Promise<{ workspaces: string[] } | StoreRefusal> {
  return withTempDir(async (dir) => {
    await recoverStaging(s.home);
    const update = await loadUpdate(s, id, version, dir);
    if (isRefusal(update)) return update;
    if (update.token !== token) return refusal('stale', `${id}: version ${version} or the shipped files changed since the preview`);
    const missing = update.merges.flatMap(conflictIds).filter((conflict) => choices[conflict] === undefined);
    if (missing.length > 0) return refusal('unresolved', `choose mine or hive for ${missing.join(', ')}`);
    const files = new Map(
      update.merges.flatMap((merge): [string, Buffer][] => {
        const bytes = chosenBytes(merge, choices);
        return bytes === undefined ? [] : [[update.outPath(merge.path), bytes]];
      }),
    );
    await swapIn(s, update, files);
    return { workspaces: update.version.workspaces };
  });
}
