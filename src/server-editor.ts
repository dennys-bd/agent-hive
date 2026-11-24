// The editor pane's routes (#717): a file as text, its version (of any bytes, #498), an image's bytes (#498), and a save that writes only over the version the pane last read. The
// folders are activityFolders'; the path resolves with resolveActivityPath (#697): any existing file, absolute or relative to the
// worktree (the workspace once it is gone), a symlink to its target. A deleted activity has no activity space to hold the pane: refused.
// The text routes: UTF-8 text only, up to EDITOR_FILE_MAX bytes: a lossy decode would corrupt the file on save.
import { createHash } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { activityParam, keptTarget } from './activity-routes.js';
import { decodeText } from './decode-text.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { detectFormatters } from './formatter-detect.js';
import { type FormatOutcome, formatForSave } from './format-run.js';
import { resolveActivityPath } from './ide.js';
import { inScope } from './languages.js';
import { type Machine, MachineError } from './machine.js';
import { whenAvailable } from './machines.js';
import { fileFs, machineCode } from './machine-fs.js';
import { activityFolders, MISSING_FILE_MESSAGE } from './server-files.js';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';
import { type Activity, type Config, EDITOR_FILE_MAX, type EditorConfig, type FileSaved, type FileText, FORMATTER_IDS, IMAGE_TYPES, type FormatterState, type Task, type Workspace } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_UNSUPPORTED = 415;
const HTTP_SERVER_ERROR = 500;
const DELETED_MESSAGE = 'a atividade foi apagada';
const TOO_LARGE_MESSAGE = 'arquivo grande demais para o editor';
const BINARY_MESSAGE = 'arquivo binário ou fora de UTF-8';
const READ_ONLY_MESSAGE = 'arquivo somente leitura';
const OWNER_WRITE = 0o200;
const CHANGED_MESSAGE = 'o arquivo mudou no disco';
const PATH_MESSAGE = 'path must be a non-empty string';
const SAVE_BODY_MESSAGE = 'path must be a non-empty string, text and version strings, format a boolean';

/** The file's route (#717): GET reads it, PUT saves it; server.ts mounts the 413 of a body express.json refuses on it. */
export const EDITOR_FILE_ROUTE = '/activities/:id/file';

type Live = NonNullable<ReturnType<TaskRouteDeps['requireLive']>>;
/** An image's or a design asset's cap (#160): both are read whole on their machine, which has no stream. ponytail: an image over it no
 *  longer opens (it did through sendFile); a streamed read on MachineFs if one ever must. */
export const IMAGE_MAX = 64 * 1024 * 1024;
type MachineFor = TaskRouteDeps['machineFor'];
interface Text { bytes: Buffer; text: string }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (res: Response, { status, message }: Refusal): void => {
  res.status(status).json({ error: message });
};
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The real path of an activity's file and what its routes need around it (#717, #749, #668): the folder git and a formatter run in (the
 * worktree; the checkout for a local activity), the workspace whose format applies, the run header's head, and the activity and its task. */
export interface Located { file: string; folder: string; workspace?: Workspace; label: string; activity: Activity; task?: Task; machine: Machine }

const workspaceOf = (config: Pick<Config, 'comb'>, target: { activity?: Activity; task?: Task }): Workspace | undefined =>
  (target.task ? taskWorkspace(config, target.task) : workspaceByName(config, target.activity?.workspace));

/** The real path of the activity's file, or why there is none: an unknown activity (404), a deleted one (409), no path (400) or no such
 * file (404). No inside check (#697): the preview and the editor open any file, as the ponytail on resolveActivityPath says. The base route
 * locates its file here too (#668). */
export async function locate(current: Live, id: string, path: unknown, machineFor: MachineFor): Promise<Located | Refusal> {
  const target = keptTarget(current.state, id);
  if ('status' in target) return target;
  if (target.activity === undefined) return { status: HTTP_CONFLICT, message: DELETED_MESSAGE };
  if (typeof path !== 'string' || path === '') return { status: HTTP_BAD_REQUEST, message: PATH_MESSAGE };
  const { config } = current.runtime;
  const machine = machineFor(target.activity);
  const folders = activityFolders(config, target, machine.paths);
  if ('status' in folders) return folders;
  const resolved = await resolveActivityPath({ ...folders, path, ...fileFs(machine) });
  if ('reason' in resolved) return { status: HTTP_NOT_FOUND, message: MISSING_FILE_MESSAGE };
  const { activity, task } = target;
  const label = task ? `#${task.item.id}` : activity.workspace; // [Q2]: a local activity has no task
  return { file: resolved.file, folder: folders.worktree ?? folders.workspace, workspace: workspaceOf(config, target), label, activity, machine, ...(task ? { task } : {}) };
}

// A capped read's refusal, as these routes answered before (#160): over the cap 413, not a regular file the missing file's 404; else it throws (500)
function readRefusal(err: unknown): Refusal {
  const code = machineCode(err);
  if (code === MachineError.TOO_LARGE) return { status: HTTP_TOO_LARGE, message: TOO_LARGE_MESSAGE };
  if (code === MachineError.NOT_FILE) return { status: HTTP_NOT_FOUND, message: MISSING_FILE_MESSAGE };
  throw err;
}

// The file as the pane holds it, or the 413 / 415 that says why it cannot. The cap is checked on the machine, so there is no stat first
async function readText(machine: Machine, file: string): Promise<Text | Refusal> {
  const bytes = await machine.fs.readFile(file, { maxBytes: EDITOR_FILE_MAX }).catch(readRefusal);
  if (!Buffer.isBuffer(bytes)) return bytes;
  const text = decodeText(bytes);
  return text === undefined ? { status: HTTP_UNSUPPORTED, message: BINARY_MESSAGE } : { bytes, text };
}

// GET's steps: the file located, then read as text
async function withText(req: Request, res: Response, current: Live, machineFor: MachineFor, answer: (read: Text, path: string) => void): Promise<void> {
  const located = await locate(current, activityParam(req), req.query.path, machineFor);
  if ('status' in located) return refuse(res, located);
  const read = await readText(located.machine, located.file);
  if ('status' in read) return refuse(res, read);
  answer(read, String(req.query.path));
}

const imageType = (path: unknown, paths: Machine['paths']): string | undefined => IMAGE_TYPES[paths.extname(String(path)).toLowerCase()];

// An image's bytes (#498), read once on its machine under IMAGE_MAX: what the image route sends and the version hashes
const readImage = (located: Located): Promise<Buffer | Refusal> => located.machine.fs.readFile(located.file, { maxBytes: IMAGE_MAX }).catch(readRefusal);

// file-version: an image path's version is the hash of any bytes, any size, for its tab's reload (#498); a text path keeps the text read's
// 413 / 415, so a text pane whose file grew past the cap or turned binary sees no new version it could never reload. Located first: the
// path's type is read with its machine's paths (#929)
async function fileVersion(req: Request, res: Response, current: Live, machineFor: MachineFor): Promise<void> {
  const located = await locate(current, activityParam(req), req.query.path, machineFor);
  if ('status' in located) return refuse(res, located);
  const isImage = imageType(req.query.path, located.machine.paths) !== undefined;
  const read = isImage ? await readImage(located) : await readText(located.machine, located.file);
  if ('status' in read) return refuse(res, read);
  res.json({ version: sha256(Buffer.isBuffer(read) ? read : read.bytes) });
}

// decision 10 of #498: an <img> never runs an SVG's scripts, and sandbox keeps them from running if the URL is ever opened as a page
const IMAGE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' };

// The image's bytes (#498), up to IMAGE_MAX: they go to an <img>, never into a JSON body or a Monaco model, so the 1 MB cap's reason does not
// apply. The type comes from the path the tab asked with, the one the page chose the view by
async function sendImage(req: Request, res: Response, current: Live, machineFor: MachineFor): Promise<void> {
  const located = await locate(current, activityParam(req), req.query.path, machineFor);
  if ('status' in located) return refuse(res, located);
  const type = imageType(req.query.path, located.machine.paths);
  if (type === undefined) return refuse(res, { status: HTTP_UNSUPPORTED, message: BINARY_MESSAGE });
  const bytes = await readImage(located);
  if (!Buffer.isBuffer(bytes)) return refuse(res, bytes);
  res.set({ ...IMAGE_HEADERS, 'Content-Type': type }).send(bytes);
}

interface SaveBody { path: string; text: string; version: string; format: boolean }
type Store = TaskRouteDeps['consoleStore'];

function saveBody(raw: unknown): SaveBody | undefined {
  const { path, text, version, format } = (raw ?? {}) as Record<string, unknown>;
  const isValid = typeof path === 'string' && path !== '' && typeof text === 'string' && typeof version === 'string' && typeof format === 'boolean';
  return isValid ? { path, text, version, format } : undefined;
}

const DRAWIO_EXTENSION = '.drawio';
// #956: draw.io's own XML is the file's canonical form; a formatter would reflow what the diagram pane writes back, and a ⌘S in the editor
// pane must not reformat it either
const isDrawio = (file: string, paths: Machine['paths']): boolean => paths.extname(file).toLowerCase() === DRAWIO_EXTENSION;

// #749, #780, #956: the formatter's run when the pane asked for it and format on save covers the workspace; undefined sends the text as typed, always for a .drawio
function formatted(located: Located, body: SaveBody, consoleStore: Store, editor: EditorConfig): Promise<FormatOutcome | undefined> {
  const { workspace } = located;
  const isOn = editor.formatOnSave.enabled && workspace !== undefined && inScope(editor.formatOnSave.workspaces, workspace.name);
  if (!body.format || !isOn || workspace === undefined || isDrawio(located.file, located.machine.paths)) return Promise.resolve(undefined);
  return formatForSave(editor, body.text, { machine: located.machine, cwd: located.folder, file: located.file, workspace, label: `${located.label} · ${body.path}`, consoleStore });
}

// The answer (#749): the formatted text only when it differs from what was sent; a failure's reason and its console run
function savedAnswer(version: string, sent: string, outcome: FormatOutcome | undefined): FileSaved {
  if (outcome === undefined) return { version };
  if ('error' in outcome) return { version, formatError: outcome.error, formatLog: outcome.log };
  return outcome.text === sent ? { version } : { version, text: outcome.text };
}

// A save (#717): the body checked, the file resolved, the text formatted when asked (#749), then the file's bytes hashed against the version the
// pane read; another one answers 409 with it. The format runs before the hash, so nothing touches the disk before the version check.
// ponytail: the hash is checked, then the rename lands, so an agent writing in between is overwritten; no file lock exists and the window is
// a few ms. A lock (or a compare in a rename loop) when it ever bites.
async function saveFile(res: Response, current: Live, id: string, raw: unknown, { consoleStore, machineFor }: { consoleStore: Store; machineFor: MachineFor }): Promise<void> {
  const body = saveBody(raw);
  if (body === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: SAVE_BODY_MESSAGE });
  if (Buffer.byteLength(body.text, 'utf8') > EDITOR_FILE_MAX) return refuse(res, { status: HTTP_TOO_LARGE, message: TOO_LARGE_MESSAGE });
  const located = await locate(current, id, body.path, machineFor);
  if ('status' in located) return refuse(res, located);
  const { size, mode } = await located.machine.fs.stat(located.file);
  if (size > EDITOR_FILE_MAX) return refuse(res, { status: HTTP_TOO_LARGE, message: TOO_LARGE_MESSAGE }); // never read what the pane could not have opened
  if ((mode & OWNER_WRITE) === 0) return refuse(res, { status: HTTP_CONFLICT, message: READ_ONLY_MESSAGE }); // the rename would replace what its owner marked unwritable
  const outcome = await formatted(located, body, consoleStore, current.runtime.config.editor);
  const text = outcome !== undefined && 'text' in outcome ? outcome.text : body.text;
  // A file that grew past the cap or turned into a folder since the stat answers as a read of it would, not a 500
  const read = await located.machine.fs.readFile(located.file, { maxBytes: EDITOR_FILE_MAX }).catch(readRefusal);
  if (!Buffer.isBuffer(read)) return refuse(res, read);
  const onDisk = sha256(read);
  if (onDisk !== body.version) {
    res.status(HTTP_CONFLICT).json({ error: CHANGED_MESSAGE, version: onDisk });
    return;
  }
  res.json(savedAnswer(sha256(await located.machine.fs.writeAtomic(located.file, text)), body.text, outcome));
}

type Handler = (req: Request, res: Response, current: Live) => Promise<void>;

// Settings > editor's detection (#780): every supported formatter, detected on each workspace's checkout as a save in its local activity
// would detect it; a worktree may hold its own node_modules, which this does not look at
async function formatterStates(_req: Request, res: Response, current: Live, machineFor: MachineFor): Promise<void> {
  // #932: each checkout on its workspace's machine; one whose machine is unavailable detects nothing
  const found = await Promise.all(current.runtime.config.comb.workspaces.map(async (w) => ({ name: w.name, binaries: await whenAvailable(() => detectFormatters(machineFor(w), w.path, FORMATTER_IDS), {}) })));
  const states: FormatterState[] = FORMATTER_IDS.map((id) => ({ id, found: found.filter((f) => f.binaries[id] !== undefined).map((f) => f.name) }));
  res.json(states);
}

/** The editor pane's routes (#717) and Settings > editor's detected formatters (#749), behind the same requireLive as files. Whatever the disk throws answers 500 with its message. */
export function registerEditorRoutes(app: Express, { requireLive, consoleStore, machineFor }: Pick<TaskRouteDeps, 'requireLive' | 'consoleStore' | 'machineFor'>): void {
  const route = (handle: Handler) => async (req: Request, res: Response): Promise<void> => {
    const current = requireLive(res);
    if (!current) return;
    try {
      await handle(req, res, current);
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
    }
  };
  app.get(EDITOR_FILE_ROUTE, route((req, res, current) => withText(req, res, current, machineFor, ({ bytes, text }, path) => {
    const body: FileText = { path, text, version: sha256(bytes) };
    res.json(body);
  })));
  app.get('/activities/:id/file-version', route((req, res, current) => fileVersion(req, res, current, machineFor)));
  app.get('/activities/:id/image', route((req, res, current) => sendImage(req, res, current, machineFor)));
  app.get('/settings/formatters', route((req, res, current) => formatterStates(req, res, current, machineFor)));
  app.put(EDITOR_FILE_ROUTE, route((req, res, current) => saveFile(res, current, activityParam(req), req.body, { consoleStore, machineFor })));
}

/** express.json's refusal of a body over its 2 MB limit (server.ts), on the editor's save: the cap's own 413 instead of Express's HTML page. */
export function editorBodyTooLarge(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (typeof err === 'object' && err !== null && (err as { type?: unknown }).type === 'entity.too.large') {
    res.status(HTTP_TOO_LARGE).json({ error: TOO_LARGE_MESSAGE });
    return;
  }
  next(err);
}
