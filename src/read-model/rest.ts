const API_ORIGIN = 'https://api.github.com';
const MS_PER_SECOND = 1000;
// The two forms GitHub gives one repository's listing: by name, and by id in the Links of its later pages
const REPOSITORY_SCOPE = /^(repos\/[^/]+\/[^/]+\/|repositories\/\d+\/)/;

/** GitHub's REST quota as the x-ratelimit-* headers report it. */
export interface RestQuota { limit: number; remaining: number; used: number; resetsAt: string }

/** A conditional GET's answer: a 200 with its JSON, ETag and next page; a 304; or gone (301 moved, 404, 410). */
export type RestAnswer =
  | { status: 200; body: unknown; etag?: string; next?: string; quota?: RestQuota }
  | { status: 304; quota?: RestQuota }
  | { status: 301 | 404 | 410; quota?: RestQuota };

/** One GET of an API path (`repos/{o}/{r}/issues?…`, no leading slash), sending `etag` as If-None-Match when given. */
export type RestGet = (path: string, etag?: string) => Promise<RestAnswer>;

// A listing by name links its later pages by the repository's id, which the requested path does not name
function sameRepository(from: string | undefined, to: string): boolean {
  if (from === undefined) return false;
  if (from.toLowerCase() === to.toLowerCase()) return true;
  return from.startsWith('repos/') && to.startsWith('repositories/');
}

/** The Link's next page as an API path. A next page elsewhere throws rather than ending the listing: it never gets the login's
 * credentials, and taken for the last page it would make a reconciliation delete every row it did not see. */
export function nextOf(link: string | undefined, path: string): string | undefined {
  const url = link === undefined ? undefined : /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  if (url === undefined) return undefined;
  const parsed = new URL(url);
  const next = `${parsed.pathname.slice(1)}${parsed.search}`;
  const to = REPOSITORY_SCOPE.exec(next)?.[1];
  if (parsed.origin !== API_ORIGIN || to === undefined || !sameRepository(REPOSITORY_SCOPE.exec(path)?.[1], to)) {
    throw new Error('github rest: next page outside the repository');
  }
  return next;
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('github rest: invalid JSON body'); // JSON.parse's message would quote the body
  }
}

const isGone = (status: number): status is 301 | 404 | 410 => status === 301 || status === 404 || status === 410;

const FETCH_TIMEOUT_MS = 10_000; // apiGql's: no retry, the next round is the retry
const UNAUTHORIZED = 401;

// Number(null) is 0: an absent header must stay absent, or a 404 would report a spent quota
const header = (headers: Headers, name: string): string | undefined => headers.get(name) ?? undefined;

function quotaOf(headers: Headers): RestQuota | undefined {
  const [limit, remaining, used, reset] = ['limit', 'remaining', 'used', 'reset'].map((name) => Number(header(headers, `x-ratelimit-${name}`)));
  if (![limit, remaining, used, reset].every(Number.isFinite)) return undefined;
  return { limit, remaining, used, resetsAt: new Date(reset * MS_PER_SECOND).toISOString() };
}

function answerOf(status: number, headers: Headers, body: string, path: string): RestAnswer {
  const quota = quotaOf(headers);
  const extra = quota === undefined ? {} : { quota };
  if (status === 304) return { status: 304, ...extra };
  if (isGone(status)) return { status, ...extra };
  if (status !== 200) throw new Error(`github rest: HTTP ${status}`);
  const etag = header(headers, 'etag');
  const next = nextOf(header(headers, 'link'), path);
  return { status: 200, body: parseBody(body), ...(etag === undefined ? {} : { etag }), ...(next === undefined ? {} : { next }), ...extra };
}

export interface HttpRestDeps {
  token: () => Promise<string>; // cli: the GhToken's; api: the stored one
  onUnauthorized?: () => void; // cli (#503): a 401 drops the held token; the next round reads it again
  fetch?: typeof fetch; // tests inject; default Node's
}

/** The read transport for both auth modes (#503): one HTTPS GET, no process. The token is a header only, never in a URL, a log line or an
 * error; redirect 'manual' keeps a 301 as the moved answer the sync reads, and the bearer never follows it. */
export function httpRest(deps: HttpRestDeps): RestGet {
  const doFetch = deps.fetch ?? globalThis.fetch;
  return async (path, etag) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await deps.token()}`, Accept: 'application/vnd.github+json', ...(etag === undefined ? {} : { 'If-None-Match': etag }),
    };
    const res = await doFetch(`${API_ORIGIN}/${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === UNAUTHORIZED) deps.onUnauthorized?.();
    if (res.status !== 200) await res.body?.cancel(); // only a 200's body is read; cancelling frees the connection
    return answerOf(res.status, res.headers, res.status === 200 ? await res.text() : '', path);
  };
}
