import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { needsLiquid, parseTemplate } from '../../template';
import type { ChainSpec } from '../../template-condition';
import { type EditResult, insertChain, moveBlock, removeChain, replaceChain } from '../../template-edit';
import type { CatalogueItem, ItemRead } from '../../types';
import { type Plugins, statusOf } from '@/hooks/use-plugins';
import type { MessageKey } from '@/i18n';
import { getJson, sendJson } from '@/lib/api';
import { HIVE_ORIGIN, mainPathOf, versionToOpen } from '@/lib/plugins';
import type { EditorMode } from '@/lib/template-view';

/** The skill editor's state (#319, #320): held by usePluginsDock, in the always-mounted dock, so it outlives the view. */
export interface ItemEditor {
  item?: CatalogueItem; // the open screen's item, from the catalogue
  read?: ItemRead; // its open version's files; undefined while the read flies
  hasFailed: boolean;
  version: string | null; openVersion(version: string | null): void; // #320, decision 9: the open version, null the original
  isReadOnly: boolean; // #320, decision 8: the original, once the item has a version
  path?: string; openFile(path: string): void;
  textOf(path: string): string; isDirty(path: string): boolean; edit(text: string): void; // edit: the open file's buffer
  save(): Promise<void>; newFile(path: string): Promise<MessageKey | undefined>; revert(): Promise<void>; move(line: number, index: number): void;
  // #320, decisions 11–13: a version from the open one, the open one renamed, a workspace moved onto it; undefined: done. Not `useIn`: the
  // hooks lint reads editor.useIn() in a menu's onSelect as a hook call
  createVersion(name: string): Promise<MessageKey | undefined>; renameVersion(name: string): Promise<MessageKey | undefined>;
  assignTo(workspace: string): Promise<MessageKey | undefined>;
  insertChain(line: number, spec: ChainSpec): EditResult; replaceChain(line: number, spec: ChainSpec): EditResult; removeChain(line: number): EditResult; // #322: on the open buffer
  mode: EditorMode; setMode(mode: EditorMode): void;
  viewAs?: string; setViewAs(workspace: string | undefined): void; // the right pane's "view as"; undefined is the template
  collapsed: readonly number[]; toggle(line: number): void; // the open item's collapsed `##`, by line
  error?: MessageKey; errorVars?: Record<string, string | number>; renamedTo?: string; // under the tabs, for the item they came from
  // The variables pane's writes (#321): the buffer, saved at once when it was clean. #331: isSaveForced (accept) saves it whatever it was,
  // after any save in flight; nothing else writes while locked
  applyEdit(result: WriteResult, options?: { isSaveForced?: boolean }): MessageKey | undefined;
  isLocked: boolean; setLocked(isLocked: boolean): void; // #331: set while the agent works on the open file or proposes
  original?: ItemRead; // the Hive's original of the open item while a version is open (#321, decision 10)
}
/** What applyEdit takes: a template edit's result, or a whole new text (#331: an accepted proposal). */
export type WriteResult = { ok: true; text: string } | Extract<EditResult, { ok: false }>;
type Writes = Pick<ItemEditor, 'save' | 'newFile' | 'revert' | 'createVersion' | 'renameVersion' | 'assignTo'>;

interface Note { id: string; error?: MessageKey; errorVars?: Record<string, string | number>; renamedTo?: string }
interface WriteContext {
  item: CatalogueItem; read: ItemRead; path: string; text: string;
  put(read: ItemRead): void; reload(): Promise<void>; setNote(note: Note | undefined): void; setPath(path: string): void;
  settle(version: string | null, path: string, sent: string): void; // the open file's buffer after a save, under the version and path saved
  moveVersion(to: string): void; dropVersion(): void; // the open version's read and buffers, renamed or gone
  carryBuffers(to: string): void; // the open version's unsaved buffers only, onto another version
  openVersion(version: string | null): void;
}

const LIQUID = '.liquid';
const REQUIRED_KEYS = ['name', 'description'] as const; // what Claude Code needs to load a skill or an agent
const ORIGINAL = 'original'; // custom-versions.ts's ORIGINAL: POST …/versions copies the original from it
const BAD_REQUEST = 400;
const CONFLICT = 409;
const NAME_REFUSAL: Readonly<Record<number, MessageKey>> = { [BAD_REQUEST]: 'plugins.version.badName', [CONFLICT]: 'plugins.version.taken' };
const NONE: readonly number[] = [];
// NUL is in no id, version name or path, and the original's slot is '', a name no version has: a version's key prefixes each of its buffers'
const versionKey = (id: string, version: string | null): string => `${id}\0${version ?? ''}\0`;
const bufferKey = (id: string, version: string | null, path: string): string => `${versionKey(id, version)}${path}`;
const itemUrl = (id: string): string => `/api/items/${encodeURIComponent(id)}`;
const readUrl = (id: string, version: string | null): string => (version === null ? itemUrl(id) : `${itemUrl(id)}?${new URLSearchParams({ version })}`);
const versionUrl = (id: string, version: string): string => `${itemUrl(id)}/versions/${encodeURIComponent(version)}`;
const isItemRead = (value: unknown): value is ItemRead => typeof value === 'object' && value !== null && Array.isArray((value as Partial<ItemRead>).files);

// Every key under `from` moved under `to`, or dropped without one: a renamed version's buffers follow it, a reverted one's go
const rekey = <T>(record: Readonly<Record<string, T>>, from: string, to?: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).flatMap(([key, value]): [string, T][] => {
    if (!key.startsWith(from)) return [[key, value]];
    return to === undefined ? [] : [[`${to}${key.slice(from.length)}`, value]];
  }));

// The open version's read, once per item and version: a later visit keeps it, as it keeps the buffers over it (#320, decision 10)
function useReads(item: CatalogueItem | undefined, version: string | null) {
  const [reads, setReads] = useState<Readonly<Record<string, ItemRead>>>({});
  const [failed, setFailed] = useState<readonly string[]>([]);
  const id = item?.id;
  const key = id === undefined ? undefined : versionKey(id, version);
  const isSettled = key !== undefined && (reads[key] !== undefined || failed.includes(key));
  const put = useCallback((read: ItemRead): void => setReads((prev) => ({ ...prev, [versionKey(read.item.id, read.version)]: read })), []);
  // A rename moves the read under its new name; a revert (no `to`) drops it, so a later version of that name is read afresh
  const moveRead = useCallback((itemId: string, from: string | null, to?: string): void => setReads((prev) => {
    const { [versionKey(itemId, from)]: moved, ...rest } = prev;
    return moved === undefined || to === undefined ? rest : { ...rest, [versionKey(itemId, to)]: { ...moved, version: to } };
  }), []);
  useEffect(() => {
    if (id === undefined || key === undefined || isSettled) return undefined;
    let live = true;
    const fail = (): void => { if (live) setFailed((prev) => [...prev, key]); };
    getJson<unknown>(readUrl(id, version)).then((read) => { if (!live) return; if (isItemRead(read)) put(read); else fail(); }, fail);
    return () => { live = false; };
  }, [id, key, version, isSettled, put]);
  return { read: key === undefined ? undefined : reads[key], hasFailed: key !== undefined && failed.includes(key), put, moveRead };
}

function useBuffers() {
  const [buffers, setBuffers] = useState<Readonly<Record<string, string>>>({});
  const set = useCallback((key: string, text: string): void => setBuffers((prev) => ({ ...prev, [key]: text })), []);
  // A save's settling: the buffer sent goes back to the read; one typed in while the save flew stays dirty, under the file's new key
  const settle = useCallback((from: string, to: string, sent: string): void => setBuffers((prev) => {
    const { [from]: typed, ...rest } = prev;
    return typed === undefined || typed === sent ? rest : { ...rest, [to]: typed };
  }), []);
  const rekeyBuffers = useCallback((from: string, to?: string): void => setBuffers((prev) => rekey(prev, from, to)), []);
  return { buffers, set, settle, rekeyBuffers };
}

// Decision 9: the version the menu chose, per item; one the catalogue no longer lists falls back to #319's openVersionOf
function useOpenVersion(item: CatalogueItem | undefined) {
  const [chosen, setChosen] = useState<Readonly<Record<string, string | null>>>({});
  const version = item === undefined ? null : versionToOpen(item, chosen[item.id]);
  const open = useCallback((id: string, next: string | null): void => setChosen((prev) => ({ ...prev, [id]: next })), []);
  return { version, open };
}

// The editor's view (decisions 15, 18, 22): one mode and one "view as" for every item, the collapsed `##` per item
function useViewState(id: string): Pick<ItemEditor, 'mode' | 'setMode' | 'viewAs' | 'setViewAs' | 'collapsed' | 'toggle'> {
  const [mode, setMode] = useState<EditorMode>('visual');
  const [viewAs, setViewAs] = useState<string>();
  const [collapsedOf, setCollapsedOf] = useState<Readonly<Record<string, readonly number[]>>>({});
  const toggle = (line: number): void => setCollapsedOf((prev) => {
    const lines = prev[id] ?? NONE;
    return { ...prev, [id]: lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line] };
  });
  return { mode, setMode, viewAs, setViewAs, collapsed: collapsedOf[id] ?? NONE, toggle };
}

// #323: an item's main file is saved only with a header that parses and names it; any other file of a skill has no header to check
function headerRefusal(c: WriteContext): Omit<Note, 'id'> | undefined {
  if (c.path !== mainPathOf(c.read)) return undefined;
  const parsed = parseTemplate(c.text);
  const [error] = parsed.errors;
  if (error !== undefined) return { error: 'plugins.editor.badHeader', errorVars: { line: error.line } };
  const missing = REQUIRED_KEYS.find((key) => typeof parsed.header[key] !== 'string' || parsed.header[key] === '');
  return missing === undefined ? undefined : { error: 'plugins.editor.headerNeeds', errorVars: { key: missing } };
}

// ⌘S (decisions 5, 7, 9 of #319): the open file only. A Hive .md whose text now uses Liquid is saved as .md.liquid from the .md; a workspace
// item is never renamed. Saving the original answers `mine` (#320, decision 8 keeps the rule): the catalogue lists it before the editor
// opens it, so the view never falls back to the original between the two
async function saveFile(c: WriteContext): Promise<void> {
  const isRename = c.item.origin === HIVE_ORIGIN && c.path.endsWith('.md') && needsLiquid(c.text);
  const to = isRename ? `${c.path}${LIQUID}` : c.path;
  const refusal = headerRefusal(c);
  c.setNote(refusal && { id: c.item.id, ...refusal });
  if (refusal) return;
  let saved: ItemRead;
  try {
    saved = await sendJson<ItemRead>('PUT', `${itemUrl(c.item.id)}/files`, { version: c.read.version, path: to, text: c.text, ...(isRename ? { from: c.path } : {}) });
  } catch {
    c.setNote({ id: c.item.id, error: 'plugins.editor.saveFailed' }); // a 500's detail is in hive.log already (server-plugins.ts)
    return;
  }
  c.put(saved);
  await c.reload();
  c.settle(saved.version, to, c.text);
  c.setPath(to);
  c.openVersion(saved.version);
  if (isRename) c.setNote({ id: c.item.id, renamedTo: to });
}

// "+" (decision 13 of #319): an empty file at the path, in the open version (on the original it makes `mine`, opened as a save opens it)
async function createFile(c: WriteContext, path: string): Promise<MessageKey | undefined> {
  if (c.read.files.some((file) => file.path === path)) return 'plugins.file.taken';
  let made: ItemRead;
  try {
    made = await sendJson<ItemRead>('PUT', `${itemUrl(c.item.id)}/files`, { version: c.read.version, path, text: '' });
  } catch (err) {
    return statusOf(err) === BAD_REQUEST ? 'plugins.file.badPath' : 'plugins.file.failed';
  }
  c.put(made);
  await c.reload();
  c.setPath(path);
  c.openVersion(made.version);
  return undefined;
}

// Decision 12 of #319: the open version goes and the original opens; the version's read and unsaved edits go with it
async function revertVersion(c: WriteContext): Promise<void> {
  const { version } = c.read;
  if (version === null) return;
  try {
    await sendJson<unknown>('DELETE', versionUrl(c.item.id, version));
    c.put(await getJson<ItemRead>(itemUrl(c.item.id)));
  } catch {
    c.setNote({ id: c.item.id, error: 'plugins.editor.revertFailed' });
    return;
  }
  await c.reload();
  c.dropVersion();
  c.openVersion(null);
}

// #320, decision 11: a copy of the open version (the original for null), opened once the catalogue lists it
async function createNamed(c: WriteContext, name: string): Promise<MessageKey | undefined> {
  try {
    c.put(await sendJson<ItemRead>('POST', `${itemUrl(c.item.id)}/versions`, { name, from: c.read.version ?? ORIGINAL }));
  } catch (err) {
    return NAME_REFUSAL[statusOf(err)] ?? 'plugins.version.createFailed';
  }
  await c.reload();
  // The original turns read-only once a version exists (decision 8): its unsaved edits follow the copy instead of stranding there
  if (c.read.version === null) c.carryBuffers(name);
  c.openVersion(name);
  return undefined;
}

// #320, decision 13: the open version under a new name; its read and unsaved buffers move with it, never read again
async function renameOpen(c: WriteContext, name: string): Promise<MessageKey | undefined> {
  const { version } = c.read;
  if (version === null) return 'plugins.version.renameFailed'; // the menu offers no rename on the original
  try {
    await sendJson<unknown>('PATCH', versionUrl(c.item.id, version), { name });
  } catch (err) {
    return NAME_REFUSAL[statusOf(err)] ?? 'plugins.version.renameFailed';
  }
  await c.reload();
  c.moveVersion(name);
  c.openVersion(name);
  return undefined;
}

// #320, decision 12: the workspace runs the open version (the original for null); the menu's rows and the sidebar follow the catalogue
async function assignOpen(c: WriteContext, workspace: string): Promise<MessageKey | undefined> {
  try {
    await sendJson<unknown>('POST', `${itemUrl(c.item.id)}/assign`, { workspace, version: c.read.version });
  } catch {
    return 'plugins.version.useFailed';
  }
  await c.reload();
  return undefined;
}

// The writes over the open file and version; with nothing open each answers its failure's copy
function writesOf(context: WriteContext | undefined, canSave: () => boolean, saving: RefObject<boolean>): Writes {
  // One write at a time: a second one would send the version or path the first is still moving
  const run = async (write: (c: WriteContext) => Promise<MessageKey | undefined>, failed: MessageKey): Promise<MessageKey | undefined> => {
    if (context === undefined || saving.current) return failed;
    saving.current = true;
    try { return await write(context); } finally { saving.current = false; }
  };
  return {
    save: async () => {
      // A second ⌘S during a rename's flight would send `from` for a file the first one already moved; the read-only original saves nothing
      if (context === undefined || !canSave() || saving.current) return;
      saving.current = true;
      try { await saveFile(context); } finally { saving.current = false; }
    },
    newFile: (p) => run((c) => createFile(c, p.trim()), 'plugins.file.failed'),
    revert: async () => { await run(async (c) => { await revertVersion(c); return undefined; }, 'plugins.editor.revertFailed'); },
    createVersion: (name) => run((c) => createNamed(c, name), 'plugins.version.createFailed'),
    renameVersion: (name) => run((c) => renameOpen(c, name), 'plugins.version.renameFailed'),
    assignTo: (workspace) => run((c) => assignOpen(c, workspace), 'plugins.version.useFailed'),
  };
}

// Decision 10 (#321): the Hive's original of a Hive item with a version open, read once per item, tells a variable "from hive" from "yours".
// A failed read leaves it unknown, and the pane then offers no remove: a variable the original declares must never be removable
function useOriginal(item: CatalogueItem | undefined, read: ItemRead | undefined): ItemRead | undefined {
  const [originals, setOriginals] = useState<Readonly<Record<string, ItemRead>>>({});
  const id = item?.id;
  const isWanted = id !== undefined && item?.origin === HIVE_ORIGIN && !item.userCreated && read !== undefined && read.version !== null && originals[id] === undefined;
  useEffect(() => {
    if (!isWanted || id === undefined) return undefined;
    let live = true;
    getJson<unknown>(itemUrl(id)).then((answer) => { if (live && isItemRead(answer)) setOriginals((prev) => ({ ...prev, [id]: answer })); }, () => undefined);
    return () => { live = false; };
  }, [id, isWanted]);
  return id === undefined ? undefined : originals[id];
}

// A refused edit's copy (decision 15): template-edit answers the parser's English, which never reaches the UI
const EDIT_ERRORS: readonly [RegExp, MessageKey][] = [
  [/ is not declared$/, 'plugins.variables.error.undeclared'],
  [/ is already declared$/, 'plugins.variables.error.taken'],
  [/a name is a letter|is built in|is not a name a variable can take/, 'plugins.variables.error.badName'],
];
/** A refused template edit as copy; the protocol's variables pane (#337) maps its refusals the same way. */
export const editErrorKey = (message: string): MessageKey => EDIT_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? 'plugins.variables.error.invalid';

const NO_FILE: EditResult = { ok: false, error: { line: 1, message: 'no file is open' } };
type TextEdits = Pick<ItemEditor, 'move' | 'insertChain' | 'replaceChain' | 'removeChain'>;

// The map's and the condition form's edits (#319 decision 20, #322 decision 20): each runs on the open buffer, which becomes its answer's text
// when it holds, so visual and text modes read one truth; a refusal leaves the text and is answered to the caller, which shows it
function textEdits(text: string | undefined, write: (text: string) => void): TextEdits {
  const apply = (change: (from: string) => EditResult): EditResult => {
    if (text === undefined) return NO_FILE;
    const result = change(text);
    if (result.ok) write(result.text);
    return result;
  };
  return {
    move: (line, index) => { apply((from) => moveBlock(from, line, index)); },
    insertChain: (line, spec) => apply((from) => insertChain(from, line, spec)),
    replaceChain: (line, spec) => apply((from) => replaceChain(from, line, spec)),
    removeChain: (line) => apply((from) => removeChain(from, line)),
  };
}

interface EditTarget {
  context?: WriteContext; isReadOnly: boolean; isLocked: boolean; saving: RefObject<boolean>;
  isDirty(path: string): boolean; write(path: string, text: string): void; forceSave(): void;
}

// Decision 5 (#321): the pane's edit lands in the buffer; a buffer that was clean is saved with it, a dirty one waits for ⌘S. #331: only a
// forced edit writes while locked, and it is saved whatever the buffer was
function applyEditOf(target: EditTarget): ItemEditor['applyEdit'] {
  return (result, options = {}) => {
    if (!result.ok) return editErrorKey(result.error.message);
    const { context, saving } = target;
    const isForced = options.isSaveForced === true;
    if (context === undefined || target.isReadOnly || (target.isLocked && !isForced)) return undefined;
    if (result.text === context.text && !isForced) return undefined;
    const wasClean = !target.isDirty(context.path);
    target.write(context.path, result.text);
    if (isForced) target.forceSave();
    else if (wasClean && !saving.current) {
      saving.current = true;
      void saveFile({ ...context, text: result.text }).finally(() => { saving.current = false; });
    }
    return undefined;
  };
}

// The save-in-flight flag, whose release also renders: a forced save waiting on it must not depend on some other state change landing after
function useSaving(): RefObject<boolean> {
  const flag = useRef(false);
  const [, bump] = useState(0);
  return useMemo(() => ({
    get current() { return flag.current; },
    set current(value: boolean) { flag.current = value; if (!value) bump((n) => n + 1); },
  }), []);
}

// #331: accept's save runs after the render that holds the accepted text, with that render's context, so a save in flight (a rename's
// included) has settled the path and the buffers first; the flag's release renders, which runs a waiting one.
// ponytail: a write that changes no state (a "+" on a taken path) leaves it waiting for the next render
function useForcedSave(context: WriteContext | undefined, saving: RefObject<boolean>): () => void {
  const isPending = useRef(false);
  useEffect(() => {
    if (!isPending.current || saving.current || context === undefined) return;
    isPending.current = false;
    saving.current = true;
    void saveFile(context).finally(() => { saving.current = false; });
  });
  return () => { isPending.current = true; };
}

/** The open item's editor state (#319, decisions 4–9, 12, 13, 18, 20, 22; #320, decisions 8–13; #321). */
export function useItemEditor(plugins: Plugins): ItemEditor {
  const { screen, items, reload } = plugins;
  const item = screen.kind === 'item' ? items?.find((i) => i.id === screen.id) : undefined;
  const id = item?.id ?? '';
  const { version, open } = useOpenVersion(item);
  const { read, hasFailed, put, moveRead } = useReads(item, version);
  const { buffers, set, settle, rekeyBuffers } = useBuffers();
  const [paths, setPaths] = useState<Readonly<Record<string, string>>>({});
  const [note, setNote] = useState<Note>();
  const saving = useSaving();
  const [isLocked, setLocked] = useState(false);
  const original = useOriginal(item, read);
  const view = useViewState(id);
  const isReadOnly = version === null && (item?.versions.length ?? 0) > 0; // decision 8
  const chosen = paths[id];
  const path = read && (read.files.some((file) => file.path === chosen) ? chosen : mainPathOf(read));
  const savedText = (p: string): string | undefined => read?.files.find((file) => file.path === p)?.text;
  const buffer = (p: string): string | undefined => buffers[bufferKey(id, version, p)];
  const textOf = (p: string): string => buffer(p) ?? savedText(p) ?? '';
  const isDirty = (p: string): boolean => buffer(p) !== undefined && buffer(p) !== savedText(p);
  const setPath = (p: string): void => setPaths((prev) => ({ ...prev, [id]: p }));
  const context: WriteContext | undefined = item && read && path ? {
    item, read, path, text: textOf(path), put, reload, setNote, setPath, openVersion: (v) => open(id, v),
    settle: (v, p, sent) => settle(bufferKey(id, read.version, path), bufferKey(id, v, p), sent),
    moveVersion: (to) => { moveRead(id, read.version, to); rekeyBuffers(versionKey(id, read.version), versionKey(id, to)); },
    dropVersion: () => { moveRead(id, read.version); rekeyBuffers(versionKey(id, read.version)); },
    carryBuffers: (to) => rekeyBuffers(versionKey(id, read.version), versionKey(id, to)),
  } : undefined;
  const forceSave = useForcedSave(context, saving);
  const write = (p: string, text: string): void => set(bufferKey(id, version, p), text);
  return {
    item, read, original, hasFailed, version, isReadOnly, path, textOf, isDirty,
    openVersion: (v) => { open(id, v); setNote(undefined); },
    openFile: (p) => { setPath(p); setNote(undefined); },
    edit: (text) => { if (path !== undefined && !isReadOnly && !isLocked) write(path, text); },
    ...writesOf(context, () => !isReadOnly && path !== undefined && isDirty(path), saving),
    applyEdit: applyEditOf({ context, isReadOnly, isLocked, saving, isDirty, write, forceSave }),
    ...textEdits(path === undefined || isReadOnly || isLocked ? undefined : textOf(path), (text) => { if (path !== undefined) write(path, text); }),
    isLocked, setLocked,
    ...view,
    error: note?.id === id ? note.error : undefined,
    errorVars: note?.id === id ? note.errorVars : undefined,
    renamedTo: note?.id === id ? note.renamedTo : undefined,
  };
}
