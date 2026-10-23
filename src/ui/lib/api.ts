// Thin fetch + JSON wrappers shared by every UI action. No DOM beyond fetch/Response, so node:test imports it from dist/src/ui/lib.

export async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({ error: res.statusText }))) as T & { error?: string; code?: unknown };
  // the status, for a caller that tells refusals apart; the refusal's code too when the route names one (#797),
  // and the whole body for a refusal that carries more than its words (#686: a failed field write's re-read item)
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, body: data, ...(typeof data.code === 'string' ? { code: data.code } : {}) });
  return data;
}

export function getJson<T>(path: string): Promise<T> {
  return fetch(path).then((res) => parseJson<T>(res));
}

/** A write's way through run mode (#469): ask before the fetch (a rejection stops it: the user's cancel, or a frozen run), written once it
 * answered, so the band re-reads its count. */
export interface WriteGate { ask(path: string): Promise<void>; written(): void }
/** The user cancelled the write in the popover: act and the editor's save drop it without a word (m-11). */
export class WriteCancelled extends Error { override readonly name = 'WriteCancelled'; }

const VIEW_STATE_PREFIX = '/view-state/'; // the window's layout: never an intervention (3.5 skips it too)
let writeGate: WriteGate | undefined;

/** Set once by run mode's boot (#469); a normal Hive never sets it. */
export const setWriteGate = (gate: WriteGate | undefined): void => { writeGate = gate; };

/** `send` behind the gate (#469). No gate, or the view state: at once, in the same tick, as every write went out before run mode. */
export function gated<T>(path: string, send: () => Promise<T>): Promise<T> {
  const gate = writeGate;
  if (gate === undefined || path.startsWith(VIEW_STATE_PREFIX)) return send();
  return gate.ask(path).then(() => send().finally(() => gate.written()));
}

interface SendOptions { keepalive?: boolean; signal?: AbortSignal } // signal: a request its caller may abort (#329: a review no longer shown)

/** `keepalive` lets the request outlive the page: the view state's flush on pagehide (#484). */
export function sendJson<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, { keepalive, signal }: SendOptions = {}): Promise<T> {
  return gated(path, () => fetch(path, {
    // x-hive-ui is the CSRF gate of every dashboard write (see server.ts): a form on another site cannot set it
    method, headers: { 'content-type': 'application/json', 'x-hive-ui': '1' },
    body: body === undefined ? undefined : JSON.stringify(body), keepalive, signal,
  }).then((res) => parseJson<T>(res)));
}

export const postJson = <T>(path: string, body?: unknown, opts: SendOptions = {}): Promise<T> => sendJson<T>('POST', path, body, opts);

/** A hive task made from a PR (#67): POST /tasks with the link as pr and the destination hive, the only one such a task has, so the answer is
 * always the task, never a source's notice. The title and stage are the caller's (the PR page sends the PR's title). */
export const createTaskFromPr = ({ url, title, stage, auto }: { url: string; title: string; stage: string; auto: boolean }): Promise<{ id: string; itemId: string }> =>
  postJson<{ id: string; itemId: string }>('/tasks', { title, stage, auto, pr: url, source: 'hive' });
