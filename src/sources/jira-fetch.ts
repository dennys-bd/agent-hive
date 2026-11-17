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
const BAD_REQUEST = 400;
// One transport for both REST APIs (#826): the platform's and the Agile API's, which alone answers boards and sprints
const API_BASE = { platform: '/rest/api/3', agile: '/rest/agile/1.0' } as const;
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

const errorText = (errors: Record<string, string>, messages: readonly string[], names: Record<string, string>): string =>
  [...Object.entries(errors).map(([id, message]) => `${Object.hasOwn(names, id) ? names[id] : id}: ${message}`), ...messages].join('; ');

/** A 400 with Jira's reason (#826): its errors keyed by field id and its errorMessages, the body's only parts ever shown. It is still a
 * JiraHttpError, so the #823 refusals read it by status and keys. */
export class JiraBadRequestError extends JiraHttpError {
  constructor(keys: string[], readonly errors: Record<string, string>, readonly messages: readonly string[]) {
    super(BAD_REQUEST, keys);
    this.name = 'JiraBadRequestError';
    this.message = errorText(errors, messages, {});
  }
  /** The same reason with each field id as its name, where `names` has it: the transport knows no names, the field write does. */
  named(names: Record<string, string>): string {
    return errorText(this.errors, this.messages, names);
  }
}

// The body is read only for those two keys; one with neither, or no JSON, keeps the status-only message
async function badRequest(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined);
  const json = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const raw = typeof json.errors === 'object' && json.errors !== null && !Array.isArray(json.errors) ? Object.entries(json.errors) : [];
  const errors = Object.fromEntries(raw.filter((e): e is [string, string] => typeof e[1] === 'string'));
  const messages = Array.isArray(json.errorMessages) ? json.errorMessages.filter((m): m is string => typeof m === 'string') : [];
  const keys = raw.map(([key]) => key);
  return Object.keys(errors).length === 0 && messages.length === 0 ? new JiraHttpError(BAD_REQUEST, keys) : new JiraBadRequestError(keys, errors, messages);
}

export interface JiraFetchDeps {
  /** Where the login comes from; the stored one by default, so another login can supply it without this function changing. */
  credential?: (site: string) => Promise<JiraCredential | undefined>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  api?: keyof typeof API_BASE; // #826: platform by default
}

// Retry-After is delta-seconds or an HTTP date. A missing, unreadable, zero or past one waits the default, so it never turns into an instant
// retry loop; a huge one is capped, so it can neither park the source for a year nor overflow Date and lose the rate-limit error.
function retryAtOf(header: string | null, now: number): string {
  const value = header?.trim() ?? '';
  const ms = /^\d+$/.test(value) ? Number(value) * MS_PER_SECOND : Date.parse(value) - now;
  const wait = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_MS) : DEFAULT_RETRY_MS;
  return new Date(now + wait).toISOString();
}

/** One call to a Jira Cloud site's REST API v3, or its Agile API (`api: 'agile'`, #826). The token exists only inside it: no message or rejection carries it, the header or a body. */
export async function jiraFetch(site: string, path: string, init: RequestInit = {}, deps: JiraFetchDeps = {}): Promise<unknown> {
  if (!BARE_HOST.test(site)) throw new Error('jira site must be a bare lowercase hostname');
  if (!path.startsWith('/')) throw new Error('jira api path must start with /'); // a caller's bug fails here, not as a 404 on /rest/api/3issue
  const source = `jira:${site}`;
  const cred = await (deps.credential ?? ((s: string) => jiraCredential(s, deps.env)))(site);
  if (cred === undefined) throw new SourceNotConnectedError(source);
  const basic = Buffer.from(`${cred.email}:${cred.token}`).toString('base64');
  const res = await (deps.fetch ?? globalThis.fetch)(`https://${site}${API_BASE[deps.api ?? 'platform']}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'content-type': 'application/json' },
    redirect: 'manual', // the credential never follows a redirect off the named host
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // no retry: the next poll is the retry
  });
  if (res.status === UNAUTHORIZED) throw new SourceNotConnectedError(source);
  if (res.status === TOO_MANY_REQUESTS) throw new SourceRateLimitError(retryAtOf(res.headers.get('retry-after'), (deps.now ?? Date.now)()));
  if (res.status === NOT_FOUND) throw new JiraNotFoundError();
  if (res.status === BAD_REQUEST) throw await badRequest(res);
  // the catch keeps a body that is not JSON (and res.json's message quoting it) out
  if (!res.ok) throw new JiraHttpError(res.status, errorKeysOf(await res.json().catch(() => undefined)));
  if (res.status === NO_CONTENT) return undefined;
  return res.json().catch(() => {
    throw new Error('jira api: invalid JSON body'); // res.json() would quote the body
  });
}
