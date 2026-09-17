// Thin fetch + JSON wrappers shared by every UI action. No DOM beyond fetch/Response, so node:test imports it from dist/src/ui/lib.

export async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({ error: res.statusText }))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export function getJson<T>(path: string): Promise<T> {
  return fetch(path).then((res) => parseJson<T>(res));
}

export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    // x-hive-ui is the CSRF gate of every dashboard route: a form on another site cannot set it (see server.ts)
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => parseJson<T>(res));
}
