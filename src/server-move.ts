// The file tree's drop (#594): an item of the activity's tree, or a file dragged from Finder, moved or copied into a folder of the tree. Every
// path goes through tree-paths.ts's guards, every disk touch through MoveFs, so node:test fakes a volume boundary.
import { cp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { Express, Request, Response } from 'express';
import { isInside } from './ide.js';
import type { TaskRouteDeps, Refusal } from './server-tasks.js';
import { treeRoot } from './server-tree.js';
import { destination, exists, isRootOrInside, outermost, PATH_DISK, type PathFs, refusal, rootsOf, sourceItem } from './tree-paths.js';
import type { Language } from './types.js';
import { wordsOf } from './worktree.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
export const MOVE_BODY_MESSAGE = 'body must be { sources: non-empty strings, into: string, copy: boolean }';
/** The word a kept-both item carries, in the Hive's effective language: the suffix is UI copy (#594). */
export const COPY_SUFFIX: Record<Language, string> = { en: 'copy', pt: 'copia' };

export interface MoveFs extends PathFs {
  rename(from: string, to: string): Promise<void>;
  cp(from: string, to: string): Promise<void>; // recursive, never over an existing path
  rm(path: string): Promise<void>; // recursive
}

// cp keeps a link a link and never overwrites
export const MOVE_DISK: MoveFs = {
  ...PATH_DISK,
  rename: (from, to) => rename(from, to),
  cp: (from, to) => cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }),
  rm: (path) => rm(path, { recursive: true }),
};

// The extension is after the last dot of a name that does not start with one (`.env` has none); a folder has none
function splitName(name: string, isFolder: boolean): [string, string] {
  const dot = name.lastIndexOf('.');
  return isFolder || dot <= 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot)];
}

/** Keep both, never overwrite (#594): `name` when free, else `a - copy.ts`, then `a - copy 2.ts`, `a - copy 3.ts`… Pure but for the probe. */
export async function freeName(taken: (name: string) => Promise<boolean>, name: string, suffix: string, isFolder = false): Promise<string> {
  if (!(await taken(name))) return name;
  const [stem, ext] = splitName(name, isFolder);
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} - ${suffix}${n === 1 ? '' : ` ${n}`}${ext}`;
    if (!(await taken(candidate))) return candidate;
  }
}

// Finder does nothing here either: a folder into itself or below it (cp would recurse into its own output), and an item moved onto its own
// folder. A copy onto its own folder is Finder's duplicate (#818): it lands under a free name. The UI never sends a no-op; this does not
// trust that.
const isNoOp = (item: string, into: string, copy: boolean): boolean => (!copy && dirname(item) === into) || isRootOrInside(item, into);

const isCrossDevice = (err: unknown): boolean => err instanceof Error && 'code' in err && err.code === 'EXDEV';

async function transfer(item: string, to: string, copy: boolean, fs: MoveFs): Promise<void> {
  if (copy) return fs.cp(item, to);
  try {
    await fs.rename(item, to);
  } catch (err) {
    if (!isCrossDevice(err)) throw err;
    // rename cannot cross volumes: a Finder file on another disk still moves
    await fs.cp(item, to).catch(async (cpErr: unknown) => {
      await fs.rm(to).catch(() => undefined); // best effort: do not leave half a copy under the free name
      throw cpErr;
    });
    await fs.rm(item).catch((rmErr: unknown) => {
      throw new Error(`copied to ${to}, but the original could not be removed: ${wordsOf(rmErr)}`);
    });
  }
}

export interface MoveJob { root: string; sources: string[]; into: string; copy: boolean; suffix: string }

/** What a drop answers (#818): each new path relative to the real root, and the item it came from, relative too unless it came from outside
 *  the tree (a Finder file); a skipped item is in neither. The tree's open tabs follow a move by them. */
export interface Moved { moved: string[]; from: string[] }

/** Every source into `into`, in order, each under a free name. The guards run on every source first, so a refusal moves nothing; an fs
 *  failure rejects, and the items before it stay moved (the tree's poll shows them). */
export async function moveItems(job: MoveJob, fs: MoveFs = MOVE_DISK): Promise<Moved | Refusal> {
  const folders = await rootsOf(job.root, fs);
  const into = await destination(folders, job.into, fs);
  if (typeof into !== 'string') return into;
  const checked = await Promise.all(job.sources.map((source) => sourceItem(folders, source, job.copy, fs)));
  const refused = checked.find((item): item is Refusal => typeof item !== 'string');
  if (refused) return refused;
  const done: Moved = { moved: [], from: [] }; // this call's own accumulator
  for (const item of outermost(checked.filter((c): c is string => typeof c === 'string'))) {
    if (isNoOp(item, into, job.copy)) continue;
    const isFolder = (await fs.stat(item)).isDirectory();
    // Probe then transfer can race: accepted, a single-user daemon whose concurrent agent writes the spec leaves unguarded
    const name = await freeName((n) => exists(fs, join(into, n)), basename(item), job.suffix, isFolder);
    await transfer(item, join(into, name), job.copy, fs);
    done.moved.push(relative(folders.realRoot, join(into, name)));
    done.from.push(isInside(folders.realRoot, item) ? relative(folders.realRoot, item) : item);
  }
  return done;
}

/** The drop's body (#594), rebuilt from the checked fields; undefined for anything else. */
export function moveBody(raw: unknown): { sources: string[]; into: string; copy: boolean } | undefined {
  const { sources, into, copy } = (raw ?? {}) as { sources?: unknown; into?: unknown; copy?: unknown };
  if (!Array.isArray(sources) || typeof into !== 'string' || typeof copy !== 'boolean') return undefined;
  const list: unknown[] = sources;
  const strings = list.filter((s): s is string => typeof s === 'string' && s !== '');
  return strings.length > 0 && strings.length === list.length ? { sources: strings, into, copy } : undefined;
}

const refuse = (res: Response, { status, message }: Refusal): void => {
  res.status(status).json({ error: message });
};

/** POST /activities/:id/tree/move (#594, #629): the drop on the files sidebar. The root is the tree's own (treeRoot); no value of the request
 *  picks it. Not /tasks/:id/move: that is the flow's reorder of a task (#122). */
export function registerMoveRoutes(app: Express, { requireLive, language }: Pick<TaskRouteDeps, 'requireLive' | 'language'>): void {
  app.post('/activities/:id/tree/move', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string);
    if (typeof root !== 'string') return refuse(res, root);
    const body = moveBody(req.body);
    if (!body) return refuse(res, refusal(HTTP_BAD_REQUEST, MOVE_BODY_MESSAGE));
    try {
      const moved = await moveItems({ root, ...body, suffix: COPY_SUFFIX[language()] });
      if ('status' in moved) refuse(res, moved);
      else res.json(moved);
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) }); // the fs error's words; the items before it stay moved
    }
  });
}
