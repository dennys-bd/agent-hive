import { execFile } from 'node:child_process';
import { childEnv } from '../github-token.js';

const API_ORIGIN = 'https://api.github.com';
const GH_MAX_BUFFER = 50 * 1024 * 1024; // a page of 100 issues with long bodies
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

/** `gh` with argv → stdout; a run that failed on an HTTP status still resolves with what -i printed. `env` reaches gh's environment only
 * (the api transport's GH_TOKEN, #180): never its argv. */
export type GhRun = (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;

const MAX_STDERR_CHARS = 200;

// gh's stderr can echo a request: its first line, cut short, is all an error message carries
export const firstLineOf = (stderr: string): string => (stderr.trim().split(/\r?\n/)[0] ?? '').slice(0, MAX_STDERR_CHARS);

export const ghRun: GhRun = (args, env) => new Promise((resolve, reject) => {
  const options = { maxBuffer: GH_MAX_BUFFER, ...(env === undefined ? {} : { env: childEnv(process.env, env) }) };
  execFile('gh', args, options, (err, stdout, stderr) => {
    // gh exits 1 on a 304 or a 4xx, yet -i has already printed the status line and the headers: that output is the answer
    if (stdout.startsWith('HTTP/')) resolve(stdout);
    else reject(new Error(`gh api: ${firstLineOf(stderr) || (err?.message ?? 'no answer')}`));
  });
});

export interface RawHttp { status: number; headers: Map<string, string>; body: string }

/** gh's -i output: the status line ends in \n, the headers in \r\n, so every split accepts both. Header names are lowercased. */
export function parseHttp(raw: string): RawHttp {
  const split = /\r?\n\r?\n/.exec(raw);
  const head = split === null ? raw : raw.slice(0, split.index);
  const body = split === null ? '' : raw.slice(split.index + split[0].length);
  const [statusLine = '', ...lines] = head.split(/\r?\n/);
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isInteger(status)) throw new Error('github rest: no HTTP status line');
  const headers = new Map(lines.flatMap((line): [string, string][] => {
    const colon = line.indexOf(':');
    return colon < 0 ? [] : [[line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]];
  }));
  return { status, headers, body };
}

function quotaOf(headers: Map<string, string>): RestQuota | undefined {
  const [limit, remaining, used, reset] = ['limit', 'remaining', 'used', 'reset'].map((name) => Number(headers.get(`x-ratelimit-${name}`)));
  if (![limit, remaining, used, reset].every(Number.isFinite)) return undefined;
  return { limit, remaining, used, resetsAt: new Date(reset * MS_PER_SECOND).toISOString() };
}

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

function answerOf(raw: RawHttp, path: string): RestAnswer {
  const quota = quotaOf(raw.headers);
  const extra = quota === undefined ? {} : { quota };
  if (raw.status === 304) return { status: 304, ...extra };
  if (isGone(raw.status)) return { status: raw.status, ...extra };
  if (raw.status !== 200) throw new Error(`github rest: HTTP ${raw.status}`);
  const etag = raw.headers.get('etag');
  const next = nextOf(raw.headers.get('link'), path);
  return { status: 200, body: parseBody(raw.body), ...(etag === undefined ? {} : { etag }), ...(next === undefined ? {} : { next }), ...extra };
}

/** The read transport over `gh api -i`: gh holds the login, so no token passes through the Hive's argv; `env` is handed to every run. */
export function ghRest(run: GhRun = ghRun, env?: NodeJS.ProcessEnv): RestGet {
  return async (path, etag) => answerOf(parseHttp(await run(['api', '-i', ...(etag === undefined ? [] : ['-H', `If-None-Match: ${etag}`]), path], env)), path);
}
