import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseTemplate } from '../../template';
import { type LintAnnotation, lintTemplate } from '../../template-lint';
import type { CatalogueItem, LintInputRead } from '../../types';
import type { ItemEditor } from '@/hooks/use-item-editor';
import type { MessageKey } from '@/i18n';
import { fixOf } from '@/lib/annotation-fix';
import { getJson, sendJson } from '@/lib/api';
import { HIVE_ORIGIN } from '@/lib/plugins';
import { isMarkdown } from '@/lib/template-view';

/** The open file's annotations (#327, ui.annotations): what the text, the map, the variables pane and the head's counter show; the reviewer
 * menu (4.3) and the assist footer (4.5) read it too. */
export interface Annotations {
  list: readonly LintAnnotation[]; // the open file's, not dismissed, in the lint's order
  open?: LintAnnotation; // the card shown
  revealed?: { line: number; n: number }; // the source line openAt last revealed; n changes on every reveal, so one line twice reveals twice
  canDismiss: boolean; // the dismissed keys are read: a write before would replace the server's list
  error?: MessageKey; // a dismissal not saved, or a fix the edit refused
  openAt(annotation: LintAnnotation): void; // reveals its line and opens its card
  next(): void; // the one after the open one (or the first), cycling
  close(): void;
  dismiss(annotation: LintAnnotation): void;
  apply(annotation: LintAnnotation): void; // only when hasFix(annotation)
}

interface Scope { id: string; version: string | null; path: string }
interface Dismissed { server: readonly string[]; shown: readonly string[] } // server: the last list the server answered
type Lists = Readonly<Record<string, Dismissed>>;
interface FileNote<T> { file: string; value: T }
interface Failure { item: string; dismissal: string } // the dismissal a write did not save, under its item
interface Ledger { latest: RefObject<Lists>; put(key: string, list: Dismissed): void; setFailed(update: (last: Failure | undefined) => Failure | undefined): void }

const NONE: readonly LintAnnotation[] = [];
const EMPTY_INPUT: LintInputRead = { catalogue: [], scripts: [] };
const MAX_KEYS = 1000; // server-plugins.ts's MAX_DISMISSED: that module is the server's
const itemKeyOf = ({ id, version }: Pick<Scope, 'id' | 'version'>): string => `${id}\0${version ?? ''}`;
const fileKeyOf = (scope: Scope): string => `${itemKeyOf(scope)}\0${scope.path}`;
const idOf = (a: LintAnnotation): string => `${a.line}\0${a.check}\0${a.title}`;
const isKeys = (value: unknown): value is string[] => Array.isArray(value) && value.every((key) => typeof key === 'string');
const isLintInput = (value: unknown): value is LintInputRead =>
  typeof value === 'object' && value !== null && Array.isArray((value as Partial<LintInputRead>).catalogue) && Array.isArray((value as Partial<LintInputRead>).scripts);
function dismissedUrl(id: string, version?: string | null): string {
  const base = `/api/items/${encodeURIComponent(id)}/dismissed`;
  return version === undefined || version === null ? base : `${base}?${new URLSearchParams({ version })}`;
}

/** A dismissal's key (#327): the line number is left out, so a moved line keeps it, and any edit of the line's text drops it. */
export const dismissalKey = (path: string, a: LintAnnotation, lines: readonly string[]): string =>
  `${path}\0${a.check}\0${a.title}\0${(lines[a.line - 1] ?? '').replace(/\r$/, '')}`;

// Only a Hive item's markdown file is linted, and never under "view as": the preview's lines are not the template's
function scopeOf({ item, read, path, viewAs }: ItemEditor): Scope | undefined {
  if (item === undefined || item.origin !== HIVE_ORIGIN || read === undefined || read.item.id !== item.id) return undefined;
  if (path === undefined || !isMarkdown(path) || viewAs !== undefined) return undefined;
  return { id: item.id, version: read.version, path };
}

// The catalogue's variables and the plugin's scripts, read once and again when the catalogue changes; a failed read lints against nothing
function useLintInput(items: readonly CatalogueItem[] | undefined): LintInputRead {
  const [input, setInput] = useState<LintInputRead>(EMPTY_INPUT);
  useEffect(() => {
    if (items === undefined) return undefined;
    let live = true;
    const fail = (reason: unknown): void => {
      if (!live) return;
      console.error('annotations: the lint input did not load; linting with no catalogue and no scripts', reason);
      setInput(EMPTY_INPUT);
    };
    getJson<unknown>('/api/lint-input').then((read) => { if (!live) return; if (isLintInput(read)) setInput(read); else fail(read); }, fail);
    return () => { live = false; };
  }, [items]);
  return input;
}

function useLint(item: CatalogueItem | undefined, text: string, input: LintInputRead, workspaces: readonly string[]): readonly LintAnnotation[] {
  const origin = item?.origin;
  const kind = item?.kind;
  const name = item?.name;
  return useMemo(() => {
    if (origin === undefined || kind === undefined || name === undefined) return NONE;
    return lintTemplate(parseTemplate(text), { self: { origin, kind, name }, catalogue: input.catalogue, workspaces: [...workspaces], scripts: input.scripts });
  }, [origin, kind, name, text, input, workspaces]);
}

// One PUT of the item's latest list. A failure takes back only its own dismissal: the ones queued behind it stay and are still sent, and the
// error stays until a write carrying the failed one succeeds
async function sendLatest(target: Pick<Scope, 'id' | 'version'>, dismissal: string, ledger: Ledger): Promise<void> {
  const key = itemKeyOf(target);
  // ponytail: past the server's cap the oldest dismissals go; a prune of keys no line matches any more if that ever bites
  const keys = (ledger.latest.current[key]?.shown ?? []).slice(-MAX_KEYS);
  try {
    const answer = await sendJson<unknown>('PUT', dismissedUrl(target.id), { version: target.version, keys });
    const server = isKeys(answer) ? answer : keys;
    ledger.put(key, { server, shown: ledger.latest.current[key]?.shown ?? server });
    ledger.setFailed((last) => (last !== undefined && last.item === key && keys.includes(last.dismissal) ? undefined : last));
  } catch (err) {
    console.error(`annotations: a dismissal of ${target.id} was not saved`, err);
    const now = ledger.latest.current[key];
    if (now !== undefined) ledger.put(key, { server: now.server, shown: now.shown.filter((shown) => shown !== dismissal) });
    ledger.setFailed(() => ({ item: key, dismissal }));
  }
}

// The open item version's dismissed keys. A dismissal shows at once; the writes go one at a time, each sending the latest list, so two quick
// dismissals never lose one
function useDismissed(scope: Scope | undefined): { shown?: readonly string[]; hasFailed: boolean; add(dismissal: string): void } {
  const [lists, setLists] = useState<Lists>({});
  const [failed, setFailed] = useState<Failure>(); // the last dismissal not saved
  const latest = useRef<Lists>({}); // the lists as the writes build them, ahead of a render
  const queue = useRef<Promise<void>>(Promise.resolve());
  const put = useCallback((key: string, list: Dismissed): void => {
    latest.current = { ...latest.current, [key]: list };
    setLists(latest.current);
  }, []);
  const key = scope && itemKeyOf(scope);
  const id = scope?.id;
  const version = scope?.version;
  useEffect(() => {
    if (key === undefined || id === undefined || version === undefined || latest.current[key] !== undefined) return undefined;
    let live = true;
    getJson<unknown>(dismissedUrl(id, version)).then(
      (keys) => { if (live && isKeys(keys)) put(key, { server: keys, shown: keys }); },
      (err: unknown) => console.error(`annotations: the dismissals of ${id} did not load`, err),
    );
    return () => { live = false; };
  }, [key, id, version, put]);
  const add = (dismissal: string): void => {
    const list = key === undefined ? undefined : latest.current[key];
    if (scope === undefined || key === undefined || list === undefined || list.shown.includes(dismissal)) return;
    put(key, { ...list, shown: [...list.shown, dismissal] });
    const target = { id: scope.id, version: scope.version };
    queue.current = queue.current.then(() => sendLatest(target, dismissal, { latest, put, setFailed }));
  };
  return { shown: key === undefined ? undefined : lists[key]?.shown, hasFailed: key !== undefined && failed?.item === key, add };
}

// The open card and the last reveal, both kept per file: another file's never shows here
function useOpenCard(file: string | undefined, list: readonly LintAnnotation[]) {
  const [opened, setOpened] = useState<FileNote<string>>();
  const [revealed, setRevealed] = useState<FileNote<{ line: number; n: number }>>();
  const open = file !== undefined && opened !== undefined && opened.file === file ? list.find((a) => idOf(a) === opened.value) : undefined;
  const close = useCallback((): void => setOpened(undefined), []); // the Esc listener depends on it
  const openAt = (annotation: LintAnnotation): void => {
    if (file === undefined) return;
    setOpened({ file, value: idOf(annotation) });
    setRevealed((last) => ({ file, value: { line: annotation.line, n: (last?.value.n ?? 0) + 1 } }));
  };
  return { open, openAt, close, revealed: revealed !== undefined && revealed.file === file ? revealed.value : undefined };
}

/** The open file's annotations (#327): linted on every change of its buffer, its dismissals left out, one card open at a time. */
export function useAnnotations(editor: ItemEditor, items: readonly CatalogueItem[] | undefined, workspaces: readonly string[]): Annotations {
  const scope = scopeOf(editor);
  const path = scope?.path;
  const text = path === undefined ? '' : editor.textOf(path);
  const all = useLint(scope === undefined ? undefined : editor.item, text, useLintInput(items), workspaces);
  const { shown, hasFailed, add } = useDismissed(scope);
  const lines = useMemo(() => text.split('\n'), [text]);
  const list = useMemo(() => {
    if (path === undefined || shown === undefined || shown.length === 0) return all;
    const hidden = new Set(shown);
    return all.filter((a) => !hidden.has(dismissalKey(path, a, lines)));
  }, [all, shown, path, lines]);
  const file = scope && fileKeyOf(scope);
  const card = useOpenCard(file, list);
  const [refused, setRefused] = useState<FileNote<MessageKey>>();
  const fixError = refused !== undefined && refused.file === file ? refused.value : undefined;
  return {
    list, open: card.open, revealed: card.revealed, canDismiss: shown !== undefined,
    error: hasFailed ? 'plugins.annotations.dismissFailed' : fixError,
    openAt: card.openAt, close: card.close,
    next: () => {
      if (list.length === 0) return;
      const at = card.open === undefined ? -1 : list.indexOf(card.open);
      card.openAt(list[(at + 1) % list.length]);
    },
    dismiss: (annotation) => {
      if (path === undefined) return;
      if (card.open === annotation) card.close();
      add(dismissalKey(path, annotation, lines));
    },
    // The fix goes through applyEdit, as the variables pane writes: saved at once when the buffer was clean
    apply: (annotation) => {
      const result = fixOf(annotation, text);
      if (result === undefined || file === undefined) return;
      const key = editor.applyEdit(result);
      setRefused(key === undefined ? undefined : { file, value: key });
      if (key === undefined) card.close();
    },
  };
}
