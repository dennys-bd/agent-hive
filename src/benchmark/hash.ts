// The experiment's hashes (#459): what tells two experiments' plugin, seed and tasks apart. Every input is put in one order on every machine
// (keys sorted, paths sorted here, never readdir's order), so CI on Linux hashes a tree as macOS does.
import { createHash, type Hash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listFiles } from '../item-sources.js';
import type { BenchSeed, BenchTask } from '../types.js';
import { isUpload, seedEntries, seedFilePath, seedRepo } from './store.js';

export interface TreeReads { list(dir: string): Promise<string[]>; read(path: string): Promise<Buffer> }
export const FS_READS: TreeReads = { list: listFiles, read: (path) => readFile(path) };

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (paths: readonly string[]): string[] => [...paths].sort(byCodePoint);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => byCodePoint(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// path\0content\0: a path never runs into the bytes of the file before it
function addFile(hash: Hash, path: string, bytes: Buffer): void {
  hash.update(path).update('\0').update(bytes).update('\0');
}

async function addTree(hash: Hash, label: string, dir: string, reads: TreeReads): Promise<void> {
  for (const path of sorted(await reads.list(dir))) addFile(hash, `${label}/${path}`, await reads.read(join(dir, path)));
}

/** Each tree's files under `<label>/`, labels and paths sorted. */
export async function treeHash(dirs: Readonly<Record<string, string>>, reads: TreeReads = FS_READS): Promise<string> {
  const hash = createHash('sha256');
  for (const label of sorted(Object.keys(dirs))) await addTree(hash, label, dirs[label], reads);
  return hash.digest('hex');
}

/** Every field of the seed, then seed/repo/ as the sync wrote it (a listed folder expanded), then each listed upload: an upload the seed does
 *  not list is not part of it. */
export async function seedHash(seed: BenchSeed, dir: string, reads: TreeReads = FS_READS): Promise<string> {
  const hash = createHash('sha256').update(canonicalJson(seed)).update('\0');
  await addTree(hash, 'repo', seedRepo(dir), reads);
  for (const entry of seedEntries(seed).filter(isUpload)) addFile(hash, entry, await reads.read(seedFilePath(dir, entry)));
  return hash.digest('hex');
}

export const tasksHash = (tasks: readonly BenchTask[]): string => createHash('sha256').update(canonicalJson(tasks)).digest('hex');
