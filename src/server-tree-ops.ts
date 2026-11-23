// The files tree's own operations (#818): a new file or folder, a rename, the trash, and an untitled file's first save. Every path goes
// through tree/move's guards (tree-paths.ts): relative to the tree's root, inside it as written and as real, never under .git. Every disk
// touch goes through TreeFs, so a test could fake one.
import type { Express, Request, Response } from 'express';
import type { Machine } from './machine.js';
import { isInside } from './ide.js';
import { trashCommand } from './platform-commands.js';
import { pathFs, treeFs } from './machine-fs.js';
import { sha256 } from './server-editor.js';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';
import { treeMachine, treeRoot } from './server-tree.js';
import { existingItem, exists, newItem, outermost, type PathFs, refusal, rootsOf } from './tree-paths.js';
import { EDITOR_FILE_MAX } from './types.js';
import { toWire } from './wire-path.js';
import { wordsOf } from './worktree.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_SERVER_ERROR = 500;
const HTTP_NO_CONTENT = 204;
export const TAKEN_MESSAGE = 'a file or folder with this name already exists';
export const INTO_ITSELF_MESSAGE = 'a folder cannot move into itself';
export const IS_FOLDER_MESSAGE = 'a folder already has this name';
export const TOO_LARGE_MESSAGE = 'file too large for the editor';
export const CREATE_BODY_MESSAGE = "body must be { path: non-empty string, kind: 'file' | 'folder' }";
export const RENAME_BODY_MESSAGE = 'body must be { from: non-empty string, to: non-empty string }';
export const TRASH_BODY_MESSAGE = 'body must be { paths: non-empty strings }';
export const FILE_BODY_MESSAGE = 'body must be { path: absolute string, text: string, replace: boolean }';

export interface TreeFs extends PathFs {
  mkdirs(path: string): Promise<void>; // recursive: the folders a name with / adds
  mkdir(path: string): Promise<void>; // one folder; EEXIST when the name is taken
  writeNew(path: string, text: string): Promise<void>; // flag wx: EEXIST when the name is taken, a dangling symlink included
  replace(path: string, text: string): Promise<void>; // the editor's atomic write over an existing file
  rename(from: string, to: string): Promise<void>;
  sameFile(a: string, b: string): Promise<boolean>; // one inode: a case-insensitive volume resolves `A.ts` to `a.ts`, a case-sensitive one does not
}

const isTaken = (err: unknown): boolean => err instanceof Error && 'code' in err && err.code === 'EEXIST';
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'status' in value && 'message' in value;

/** A new empty file or folder at `path` (#818): the folders between made first; a taken name is refused, never overwritten. Its path,
 *  relative to the real root, `/`-separated on the wire (#641). */
export async function createItem({ root, path, kind, platform }: { root: string; path: string; kind: 'file' | 'folder'; platform: NodeJS.Platform }, fs: TreeFs): Promise<string | Refusal> {
  const roots = await rootsOf(root, fs);
  const target = await newItem(roots, path, fs);
  if (typeof target !== 'string') return target;
  await fs.mkdirs(fs.paths.dirname(target));
  try {
    await (kind === 'file' ? fs.writeNew(target, '') : fs.mkdir(target));
  } catch (err) {
    if (isTaken(err)) return refusal(HTTP_CONFLICT, TAKEN_MESSAGE);
    throw err;
  }
  return toWire(fs.paths.relative(roots.realRoot, target), platform);
}

/** An item renamed or moved to `to` (#818), the folders `to` adds made first. A taken name is refused, unless it is the item itself under
 *  another case on a case-insensitive volume (APFS's `a.ts` → `A.ts`, decided by inode); a folder never moves into itself. Its new path, relative to the real root, `/`-separated on the wire (#641). */
export async function renameItem({ root, from, to, platform }: { root: string; from: string; to: string; platform: NodeJS.Platform }, fs: TreeFs): Promise<string | Refusal> {
  const roots = await rootsOf(root, fs);
  const item = await existingItem(roots, from, fs);
  if (typeof item !== 'string') return item;
  const target = await newItem(roots, to, fs);
  if (typeof target !== 'string') return target;
  if (isInside(item, target, fs.paths)) return refusal(HTTP_BAD_REQUEST, INTO_ITSELF_MESSAGE);
  // ponytail: probe then rename can race a worker's write, as tree/move accepts for a single-user daemon
  const isSameItem = await fs.sameFile(item, target);
  if (!isSameItem && (await exists(fs, target))) return refusal(HTTP_CONFLICT, TAKEN_MESSAGE);
  await fs.mkdirs(fs.paths.dirname(target));
  await fs.rename(item, target);
  return toWire(fs.paths.relative(roots.realRoot, target), platform);
}

/** The items to the system trash (#818): every path checked first, so a refusal trashes nothing; then one trashCommand run with each
 *  outermost item. undefined once run; `run` rejects with the command's words. */
export async function trashItems(
  root: string, paths: string[], run: (file: string, args: readonly string[]) => Promise<unknown>, fs: PathFs, platform: NodeJS.Platform,
): Promise<Refusal | undefined> {
  const roots = await rootsOf(root, fs);
  const checked = await Promise.all(paths.map((path) => existingItem(roots, path, fs)));
  const refused = checked.find(isRefusal);
  if (refused) return refused;
  const [file, args] = trashCommand(platform, outermost(checked.filter((c): c is string => typeof c === 'string'), fs.paths));
  await run(file, args);
  return undefined;
}

/** An untitled buffer's first save (#818): `path` is the OS dialog's, absolute, and must lie in the tree as written or as real; never under
 *  .git. A taken path is refused unless `replace` (the dialog's own Replace? was answered). A new file is written with wx, a replaced one
 *  atomically, as the editor saves. Its path relative to the real root, `/`-separated on the wire (#641), and the written bytes' version. */
export async function saveNewFile({ root, path, text, replace, platform }: { root: string; path: string; text: string; replace: boolean; platform: NodeJS.Platform }, fs: TreeFs): Promise<{ path: string; version: string } | Refusal> {
  if (Buffer.byteLength(text, 'utf8') > EDITOR_FILE_MAX) return refusal(HTTP_TOO_LARGE, TOO_LARGE_MESSAGE);
  const roots = await rootsOf(root, fs);
  const target = await newItem(roots, fs.paths.relative(isInside(roots.realRoot, path, fs.paths) ? roots.realRoot : roots.root, path), fs);
  if (typeof target !== 'string') return target;
  const held = await fs.stat(target).catch(() => undefined);
  if (held?.isDirectory()) return refusal(HTTP_CONFLICT, IS_FOLDER_MESSAGE); // a folder is never replaced, and writing over one would be a raw 500
  const isReplaced = held !== undefined;
  if (isReplaced && !replace) return refusal(HTTP_CONFLICT, TAKEN_MESSAGE);
  try {
    await (isReplaced ? fs.replace(target, text) : fs.writeNew(target, text));
  } catch (err) {
    if (isTaken(err)) return refusal(HTTP_CONFLICT, TAKEN_MESSAGE); // created between the probe and the write
    throw err;
  }
  return { path: toWire(fs.paths.relative(roots.realRoot, target), platform), version: sha256(Buffer.from(text, 'utf8')) };
}

function createBody(raw: unknown): { path: string; kind: 'file' | 'folder' } | undefined {
  const { path, kind } = (raw ?? {}) as { path?: unknown; kind?: unknown };
  return isText(path) && (kind === 'file' || kind === 'folder') ? { path, kind } : undefined;
}

function renameBody(raw: unknown): { from: string; to: string } | undefined {
  const { from, to } = (raw ?? {}) as { from?: unknown; to?: unknown };
  return isText(from) && isText(to) ? { from, to } : undefined;
}

function trashBody(raw: unknown): string[] | undefined {
  const { paths } = (raw ?? {}) as { paths?: unknown };
  if (!Array.isArray(paths)) return undefined;
  const list: unknown[] = paths;
  return list.length > 0 && list.every(isText) ? (list as string[]) : undefined;
}

function fileBody(raw: unknown, paths: TreeFs['paths']): { path: string; text: string; replace: boolean } | undefined {
  const { path, text, replace } = (raw ?? {}) as { path?: unknown; text?: unknown; replace?: unknown };
  return isText(path) && paths.isAbsolute(path) && typeof text === 'string' && typeof replace === 'boolean' ? { path, text, replace } : undefined;
}

const refuse = (res: Response, { status, message }: Refusal): void => {
  res.status(status).json({ error: message });
};

// What every route shares: the live state, the tree's root from the activity (never from the request), then the route's own steps;
// whatever the disk or a command throws answers 500 with its words
function treeRoute(app: Express, name: string, { requireLive, machineFor }: Pick<TaskRouteDeps, 'requireLive' | 'machineFor'>, handle: (res: Response, root: string, body: unknown, machine: Machine) => Promise<void>): void {
  app.post(`/activities/:id/${name}`, async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string);
    if (typeof root !== 'string') return refuse(res, root);
    try {
      await handle(res, root, req.body, treeMachine(current.state, req.params.id as string, machineFor));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) });
    }
  });
}

/** POST /activities/:id/tree/create, /tree/rename, /tree/trash and /tree/file (#818): the files tree's own operations, beside tree/move. */
export function registerTreeOpsRoutes(app: Express, deps: Pick<TaskRouteDeps, 'requireLive' | 'machineFor'>): void {
  treeRoute(app, 'tree/create', deps, async (res, root, raw, machine) => {
    const body = createBody(raw);
    if (!body) return refuse(res, refusal(HTTP_BAD_REQUEST, CREATE_BODY_MESSAGE));
    const path = await createItem({ root, ...body, platform: machine.info().platform }, treeFs(machine));
    if (isRefusal(path)) refuse(res, path);
    else res.json({ path });
  });
  treeRoute(app, 'tree/rename', deps, async (res, root, raw, machine) => {
    const body = renameBody(raw);
    if (!body) return refuse(res, refusal(HTTP_BAD_REQUEST, RENAME_BODY_MESSAGE));
    const path = await renameItem({ root, ...body, platform: machine.info().platform }, treeFs(machine));
    if (isRefusal(path)) refuse(res, path);
    else res.json({ path });
  });
  treeRoute(app, 'tree/trash', deps, async (res, root, raw, machine) => {
    const paths = trashBody(raw);
    if (!paths) return refuse(res, refusal(HTTP_BAD_REQUEST, TRASH_BODY_MESSAGE));
    const refused = await trashItems(root, paths, (file, args) => machine.exec(file, [...args]), pathFs(machine), machine.info().platform);
    if (refused) refuse(res, refused);
    else res.status(HTTP_NO_CONTENT).end();
  });
  treeRoute(app, 'tree/file', deps, async (res, root, raw, machine) => {
    const body = fileBody(raw, machine.paths);
    if (!body) return refuse(res, refusal(HTTP_BAD_REQUEST, FILE_BODY_MESSAGE));
    const saved = await saveNewFile({ root, ...body, platform: machine.info().platform }, treeFs(machine));
    if (isRefusal(saved)) refuse(res, saved);
    else res.json(saved);
  });
}
