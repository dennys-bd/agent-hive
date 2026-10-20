import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExternalMcpServer, McpServerState } from '../../types';
import { statusOf } from '@/hooks/use-plugins';
import type { MessageKey } from '@/i18n';
import { getJson, sendJson } from '@/lib/api';

export interface McpTool { name: string; locked: boolean; on: boolean }
export type McpServerRow = ExternalMcpServer & { hasValue: boolean; state: McpServerState | 'checking' };
export interface McpRead { tools: McpTool[]; servers: McpServerRow[] }
/** A server as the form sends it: the definition, plus a header value to store, to clear, or to leave as it is. */
export interface ServerDraft { server: ExternalMcpServer; value?: string | null } // string: store; null: clear; undefined: keep

export interface Mcp {
  read?: McpRead; // undefined until the first read answers
  hasFailed: boolean;
  error?: MessageKey; // the last refused switch or scope change, or a header value not stored, until the next write
  setTool(name: string, on: boolean): Promise<void>;
  setServer(name: string, server: ExternalMcpServer): Promise<void>; // the row's switch and scope: optimistic PUT
  saveServer(previous: string | undefined, draft: ServerDraft): Promise<MessageKey | undefined>; // the form: POST or PUT, then the value
  removeServer(name: string): Promise<MessageKey | undefined>;
  reload(): Promise<void>; // a failed read's retry
}

export const VALUE_NOT_SAVED: MessageKey = 'plugins.mcp.valueNotSaved';
// A refusal's HTTP status as copy: the route's own English sentence never reaches the screen
const REFUSAL: Readonly<Record<number, MessageKey>> = { 400: 'plugins.mcp.refused', 404: 'plugins.mcp.gone' };
const refusalOf = (err: unknown): MessageKey => REFUSAL[statusOf(err)] ?? 'plugins.mcp.failed';
const serverPath = (name: string): string => `/api/mcp/servers/${encodeURIComponent(name)}`;
// Anything but the route's shape is a failed read: another test's or a proxy's `{ ok: true }` must not render as an empty screen
const isRead = (answer: unknown): answer is McpRead =>
  typeof answer === 'object' && answer !== null && Array.isArray((answer as Partial<McpRead>).tools) && Array.isArray((answer as Partial<McpRead>).servers);

/** The definition alone, as the routes take it: a row's hasValue and state, and anything else a read carried, left out. */
export function bareOf(server: ExternalMcpServer): ExternalMcpServer {
  const base = { name: server.name, workspace: server.workspace, on: server.on };
  if (!('url' in server)) return { ...base, command: server.command, args: server.args };
  return server.authHeader === undefined ? { ...base, url: server.url } : { ...base, url: server.url, authHeader: server.authHeader };
}

// The row as a switch or a scope leaves it: switched on, it is checking until the re-read probes it; switched off, it is off
function rowOf(row: McpServerRow, server: ExternalMcpServer): McpServerRow {
  let state: McpServerRow['state'] = row.state;
  if (!server.on) state = 'off';
  else if (!row.on) state = 'checking';
  return { ...bareOf(server), hasValue: row.hasValue, state };
}

// The header value's own call once the definition saved
async function sendValue(name: string, value: string | null | undefined): Promise<MessageKey | undefined> {
  if (value === undefined) return undefined;
  const path = `${serverPath(name)}/value`;
  try {
    await (value === null ? sendJson('DELETE', path) : sendJson('PUT', path, { value }));
    return undefined;
  } catch {
    return VALUE_NOT_SAVED;
  }
}

// On mount and after each write; only the latest read lands (a cold read waits up to 5 s on the probes); a failed re-read keeps the last answer
function useMcpRead() {
  const [read, setRead] = useState<McpRead>();
  const [hasFailed, setFailed] = useState(false);
  const shown = useRef<McpRead | undefined>(undefined); // what the screen shows: an optimistic write's snapshot, read outside a render
  const reads = useRef(0);
  const show = useCallback((next: McpRead): void => {
    shown.current = next;
    setRead(next);
  }, []);
  const load = useCallback(async (): Promise<void> => {
    const n = ++reads.current;
    const answer = await getJson<unknown>('/api/mcp').catch(() => undefined);
    if (n !== reads.current) return;
    if (isRead(answer)) show(answer);
    setFailed(!isRead(answer));
  }, [show]);
  useEffect(() => {
    void load();
  }, [load]);
  // A read already in flight answers what the route held before an optimistic change: it must not land over it
  const discardReads = useCallback((): void => {
    reads.current += 1;
  }, []);
  return { read, hasFailed, shown, show, load, discardReads };
}

// The form's writes: not optimistic, since parseMcp may refuse them; the route answers first, then the list is read again
function useServerWrites(load: () => Promise<void>, setError: (error: MessageKey | undefined) => void) {
  const saveServer = useCallback(async (previous: string | undefined, { server, value }: ServerDraft): Promise<MessageKey | undefined> => {
    setError(undefined);
    try {
      const definition = bareOf(server);
      await (previous === undefined ? sendJson('POST', '/api/mcp/servers', definition) : sendJson('PUT', serverPath(previous), definition));
    } catch (err) {
      return refusalOf(err);
    }
    // #333's PUT already dropped the old value when the URL or the header changed (sameTarget): only the form's own value is sent
    const refused = await sendValue(server.name, value);
    setError(refused); // the form closes once the definition saved, so a value not stored shows on the screen
    await load();
    return refused;
  }, [load, setError]);
  const removeServer = useCallback(async (name: string): Promise<MessageKey | undefined> => {
    setError(undefined);
    try {
      await sendJson('DELETE', serverPath(name));
    } catch (err) {
      return refusalOf(err);
    }
    await load();
    return undefined;
  }, [load, setError]);
  return { saveServer, removeServer };
}

/** The mcp screen's state (#334): #333's GET /api/mcp and its writes. A switch or a scope is optimistic (the change on screen at once, the
 * snapshot back and the refusal's copy on a refusal); the form's writes wait for the route. */
export function useMcp(): Mcp {
  const { read, hasFailed, shown, show, load, discardReads } = useMcpRead();
  const [error, setError] = useState<MessageKey>();
  const optimistic = useCallback(async (change: (r: McpRead) => McpRead, send: () => Promise<unknown>): Promise<void> => {
    const snapshot = shown.current;
    if (snapshot === undefined) return;
    setError(undefined);
    discardReads();
    show(change(snapshot));
    try {
      await send();
    } catch (err) {
      show(snapshot);
      setError(refusalOf(err));
    }
    await load(); // either way the screen ends on what the route saved
  }, [shown, show, load, discardReads]);
  const setTool = useCallback((name: string, on: boolean): Promise<void> => optimistic(
    (r) => ({ ...r, tools: r.tools.map((tool) => (tool.name === name ? { ...tool, on } : tool)) }),
    () => sendJson('PUT', `/api/mcp/tools/${encodeURIComponent(name)}`, { on }),
  ), [optimistic]);
  const setServer = useCallback((name: string, server: ExternalMcpServer): Promise<void> => optimistic(
    (r) => ({ ...r, servers: r.servers.map((row) => (row.name === name ? rowOf(row, server) : row)) }),
    () => sendJson('PUT', serverPath(name), bareOf(server)),
  ), [optimistic]);
  const { saveServer, removeServer } = useServerWrites(load, setError);
  return { read, hasFailed, error, setTool, setServer, saveServer, removeServer, reload: load };
}
