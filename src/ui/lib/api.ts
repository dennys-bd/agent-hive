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

/** `keepalive` lets the request outlive the page: the view state's flush on pagehide (#484). */
export function sendJson<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, { keepalive }: { keepalive?: boolean } = {}): Promise<T> {
  return fetch(path, {
    // x-hive-ui is the CSRF gate of every dashboard write (see server.ts): a form on another site cannot set it
    method, headers: { 'content-type': 'application/json', 'x-hive-ui': '1' },
    body: body === undefined ? undefined : JSON.stringify(body), keepalive,
  }).then((res) => parseJson<T>(res));
}

export const postJson = <T>(path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> => sendJson<T>('POST', path, body, opts);

/** A hive task made from a PR (#67): POST /tasks with the link as pr and the destination hive, the only one such a task has, so the answer is
 * always the task, never a source's notice. The title and stage are the caller's (the PR page sends the PR's title). */
export const createTaskFromPr = ({ url, title, stage, auto }: { url: string; title: string; stage: string; auto: boolean }): Promise<{ id: string; itemId: string }> =>
  postJson<{ id: string; itemId: string }>('/tasks', { title, stage, auto, pr: url, source: 'hive' });
