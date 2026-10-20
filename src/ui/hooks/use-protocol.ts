import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProtocolView } from '../../server-protocol';
import type { TemplateError } from '../../template';
import { statusOf } from '@/hooks/use-plugins';
import type { MessageKey } from '@/i18n';
import { getJson, sendJson } from '@/lib/api';

/** GET /api/protocol as #336 answers it: the blocks, each with whether mcp turns it off, and the passages with their per-workspace errors. */
export type ProtocolRead = ProtocolView;
export type ProtocolBlockView = ProtocolRead['blocks'][number];
export type ProtocolPassageView = ProtocolRead['passages'][number];
/** A refused save: the route's template errors (400), or the refusal as copy. */
export type SaveError = TemplateError[] | MessageKey;

/** The protocol screen's state (#337), shared by the centre's cards and the right pane, as the item editor's is (#319). */
export interface Protocol {
  read?: ProtocolRead; loadError?: MessageKey;
  drafts: Readonly<Record<string, string>>; // whole file text by passage id; a new passage's key is `new:<block id>`
  selected?: string; select(id: string): void;
  insert(after: string): void; cancel(key: string): void;
  edit(key: string, text: string): void; // the whole text: the card swaps the body, the variables list the header
  save(key: string): Promise<void>; remove(id: string): Promise<void>;
  saveErrors: Readonly<Record<string, SaveError>>;
  viewAs?: string; setViewAs(workspace: string | undefined): void;
  rendered?: string; renderError?: MessageKey; // the stage text of GET /api/protocol/render for viewAs
}

const NEW = 'new:';
const NOT_FOUND = 404;
/** A new passage's key: one per block, so "+ insert" twice on a block reopens its draft instead of stacking two. */
export const newKey = (after: string): string => `${NEW}${after}`;
/** A new passage's text: the header the screen keeps, an empty body. Nothing reaches the server until save. */
export const newDraft = (after: string): string => `---\nafter: ${after}\n---\n`;
/** The text a card or the variables pane shows for `key`: its draft, else the saved passage's. */
export function passageText(protocol: Pick<Protocol, 'read' | 'drafts'>, key: string): string | undefined {
  return protocol.drafts[key] ?? protocol.read?.passages.find((p) => p.id === key)?.text;
}

const passagePath = (id: string): string => `/api/protocol/passages/${encodeURIComponent(id)}`;
const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
// Anything but the route's shape is a failed read: a proxy's `{ ok: true }` must not render as an empty protocol
const isRead = (answer: unknown): answer is ProtocolRead =>
  typeof answer === 'object' && answer !== null
  && Array.isArray((answer as Partial<ProtocolRead>).blocks) && Array.isArray((answer as Partial<ProtocolRead>).passages);

// A 400's template errors as the route answers them; any other refusal as copy, since the route's English sentence never reaches the screen
function saveErrorOf(err: unknown): SaveError {
  const body = (err as { body?: { errors?: unknown } } | undefined)?.body;
  if (Array.isArray(body?.errors)) return body.errors as TemplateError[];
  return statusOf(err) === NOT_FOUND ? 'plugins.protocol.gone' : 'plugins.protocol.failed';
}

// While the screen is shown and after every write; only the latest read lands
function useProtocolRead(isShown: boolean) {
  const [read, setRead] = useState<ProtocolRead>();
  const [loadError, setLoadError] = useState<MessageKey>();
  const reads = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const n = ++reads.current;
    const answer = await getJson<unknown>('/api/protocol').catch(() => undefined);
    if (n !== reads.current) return;
    if (isRead(answer)) setRead(answer);
    setLoadError(isRead(answer) ? undefined : 'plugins.protocol.readFailed');
  }, []);
  useEffect(() => {
    if (isShown) void load();
  }, [isShown, load]);
  return { read, loadError, load };
}

// "View as" a workspace: the saved protocol its runs receive; a workspace the config no longer has (404) is the template again
function useRender(isShown: boolean) {
  const [viewAs, setViewAsState] = useState<string>();
  const shownAs = useRef<string>(undefined); // the effect below reads it, so coming back refetches without "view as" in its deps
  const [rendered, setRendered] = useState<string>();
  const [renderError, setRenderError] = useState<MessageKey>();
  const renders = useRef(0);
  const fetchRender = useCallback(async (workspace: string | undefined): Promise<void> => {
    const n = ++renders.current;
    setRendered(undefined);
    setRenderError(undefined);
    if (workspace === undefined) return;
    try {
      const answer = await getJson<{ stage: string }>(`/api/protocol/render?workspace=${encodeURIComponent(workspace)}`);
      if (n === renders.current) setRendered(answer.stage);
    } catch (err) {
      if (n !== renders.current) return;
      if (statusOf(err) === NOT_FOUND) {
        shownAs.current = undefined;
        setViewAsState(undefined);
      }
      else setRenderError('plugins.protocol.renderFailed');
    }
  }, []);
  const setViewAs = useCallback((workspace: string | undefined): void => {
    shownAs.current = workspace;
    setViewAsState(workspace);
    void fetchRender(workspace);
  }, [fetchRender]);
  // Back on the screen: an mcp switch or a workspace's values may have changed what its runs receive meanwhile
  useEffect(() => {
    if (isShown && shownAs.current !== undefined) void fetchRender(shownAs.current);
  }, [isShown, fetchRender]);
  return { viewAs, rendered, renderError, setViewAs, fetchRender };
}

// Saves are explicit: every save rewrites every workspace's protocol files, and half-written Liquid is refused
function useDrafts(afterWrite: () => Promise<void>) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [saveErrors, setSaveErrors] = useState<Readonly<Record<string, SaveError>>>({});
  const [selected, setSelected] = useState<string>();
  const saving = useRef(new Set<string>()); // a second click or ⌘S while a save flies would POST a duplicate passage
  const drop = useCallback((key: string): void => {
    setDrafts((prev) => without(prev, key));
    setSaveErrors((prev) => without(prev, key));
  }, []);
  const edit = useCallback((key: string, text: string): void => setDrafts((prev) => ({ ...prev, [key]: text })), []);
  const insert = useCallback((after: string): void => {
    const key = newKey(after);
    setDrafts((prev) => (Object.hasOwn(prev, key) ? prev : { ...prev, [key]: newDraft(after) }));
    setSelected(key);
  }, []);
  const cancel = useCallback((key: string): void => {
    drop(key);
    setSelected((prev) => (prev === key ? undefined : prev));
  }, [drop]);
  const fail = useCallback(async (key: string, err: unknown): Promise<void> => {
    setSaveErrors((prev) => ({ ...prev, [key]: saveErrorOf(err) }));
    if (statusOf(err) === NOT_FOUND) await afterWrite(); // removed elsewhere: the stale card goes
  }, [afterWrite]);
  const save = useCallback(async (key: string): Promise<void> => {
    const text = drafts[key];
    if (text === undefined || saving.current.has(key)) return;
    saving.current.add(key);
    setSaveErrors((prev) => without(prev, key));
    try {
      const { id } = await (key.startsWith(NEW)
        ? sendJson<{ id: string }>('POST', '/api/protocol/passages', { text })
        : sendJson<{ id: string }>('PUT', passagePath(key), { text }));
      await afterWrite(); // the saved text is in the read before the draft goes, so the card never flashes the old one
      setDrafts((prev) => (prev[key] === text ? without(prev, key) : prev)); // what was typed during the save stays a draft
      setSelected((prev) => (prev === key ? id : prev));
    } catch (err) {
      await fail(key, err);
    } finally {
      saving.current.delete(key);
    }
  }, [drafts, afterWrite, fail]);
  const remove = useCallback(async (id: string): Promise<void> => {
    setSaveErrors((prev) => without(prev, id));
    try {
      await sendJson('DELETE', passagePath(id));
    } catch (err) {
      await fail(id, err);
      return;
    }
    drop(id);
    setSelected((prev) => (prev === id ? undefined : prev));
    await afterWrite();
  }, [afterWrite, drop, fail]);
  return { drafts, saveErrors, selected, select: setSelected, insert, cancel, edit, save, remove };
}

/** The protocol screen's state (#337) on #336's routes, modelled on useMcp. Called in usePluginsDock, so the centre and the right pane share
 * the drafts, the selected passage and "view as". `isShown`: the plugins view shows the protocol screen. */
export function useProtocol(isShown: boolean): Protocol {
  const { read, loadError, load } = useProtocolRead(isShown);
  const { viewAs, rendered, renderError, setViewAs, fetchRender } = useRender(isShown);
  const afterWrite = useCallback(async (): Promise<void> => {
    await load();
    if (viewAs !== undefined) await fetchRender(viewAs);
  }, [load, viewAs, fetchRender]);
  const drafts = useDrafts(afterWrite);
  return { read, loadError, viewAs, setViewAs, rendered, renderError, ...drafts };
}
