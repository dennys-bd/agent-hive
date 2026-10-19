import { useCallback, useEffect, useRef, useState } from 'react';
import { needsLiquid, parseTemplate } from '../../template';
import { type EditResult, moveBlock } from '../../template-edit';
import type { CatalogueItem, ItemRead } from '../../types';
import { type Plugins, statusOf } from '@/hooks/use-plugins';
import type { MessageKey } from '@/i18n';
import { getJson, sendJson } from '@/lib/api';
import { HIVE_ORIGIN, mainPathOf, openVersionOf } from '@/lib/plugins';
import type { EditorMode } from '@/lib/template-view';

/** The skill editor's state (#319): held by usePluginsDock, in the always-mounted dock, so it outlives the view. */
export interface ItemEditor {
  item?: CatalogueItem; // the open screen's item, from the catalogue
  read?: ItemRead; // its open version's files; undefined while the read flies
  hasFailed: boolean;
  path?: string; openFile(path: string): void;
  textOf(path: string): string; isDirty(path: string): boolean; edit(text: string): void; // edit: the open file's buffer
  save(): Promise<void>; newFile(path: string): Promise<MessageKey | undefined>; revert(): Promise<void>; move(line: number, index: number): void;
  mode: EditorMode; setMode(mode: EditorMode): void;
  viewAs?: string; setViewAs(workspace: string | undefined): void; // the right pane's "view as"; undefined is the template
  collapsed: readonly number[]; toggle(line: number): void; // the open item's collapsed `##`, by line
  error?: MessageKey; errorVars?: Record<string, string | number>; renamedTo?: string; // under the tabs, for the item they came from
  applyEdit(result: EditResult): MessageKey | undefined; // the variables pane's writes (#321): the buffer, saved at once when it was clean
  original?: ItemRead; // the Hive's original of the open item while a version is open (#321, decision 10)
}

interface Note { id: string; error?: MessageKey; errorVars?: Record<string, string | number>; renamedTo?: string }
interface WriteContext {
  item: CatalogueItem; read: ItemRead; path: string; text: string;
  put(read: ItemRead): void; settle(from: string, to: string, sent: string): void; dropItem(): void;
  setPath(path: string): void; setNote(note: Note | undefined): void; reload(): Promise<void>;
}

const LIQUID = '.liquid';
const REQUIRED_KEYS = ['name', 'description'] as const; // what Claude Code needs to load a skill or an agent
const BAD_REQUEST = 400;
const NONE: readonly number[] = [];
const keyOf = (id: string, path: string): string => `${id}\0${path}`; // NUL is in no id and no path
const itemUrl = (id: string): string => `/api/items/${encodeURIComponent(id)}`;
const readUrl = (id: string, version: string | null): string => (version === null ? itemUrl(id) : `${itemUrl(id)}?${new URLSearchParams({ version })}`);
const isItemRead = (value: unknown): value is ItemRead => typeof value === 'object' && value !== null && Array.isArray((value as Partial<ItemRead>).files);

// The open item's read at decision 4's version, once per item: a later visit keeps it, as it keeps the buffers over it
function useReads(item: CatalogueItem | undefined) {
  const [reads, setReads] = useState<Readonly<Record<string, ItemRead>>>({});
  const [failed, setFailed] = useState<readonly string[]>([]);
  const id = item?.id;
  const version = item === undefined ? null : openVersionOf(item);
  const isSettled = id !== undefined && (reads[id] !== undefined || failed.includes(id));
  const put = useCallback((read: ItemRead): void => setReads((prev) => ({ ...prev, [read.item.id]: read })), []);
  useEffect(() => {
    if (id === undefined || isSettled) return undefined;
    let live = true;
    const fail = (): void => { if (live) setFailed((prev) => [...prev, id]); };
    getJson<unknown>(readUrl(id, version)).then((read) => { if (!live) return; if (isItemRead(read)) put(read); else fail(); }, fail);
    return () => { live = false; };
  }, [id, version, isSettled, put]);
  return { read: id === undefined ? undefined : reads[id], hasFailed: id !== undefined && failed.includes(id), put };
}

function useBuffers() {
  const [buffers, setBuffers] = useState<Readonly<Record<string, string>>>({});
  const set = useCallback((id: string, path: string, text: string): void => setBuffers((prev) => ({ ...prev, [keyOf(id, path)]: text })), []);
  // A save's settling: the buffer sent goes back to the read; one typed in while the save flew stays dirty, under the file's new name
  const settle = useCallback((id: string, from: string, to: string, sent: string): void => setBuffers((prev) => {
    const { [keyOf(id, from)]: typed, ...rest } = prev;
    return typed === undefined || typed === sent ? rest : { ...rest, [keyOf(id, to)]: typed };
  }), []);
  const dropItem = useCallback((id: string): void => setBuffers((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${id}\0`)))), []);
  return { buffers, set, settle, dropItem };
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

// ⌘S (decisions 5, 7, 9): the open file only. A Hive .md whose text now uses Liquid is saved as .md.liquid from the .md; a workspace item is
// never renamed (decision 27). Saving the original answers `mine`, which the read becomes
async function saveFile(c: WriteContext): Promise<void> {
  const isRename = c.item.origin === HIVE_ORIGIN && c.path.endsWith('.md') && needsLiquid(c.text);
  const to = isRename ? `${c.path}${LIQUID}` : c.path;
  const refusal = headerRefusal(c);
  c.setNote(refusal && { id: c.item.id, ...refusal });
  if (refusal) return;
  try {
    c.put(await sendJson<ItemRead>('PUT', `${itemUrl(c.item.id)}/files`, { version: c.read.version, path: to, text: c.text, ...(isRename ? { from: c.path } : {}) }));
  } catch {
    c.setNote({ id: c.item.id, error: 'plugins.editor.saveFailed' }); // a 500's detail is in hive.log already (server-plugins.ts)
    return;
  }
  c.settle(c.path, to, c.text);
  c.setPath(to);
  if (isRename) c.setNote({ id: c.item.id, renamedTo: to });
  await c.reload();
}

// "+" (decision 13): an empty file at the path, in the open version (the original's first save makes `mine`)
async function createFile(c: WriteContext, path: string): Promise<MessageKey | undefined> {
  if (c.read.files.some((file) => file.path === path)) return 'plugins.file.taken';
  try {
    c.put(await sendJson<ItemRead>('PUT', `${itemUrl(c.item.id)}/files`, { version: c.read.version, path, text: '' }));
  } catch (err) {
    return statusOf(err) === BAD_REQUEST ? 'plugins.file.badPath' : 'plugins.file.failed';
  }
  c.setPath(path);
  await c.reload();
  return undefined;
}

// Decision 12: the open version goes, the original opens; the version's unsaved edits go with it
async function revertVersion(c: WriteContext): Promise<void> {
  const { version } = c.read;
  if (version === null) return;
  try {
    await sendJson<unknown>('DELETE', `${itemUrl(c.item.id)}/versions/${encodeURIComponent(version)}`);
    c.put(await getJson<ItemRead>(itemUrl(c.item.id)));
  } catch {
    c.setNote({ id: c.item.id, error: 'plugins.editor.revertFailed' });
    return;
  }
  c.dropItem();
  await c.reload();
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

// One save at a time: a second ⌘S during a rename's flight would send `from` for a file the first one already moved
function useSaveRunner(): (c: WriteContext) => Promise<void> {
  const saving = useRef(false);
  return async (c) => {
    if (saving.current) return;
    saving.current = true;
    try { await saveFile(c); } finally { saving.current = false; }
  };
}

// A refused edit's copy (decision 15): template-edit answers the parser's English, which never reaches the UI
const EDIT_ERRORS: readonly [RegExp, MessageKey][] = [
  [/ is not declared$/, 'plugins.variables.error.undeclared'],
  [/ is already declared$/, 'plugins.variables.error.taken'],
  [/a name is a letter|is built in|is not a name a variable can take/, 'plugins.variables.error.badName'],
];
const editErrorKey = (message: string): MessageKey => EDIT_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? 'plugins.variables.error.invalid';

/** The open item's editor state (#319, decisions 4–9, 12, 13, 18, 20, 22). */
export function useItemEditor(plugins: Plugins): ItemEditor {
  const { screen, items, reload } = plugins;
  const item = screen.kind === 'item' ? items?.find((i) => i.id === screen.id) : undefined;
  const id = item?.id ?? '';
  const { read, hasFailed, put } = useReads(item);
  const { buffers, set, settle, dropItem } = useBuffers();
  const [paths, setPaths] = useState<Readonly<Record<string, string>>>({});
  const [note, setNote] = useState<Note>();
  const runSave = useSaveRunner();
  const original = useOriginal(item, read);
  const view = useViewState(id);
  const chosen = paths[id];
  const path = read && (read.files.some((file) => file.path === chosen) ? chosen : mainPathOf(read));
  const savedText = (p: string): string | undefined => read?.files.find((file) => file.path === p)?.text;
  const textOf = (p: string): string => buffers[keyOf(id, p)] ?? savedText(p) ?? '';
  const isDirty = (p: string): boolean => buffers[keyOf(id, p)] !== undefined && buffers[keyOf(id, p)] !== savedText(p);
  const setPath = (p: string): void => setPaths((prev) => ({ ...prev, [id]: p }));
  const context: WriteContext | undefined = item && read && path
    ? { item, read, path, text: textOf(path), put, settle: (from, to, sent) => settle(id, from, to, sent), dropItem: () => dropItem(id), setPath, setNote, reload }
    : undefined;
  return {
    item, read, original, hasFailed, path, textOf, isDirty,
    openFile: (p) => { setPath(p); setNote(undefined); },
    edit: (text) => { if (path !== undefined) set(id, path, text); },
    save: async () => { if (context !== undefined && isDirty(context.path)) await runSave(context); },
    // Decision 5 (#321): the pane's edit lands in the buffer; a buffer that was clean is saved with it, a dirty one waits for ⌘S
    applyEdit: (result) => {
      if (!result.ok) return editErrorKey(result.error.message);
      if (context === undefined || result.text === context.text) return undefined;
      const wasClean = !isDirty(context.path);
      set(id, context.path, result.text);
      if (wasClean) void runSave({ ...context, text: result.text });
      return undefined;
    },
    newFile: (p) => (context === undefined ? Promise.resolve<MessageKey>('plugins.file.failed') : createFile(context, p.trim())),
    revert: () => (context === undefined ? Promise.resolve() : revertVersion(context)),
    move: (line, index) => {
      if (path === undefined) return;
      const moved = moveBlock(textOf(path), line, index); // a refused move leaves the text (decision 20)
      if (moved.ok) set(id, path, moved.text);
    },
    ...view,
    error: note?.id === id ? note.error : undefined,
    errorVars: note?.id === id ? note.errorVars : undefined,
    renamedTo: note?.id === id ? note.renamedTo : undefined,
  };
}
