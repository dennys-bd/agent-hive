import { jiraCredential, type JiraCredential } from '../credentials.js';
import { SourceNotConnectedError, SourceRateLimitError } from '../source-errors.js';

const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const MS_PER_SECOND = 1000;
const UNAUTHORIZED = 401;
const TOO_MANY_REQUESTS = 429;
const NO_CONTENT = 204;
const NOT_FOUND = 404;
// A bare lowercase host: the credential only ever goes to a host the user named, never to one smuggled in through a scheme, path, port or userinfo.
export const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A 404 (#820): typed, so a reader tells a gone issue apart without matching message text. The message is the transport's, as before. */
export class JiraNotFoundError extends Error {
  constructor() {
    super(`jira api: HTTP ${NOT_FOUND}`);
    this.name = 'JiraNotFoundError';
  }
}

/** Any other non-ok answer (#823): typed, so a caller tells refusals apart by status and by the keys of Jira's `errors` object. Only the keys
 * are kept, since the messages beside them can quote the issue, and the message is the transport's, as before. */
export class JiraHttpError extends Error {
  readonly status: number;
  readonly errorKeys: string[];
  constructor(status: number, errorKeys: string[]) {
    super(`jira api: HTTP ${status}`);
    this.name = 'JiraHttpError';
    this.status = status;
    this.errorKeys = errorKeys;
  }
}

/** The keys of a Jira answer's `errors` object; [] when the body is not an object or has none. */
export function errorKeysOf(body: unknown): string[] {
  const errors = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).errors : undefined;
  return typeof errors === 'object' && errors !== null && !Array.isArray(errors) ? Object.keys(errors) : [];
}

export interface JiraFetchDeps {
  /** Where the login comes from; the stored one by default, so another login can supply it without this function changing. */
  credential?: (site: string) => Promise<JiraCredential | undefined>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

// Retry-After is delta-seconds or an HTTP date. A missing, unreadable, zero or past one waits the default, so it never turns into an instant
// retry loop; a huge one is capped, so it can neither park the source for a year nor overflow Date and lose the rate-limit error.
function retryAtOf(header: string | null, now: number): string {
  const value = header?.trim() ?? '';
  const ms = /^\d+$/.test(value) ? Number(value) * MS_PER_SECOND : Date.parse(value) - now;
  const wait = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_MS) : DEFAULT_RETRY_MS;
  return new Date(now + wait).toISOString();
}

/** One call to a Jira Cloud site's REST API v3. The token exists only inside it: no message or rejection carries it, the header or a body. */
export async function jiraFetch(site: string, path: string, init: RequestInit = {}, deps: JiraFetchDeps = {}): Promise<unknown> {
  if (!BARE_HOST.test(site)) throw new Error('jira site must be a bare lowercase hostname');
  if (!path.startsWith('/')) throw new Error('jira api path must start with /'); // a caller's bug fails here, not as a 404 on /rest/api/3issue
  const source = `jira:${site}`;
  const cred = await (deps.credential ?? ((s: string) => jiraCredential(s, deps.env)))(site);
  if (cred === undefined) throw new SourceNotConnectedError(source);
  const basic = Buffer.from(`${cred.email}:${cred.token}`).toString('base64');
  const res = await (deps.fetch ?? globalThis.fetch)(`https://${site}/rest/api/3${path}`, {
    ...init,
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'content-type': 'application/json' },
    redirect: 'manual', // the credential never follows a redirect off the named host
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // no retry: the next poll is the retry
  });
  if (res.status === UNAUTHORIZED) throw new SourceNotConnectedError(source);
  if (res.status === TOO_MANY_REQUESTS) throw new SourceRateLimitError(retryAtOf(res.headers.get('retry-after'), (deps.now ?? Date.now)()));
  if (res.status === NOT_FOUND) throw new JiraNotFoundError();
  // the catch keeps a body that is not JSON (and res.json's message quoting it) out
  if (!res.ok) throw new JiraHttpError(res.status, errorKeysOf(await res.json().catch(() => undefined)));
  if (res.status === NO_CONTENT) return undefined;
  return res.json().catch(() => {
    throw new Error('jira api: invalid JSON body'); // res.json() would quote the body
  });
}
