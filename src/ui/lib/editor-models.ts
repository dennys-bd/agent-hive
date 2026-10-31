// The editor pane's open files (#717): one Monaco model per activity and path, at module level, so the edits outlive the center unmounting
// (another activity shown) and go only when their tab closes or their activity does. Monaco itself loads with the first file opened (import()),
// so a test that opens none never loads it.
import type { editor } from 'monaco-editor';
import { type FileSaved, type FileText, type FormatLog, IMAGE_TYPES } from '../../types';
import { gated } from './api.js';
import { moved as moveBase } from './file-base.js';
import { renamedPath } from './file-tree.js';

const HTTP_CONFLICT = 409;

/** Where a click puts the cursor (#717): a terminal's link carries a line, and maybe a column. */
export interface FileAt { line: number; col?: number }

/** A read the pane cannot show (#717): the route's status, which the pane names in its own words, and the server's message. */
export class FileError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A save's outcome (#717, #749): written (with a failed format's reason and console run), refused because the disk moved on (with the disk's
 * version), or failed with the server's words. */
export type SaveResult =
  | { status: 'saved'; formatError?: string; formatLog?: FormatLog }
  | { status: 'conflict'; version: string }
  | { status: 'error'; message: string };

/** What reload keeps of an editor across its edit (#717): the cursor and the scroll. */
export interface KeptView { saveViewState(): unknown; restoreViewState(state: unknown): void }

/** What a reveal moves (#717), and what a moved tab's view state is read from and restored to (#551): the pane's editor. */
export interface RevealView extends KeptView {
  setPosition(position: { lineNumber: number; column: number }): void;
  revealPositionInCenter(position: { lineNumber: number; column: number }): void;
  focus(): void;
}

// base: the disk's version the buffer was last read or saved over. savedVersionId: the model's alternative version id at that moment, so an
// undo back to it reads clean again
interface Entry { activityId: string; path: string; model: editor.ITextModel; base: string; savedVersionId: number }

const entries = new Map<string, Entry>();
const loading = new Map<string, Promise<editor.ITextModel>>(); // a second open while the first reads (StrictMode's double effect) waits for it
const cancelled = new Set<string>(); // keys whose tab closed while their read flew: the read's model is disposed, not registered
const BOM = '\uFEFF';
const listeners = new Set<() => void>();
const views = new Map<string, RevealView>();
const pending = new Map<string, FileAt>(); // a reveal asked while no pane shows the file
const pendingViews = new Map<string, object>(); // a moved tab's view state while no pane shows the file yet (#551)
const NEVER_SAVED = -1; // an alternative version id no model reaches: a moved buffer reads dirty even undone to its first text (#551)
const UNTITLED = '\0untitled-'; // NUL never appears in a path, so an untitled buffer's key never meets a file's (#818)
const NO_FILE: FileText = { path: '', text: '', version: '' };
let untitledCount = 0; // the page's count, as VS Code's Untitled-N

/** An untitled buffer's path in the store (#818). */
export const untitledPath = (n: number): string => `${UNTITLED}${n}`;
export const isUntitledPath = (path: string): boolean => path.startsWith(UNTITLED);

/** The next untitled tab's number (#818). */
export function nextUntitled(): number {
  untitledCount += 1;
  return untitledCount;
}

const keyOf = (activityId: string, path: string): string => `${activityId}:${path}`;
const entryOf = (activityId: string, path: string): Entry | undefined => entries.get(keyOf(activityId, path));
const isEntryDirty = (entry: Entry): boolean => entry.model.getAlternativeVersionId() !== entry.savedVersionId;
type Route = 'file' | 'file-version' | 'image';
const activityRoute = (activityId: string, name: Route): string => `/activities/${encodeURIComponent(activityId)}/${name}`;
const notify = (): void => {
  for (const listener of listeners) listener();
};

/** A file's read, version or image route (#717, #498), the path in the query. */
export const fileUrl = (activityId: string, path: string, name: Route = 'file'): string =>
  `${activityRoute(activityId, name)}?${new URLSearchParams({ path })}`;

// A refused read (#717): the route's status and the server's words, its status text when the body has none
async function refusal(res: Response): Promise<FileError> {
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  return new FileError(res.status, error ?? res.statusText);
}

/** A file's text and version from the disk (#717); a refused read rejects with a FileError. The preview pane reads through it too (#697). */
export async function readFile(activityId: string, path: string): Promise<FileText> {
  const res = await fetch(fileUrl(activityId, path));
  if (res.ok) return (await res.json()) as FileText;
  throw await refusal(res);
}

/** An image's bytes from the disk (#498), for the image view's object URL; a refused read rejects with a FileError. */
export async function readImage(activityId: string, path: string): Promise<Blob> {
  const res = await fetch(fileUrl(activityId, path, 'image'));
  if (res.ok) return res.blob();
  throw await refusal(res);
}

type Languages = ReadonlyArray<{ id: string; extensions?: string[]; filenames?: string[] }>;

const nameOf = (path: string): string => path.split('/').at(-1) ?? path;
// The name's extension, lower case with its dot; none for a name that only starts with one (.gitignore)
function extensionOf(path: string): string {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Whether the file tab shows the file as an image (#498): by its extension, as the image route answers it. */
export const isImagePath = (path: string): boolean => Object.hasOwn(IMAGE_TYPES, extensionOf(path));

// Monaco's language for the file: by its name (Dockerfile), else by its extension; plaintext for neither (#319: the skill editor's files too)
export function languageOf(languages: Languages, path: string): string {
  const name = nameOf(path);
  const extension = extensionOf(path);
  return languages.find((l) => l.filenames?.includes(name) || (extension !== '' && l.extensions?.includes(extension)))?.id ?? 'plaintext';
}

let monacoLoad: Promise<typeof import('@/lib/monaco')> | undefined;
/** Monaco's setup (#717), imported once for every model and editor: two import() calls in flight at once never settled the second under
 * vitest's mocked module, and one shared promise is no worse in the app. */
export const loadMonaco = (): Promise<typeof import('@/lib/monaco')> => (monacoLoad ??= import('@/lib/monaco'));

// The model over `file` under its key (#717), unless its tab closed while it was made; clean, or dirty from the start with NEVER_SAVED (#551)
function register(setup: Awaited<ReturnType<typeof loadMonaco>>, activityId: string, path: string, file: FileText, savedVersionId?: number): editor.ITextModel {
  const model = setup.monaco.editor.createModel(file.text, languageOf(setup.monaco.languages.getLanguages(), path));
  if (cancelled.delete(keyOf(activityId, path))) {
    model.dispose();
    throw new Error('closed while loading');
  }
  setup.applySyntaxFor(model, path); // #780: a syntax package, when one is installed
  model.onDidChangeContent(notify);
  entries.set(keyOf(activityId, path), { activityId, path, model, base: file.version, savedVersionId: savedVersionId ?? model.getAlternativeVersionId() });
  notify();
  return model;
}

async function create(activityId: string, path: string): Promise<editor.ITextModel> {
  const [setup, file] = await Promise.all([loadMonaco(), isUntitledPath(path) ? Promise.resolve(NO_FILE) : readFile(activityId, path)]); // #818: no file behind an untitled one
  return register(setup, activityId, path, file);
}

/** The file's model (#717): read and created on the first open, the same one after; a refused read rejects with a FileError. */
export function open(activityId: string, path: string): Promise<editor.ITextModel> {
  const key = keyOf(activityId, path);
  const entry = entries.get(key);
  if (entry !== undefined) return Promise.resolve(entry.model);
  cancelled.delete(key); // a reopen after a close starts clean
  const inFlight = loading.get(key) ?? create(activityId, path).finally(() => loading.delete(key));
  loading.set(key, inFlight);
  return inFlight;
}

export const isDirty = (activityId: string, path: string): boolean => {
  const entry = entryOf(activityId, path);
  return entry !== undefined && isEntryDirty(entry);
};

/** Whether any buffer holds unsaved edits (#717): what the page's beforeunload asks. */
export const anyDirty = (): boolean => [...entries.values()].some(isEntryDirty);

/** The disk's version the buffer stands on (#717); undefined for a file not open. */
export const baseOf = (activityId: string, path: string): string | undefined => entryOf(activityId, path)?.base;

/** The buffer's text while an editor pane holds the file (#697): what its preview renders, unsaved edits included; undefined otherwise.
 * subscribe notifies on every edit, open and close. */
export const textOf = (activityId: string, path: string, withBom = false): string | undefined => entryOf(activityId, path)?.model.getValue(undefined, withBom);

// The entry with its new base and clean point, unless it closed meanwhile
function settle(activityId: string, path: string, change: Pick<Entry, 'base' | 'savedVersionId'>): void {
  const key = keyOf(activityId, path);
  const entry = entries.get(key);
  if (entry === undefined) return;
  entries.set(key, { ...entry, ...change });
  notify();
}

// The text into the model as one undoable edit, the view's cursor and scroll kept (#717, #749). The model holds a leading BOM apart from its
// text (save writes it back), so the edit never carries it in
function replaceText(model: editor.ITextModel, text: string, view?: KeptView): void {
  const state = view?.saveViewState();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: text.startsWith(BOM) ? text.slice(1) : text }], () => null);
  view?.restoreViewState(state);
}

// A save's settling (#749): a formatted text replaces a buffer left as it was sent and reads clean; one typed in meanwhile keeps its text,
// dirty on the written version
function settleSaved(entry: Entry, sent: number, answer: FileSaved, view?: KeptView): void {
  const { activityId, path, model } = entry;
  const base = answer.version;
  if (answer.text === undefined) settle(activityId, path, { base, savedVersionId: sent });
  else if (model.getAlternativeVersionId() !== sent) settle(activityId, path, { base, savedVersionId: entry.savedVersionId });
  else {
    replaceText(model, answer.text, view);
    settle(activityId, path, { base, savedVersionId: model.getAlternativeVersionId() });
  }
}

/** fetch itself, not sendJson, whose error would drop the 409's version; the headers are sendJson's, x-hive-ui being the CSRF gate. What is
 * typed while the PUT flies stays dirty. */
async function put(activityId: string, path: string, format: boolean, view?: KeptView): Promise<SaveResult> {
  const sending = entryOf(activityId, path);
  if (sending === undefined) return { status: 'saved' }; // closed meanwhile: nothing left to write
  const sent = sending.model.getAlternativeVersionId();
  const res = await fetch(activityRoute(activityId, 'file'), {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' },
    body: JSON.stringify({ path, text: sending.model.getValue(undefined, true), version: sending.base, format }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<FileSaved> & { error?: string };
  if (res.status === HTTP_CONFLICT && body.version !== undefined) return { status: 'conflict', version: body.version };
  if (!res.ok || body.version === undefined) return { status: 'error', message: body.error ?? res.statusText };
  const entry = entryOf(activityId, path); // re-read: a tab closed while the PUT flew disposed its model
  if (entry !== undefined) settleSaved(entry, sent, { ...body, version: body.version }, view);
  const { formatError, formatLog } = body;
  return formatError !== undefined && formatLog !== undefined ? { status: 'saved', formatError, formatLog } : { status: 'saved' };
}

/** Writes the buffer over the version it stands on (#717), formatted on the server when `format` (#749), behind run mode's gate (#469): the
 * buffer is read once the write is allowed, so what the user typed while asked is what goes out. */
export const save = (activityId: string, path: string, format: boolean, view?: KeptView): Promise<SaveResult> =>
  gated(activityRoute(activityId, 'file'), () => put(activityId, path, format, view));

/** A reload's outcome (#717): the buffer took the disk's text, or was typed in while the read flew and kept it (the disk's version to offer). */
export type ReloadResult = { status: 'reloaded' } | { status: 'changed'; version: string };

/** The disk's text into the buffer as one undoable edit (#717), the view's cursor and scroll kept; clean on the disk's version. Text typed
 * while the read flew is never replaced: the result says `changed` and the pane raises its strip instead. */
export async function reload(activityId: string, path: string, view?: KeptView): Promise<ReloadResult> {
  const typedAt = entryOf(activityId, path)?.model.getAlternativeVersionId();
  const file = await readFile(activityId, path);
  const entry = entryOf(activityId, path);
  if (entry === undefined) return { status: 'reloaded' }; // closed meanwhile: nothing left to update
  if (entry.model.getAlternativeVersionId() !== typedAt) return { status: 'changed', version: file.version };
  replaceText(entry.model, file.text, view);
  settle(activityId, path, { base: file.version, savedVersionId: entry.model.getAlternativeVersionId() });
  return { status: 'reloaded' };
}

/** Keeps the buffer over a disk that moved on (#717): `version` becomes its base, so the next save overwrites it; still dirty. */
export function keepMine(activityId: string, path: string, version: string): void {
  const entry = entryOf(activityId, path);
  if (entry !== undefined) settle(activityId, path, { base: version, savedVersionId: entry.savedVersionId });
}

/** A moved tab's buffer on this page (#551): a new model with the carried text over the carried base, or, for a file already open here (a
 *  changes tab that stayed), the text as one undoable edit and the base its own, as adopt does, so a pane showing it keeps a live model.
 *  Dirty either way. A read already flying lands first, so it never replaces the carried text. */
export async function seed(activityId: string, path: string, text: string, base: string): Promise<void> {
  const key = keyOf(activityId, path);
  await loading.get(key)?.catch(() => undefined); // a refused read leaves no model: the seed makes one below
  const entry = entries.get(key);
  if (entry !== undefined) {
    replaceText(entry.model, text, views.get(key));
    settle(activityId, path, { base, savedVersionId: NEVER_SAVED });
    return;
  }
  cancelled.delete(key);
  const made = loadMonaco().then((setup) => register(setup, activityId, path, { path, text, version: base }, NEVER_SAVED)).finally(() => loading.delete(key));
  loading.set(key, made); // an open asked meanwhile waits for this model instead of reading the disk
  await made;
}

/** The attached editor's view state (#551): selections, folding and scroll, opaque; undefined while no pane shows the file. */
export function viewOf(activityId: string, path: string): object | undefined {
  const state = views.get(keyOf(activityId, path))?.saveViewState();
  return typeof state === 'object' && state !== null ? state : undefined; // Monaco answers null for an editor with no model
}

/** A moved tab's view state back on its editor (#551): at once while a pane shows the file, else when one next attaches, as a reveal waits. */
export function restoreView(activityId: string, path: string, state: object): void {
  const key = keyOf(activityId, path);
  const view = views.get(key);
  if (view === undefined) pendingViews.set(key, state);
  else view.restoreViewState(state);
}

/** The file's model disposed and forgotten with its tab (#717), any waiting reveal with it. */
export function close(activityId: string, path: string): void {
  const key = keyOf(activityId, path);
  if (loading.has(key)) cancelled.add(key);
  entries.get(key)?.model.dispose();
  entries.delete(key);
  pending.delete(key);
  pendingViews.delete(key);
  views.delete(key);
  notify();
}

/** Every model of an activity no longer listed goes (#717): a deleted activity has no tab left to close them, and a dirty one would hold the
 * page's unload forever. */
export function closeExcept(liveIds: ReadonlySet<string>): void {
  for (const entry of [...entries.values()]) {
    if (!liveIds.has(entry.activityId)) close(entry.activityId, entry.path);
  }
}

/** Called on every change of a buffer's text or saved state (#717); returns the unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function reveal(view: RevealView, { line, col = 1 }: FileAt): void {
  const position = { lineNumber: line, column: col };
  view.setPosition(position);
  view.revealPositionInCenter(position);
  view.focus();
}

/** Puts the cursor at `at` in the file's editor (#717): at once while a pane shows the file, else when one next attaches. */
export function revealAt(activityId: string, path: string, at: FileAt): void {
  const key = keyOf(activityId, path);
  const view = views.get(key);
  if (view === undefined) pending.set(key, at);
  else reveal(view, at);
}

/** The pane's editor for the file while it is mounted (#717); a reveal asked before lands now. Returns the detach. */
export function attachView(activityId: string, path: string, view: RevealView): () => void {
  const key = keyOf(activityId, path);
  views.set(key, view);
  const state = pendingViews.get(key);
  if (state !== undefined) { // before the reveal, so a line a link asked for still wins the cursor
    pendingViews.delete(key);
    view.restoreViewState(state);
  }
  const at = pending.get(key);
  if (at !== undefined) {
    pending.delete(key);
    reveal(view, at);
  }
  return () => {
    if (views.get(key) === view) views.delete(key);
  };
}

type RenameListener = (activityId: string, from: string, to: string) => void;
const renameListeners = new Set<RenameListener>();

// The value under `from` moved to `to`, as it is
function moveKey<T>(map: Map<string, T>, from: string, to: string): void {
  const value = map.get(from);
  if (value === undefined) return;
  map.delete(from);
  map.set(to, value);
}

/** A path the files tree renamed or moved (#818): every open entry at `from`, or under it for a folder, re-keyed to its new path with its
 *  buffer, dirty or not, its pending reveal and view state, and its view; nothing is disposed. Then the listeners hear it, the center's tabs among them. */
export function renamed(activityId: string, from: string, to: string): void {
  for (const entry of [...entries.values()]) {
    const path = entry.activityId === activityId ? renamedPath(entry.path, from, to) : undefined;
    if (path === undefined) continue;
    const [was, now] = [keyOf(activityId, entry.path), keyOf(activityId, path)];
    entries.delete(was);
    entries.set(now, { ...entry, path });
    moveKey(views, was, now);
    moveKey(pending, was, now);
    moveKey(pendingViews, was, now);
    moveBase(activityId, entry.path, path); // the base and the pick the panes compare with follow the file too
  }
  for (const listener of renameListeners) listener(activityId, from, to);
  notify();
}

/** Called after every renamed (#818); returns the unsubscribe. */
export function onRenamed(listener: RenameListener): () => void {
  renameListeners.add(listener);
  return () => {
    renameListeners.delete(listener);
  };
}

/** An untitled buffer saved as `path` (#818): its model becomes the file's, kept and clean on `version`, its language the file's. A file
 *  already open at `path` takes the text instead, so the pane showing it keeps a live model, and the untitled buffer goes. */
export function adopt(activityId: string, n: number, path: string, version: string): void {
  const from = untitledPath(n);
  const entry = entryOf(activityId, from);
  if (entry === undefined) return;
  const open = entryOf(activityId, path);
  if (open !== undefined) {
    replaceText(open.model, entry.model.getValue());
    settle(activityId, path, { base: version, savedVersionId: open.model.getAlternativeVersionId() });
    close(activityId, from);
    return;
  }
  entries.delete(keyOf(activityId, from));
  entries.set(keyOf(activityId, path), { ...entry, path, base: version, savedVersionId: entry.model.getAlternativeVersionId() });
  void loadMonaco().then((setup) => {
    setup.monaco.editor.setModelLanguage(entry.model, languageOf(setup.monaco.languages.getLanguages(), path));
    setup.applySyntaxFor(entry.model, path);
  });
  notify();
}
