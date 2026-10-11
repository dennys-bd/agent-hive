import { execFile } from 'node:child_process';

const API_ORIGIN = 'https://api.github.com';
const GH_MAX_BUFFER = 50 * 1024 * 1024; // a page of 100 issues with long bodies
const MS_PER_SECOND = 1000;

/** GitHub's REST quota as the x-ratelimit-* headers report it (#765). */
export interface RestQuota { limit: number; remaining: number; used: number; resetsAt: string }

/** A conditional GET's answer (#765): a 200 with its JSON, ETag and next page; a 304; or gone (301 moved, 404, 410). */
export type RestAnswer =
  | { status: 200; body: unknown; etag?: string; next?: string; quota?: RestQuota }
  | { status: 304; quota?: RestQuota }
  | { status: 301 | 404 | 410; quota?: RestQuota };

/** One GET of an API path (`repos/{o}/{r}/issues?…`, no leading slash), sending `etag` as If-None-Match when given. */
export type RestGet = (path: string, etag?: string) => Promise<RestAnswer>;

/** `gh` with argv → stdout; a run that failed on an HTTP status still resolves with what -i printed. */
export type GhRun = (args: string[]) => Promise<string>;

export const ghRun: GhRun = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { maxBuffer: GH_MAX_BUFFER }, (err, stdout, stderr) => {
    // gh exits 1 on a 304 or a 4xx, yet -i has already printed the status line and the headers: that output is the answer
    if (stdout.startsWith('HTTP/')) resolve(stdout);
    else reject(new Error(`gh api: ${stderr.trim() || (err?.message ?? 'no answer')}`));
  });
});

interface RawHttp { status: number; headers: Map<string, string>; body: string }

function parseHttp(raw: string): RawHttp {
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

// Only GitHub's own API is followed, and only within the listed repository (by name, or by id as GitHub's own Links spell it): anything else
// is an error, since a silent end of paging would pass a partial listing off as complete
function nextOf(link: string | undefined, requested: string): string | undefined {
  const url = link === undefined ? undefined : /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  if (url === undefined) return undefined;
  const parsed = new URL(url);
  const home = `/${requested.split('/').slice(0, 3).join('/').toLowerCase()}/`;
  const path = parsed.pathname.toLowerCase();
  if (parsed.origin !== API_ORIGIN || !(path.startsWith(home) || /^\/repositories\/\d+\//.test(path))) throw new Error('github rest: a next page left the repository');
  return `${parsed.pathname.slice(1)}${parsed.search}`;
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('github rest: invalid JSON body'); // JSON.parse's message would quote the body
  }
}

const isGone = (status: number): status is 301 | 404 | 410 => status === 301 || status === 404 || status === 410;

function answerOf(raw: RawHttp, requested: string): RestAnswer {
  const quota = quotaOf(raw.headers);
  const extra = quota === undefined ? {} : { quota };
  if (raw.status === 304) return { status: 304, ...extra };
  if (isGone(raw.status)) return { status: raw.status, ...extra };
  if (raw.status !== 200) throw new Error(`github rest: HTTP ${raw.status}`);
  const etag = raw.headers.get('etag');
  const next = nextOf(raw.headers.get('link'), requested);
  return { status: 200, body: parseBody(raw.body), ...(etag === undefined ? {} : { etag }), ...(next === undefined ? {} : { next }), ...extra };
}

/** The read transport over `gh api -i` (#765): gh holds the login, so no token passes through the Hive. */
export function ghRest(run: GhRun = ghRun): RestGet {
  return async (path, etag) => answerOf(parseHttp(await run(['api', '-i', ...(etag === undefined ? [] : ['-H', `If-None-Match: ${etag}`]), path])), path);
}
