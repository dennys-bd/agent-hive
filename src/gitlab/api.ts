import { SourceNotConnectedError, SourceRateLimitError } from '../source-errors.js';
import { TOKEN_CHARS } from '../github-token.js';
import type { SourceQuota } from '../types.js';

const API_ROOT = '/api/v4/';
const FETCH_TIMEOUT_MS = 10_000; // no retry: the next round is the retry
const MS_PER_SECOND = 1000;
const DEFAULT_RETRY_WAIT_MS = 60_000; // a 429 with no usable Retry-After
const MAX_RETRY_WAIT_MS = 24 * 60 * 60 * 1000; // past it a Date overflows: a toISOString RangeError would replace the rate-limit error
const MAX_PAGES = 1000; // 100 000 items at GitLab's largest page: past it the Link is looping, not listing
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;
// Lowercase, no port: URL.origin lowercases and drops :443, so any other form fails the next page's origin check
const BARE_HOST = /^[a-z0-9.-]+$/;

/** One GitLab answer: the parsed JSON (undefined for an empty body, a 204), the next page as an API path, and the quota its headers report. */
export interface GitlabAnswer { body: unknown; next?: string; quota?: SourceQuota }

/** A non-2xx answer that is not a 401 or a 429; the status lets a caller tell a 404 from the rest. */
export class GitlabHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`gitlab api: HTTP ${status}`);
    this.name = 'GitlabHttpError';
    this.status = status;
  }
}

export interface GitlabApiDeps {
  host: string; // a bare host name, `gitlab.com` or a self-hosted one
  token: () => Promise<string>;
  fetch?: typeof fetch; // tests inject; default Node's
  now?: () => number; // tests inject; default Date.now
}

export interface GitlabApi {
  get: (path: string) => Promise<GitlabAnswer>;
  post: (path: string, body: unknown) => Promise<GitlabAnswer>;
  put: (path: string, body: unknown) => Promise<GitlabAnswer>;
  delete: (path: string) => Promise<GitlabAnswer>;
  graphql: (query: string, variables: Record<string, unknown>) => Promise<GitlabAnswer>;
}

/** `group/sub/project` as the one path segment GitLab's API takes for a project. */
export const projectPath = (path: string): string => encodeURIComponent(path);

// Number(null) and Number('') are 0: an absent or empty header must stay absent, or it would report a spent quota
const header = (headers: Headers, name: string): string | undefined => headers.get(name) || undefined;

function quotaOf(headers: Headers, now: number): SourceQuota | undefined {
  const [limit, remaining, reset] = ['limit', 'remaining', 'reset'].map((name) => Number(header(headers, `ratelimit-${name}`)));
  if (![limit, remaining, reset].every(Number.isFinite)) return undefined;
  return { limit, remaining, resetsAt: new Date(reset * MS_PER_SECOND).toISOString(), at: new Date(now).toISOString() };
}

/** Retry-After is seconds or an HTTP date; turned once into an absolute time so every reader compares it to now the same way. */
function retryAtOf(retryAfter: string | undefined, now: number): string {
  const seconds = retryAfter !== undefined && /^\d+$/.test(retryAfter) ? Number(retryAfter) * MS_PER_SECOND : undefined;
  const date = retryAfter === undefined ? Number.NaN : Date.parse(retryAfter);
  const wait = seconds ?? (Number.isFinite(date) ? Math.max(0, date - now) : DEFAULT_RETRY_WAIT_MS);
  return new Date(now + Math.min(wait, MAX_RETRY_WAIT_MS)).toISOString();
}

/** The Link's next page as an API path. A next page elsewhere throws rather than ending the listing: it never gets the token, and
 * taken for the last page it would make a reconciliation delete every row it did not see. */
function nextOf(link: string | undefined, host: string): string | undefined {
  const url = link === undefined ? undefined : /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  if (url === undefined) return undefined;
  const outside = new Error(`gitlab api: next page outside ${host}'s API`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw outside; // the URL's own error would quote it
  }
  if (parsed.origin !== `https://${host}` || !parsed.pathname.startsWith(API_ROOT)) throw outside;
  return `${parsed.pathname.slice(API_ROOT.length)}${parsed.search}`;
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('gitlab api: invalid JSON body'); // JSON.parse's message would quote the body
  }
}

// The server's wording, with the token cut out in case it echoes what it was sent
function graphqlFailure(body: unknown, token: string): Error | undefined {
  const errors = typeof body === 'object' && body !== null ? (body as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const message = (errors[0] as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message.split(token).join('[token]') : 'unknown error';
  return new Error(`gitlab graphql: ${text}`);
}

/** The only code that sends a GitLab token: a header on `https://<host>`, never a URL, a log line or an error. redirect 'manual' so a
 * redirect is an error and the token never follows it; no If-None-Match, since GitLab counts a 304 against its limit too. */
export function gitlabApi(deps: GitlabApiDeps): GitlabApi {
  const { host } = deps;
  if (!BARE_HOST.test(host)) throw new Error('gitlab: invalid host');
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  async function send(method: string, url: string, body?: unknown): Promise<{ answer: GitlabAnswer; token: string }> {
    const token = await deps.token();
    if (!TOKEN_CHARS.test(token)) throw new Error('gitlab: malformed token');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    const res = await doFetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) await res.body?.cancel(); // only a 2xx body is read; cancelling frees the connection
    if (res.status === HTTP_UNAUTHORIZED) {
      throw Object.assign(new SourceNotConnectedError(`gitlab ${host}`), { message: `GitLab refused the token for ${host}: connect it again in Settings` });
    }
    if (res.status === HTTP_TOO_MANY_REQUESTS) throw new SourceRateLimitError(retryAtOf(header(res.headers, 'retry-after'), now()));
    if (!ok) throw new GitlabHttpError(res.status);
    const text = await res.text(); // read before nextOf can throw, so the connection is freed either way
    const next = nextOf(header(res.headers, 'link'), host);
    const quota = quotaOf(res.headers, now());
    return { answer: { body: parseBody(text), ...(next === undefined ? {} : { next }), ...(quota === undefined ? {} : { quota }) }, token };
  }

  const call = async (method: string, path: string, body?: unknown): Promise<GitlabAnswer> => (await send(method, `https://${host}${API_ROOT}${path}`, body)).answer;
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    delete: (path) => call('DELETE', path),
    async graphql(query, variables) {
      const { answer, token } = await send('POST', `https://${host}/api/graphql`, { query, variables });
      const failure = graphqlFailure(answer.body, token);
      if (failure !== undefined) throw failure;
      return answer;
    },
  };
}

/** Every item of a listing, following the Link's next page. Past MAX_PAGES it throws, never truncates: a reconciliation reads a short list as complete. */
export async function listAll(api: Pick<GitlabApi, 'get'>, path: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page: string | undefined = path, count = 0; page !== undefined; count += 1) {
    if (count === MAX_PAGES) throw new Error(`gitlab api: more than ${MAX_PAGES} pages`);
    const { body, next } = await api.get(page);
    if (!Array.isArray(body)) throw new Error('gitlab api: expected a list');
    items.push(...body);
    page = next;
  }
  return items;
}
