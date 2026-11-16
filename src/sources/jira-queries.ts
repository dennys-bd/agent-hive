import { WireError } from '../read-model/normalize.js';

/** One call to the site's REST API v3, path from /rest/api/3 on. 5.2 binds it from jiraFetch, so the site and the credential stay in the transport. */
export type JiraCall = (path: string, init?: RequestInit) => Promise<unknown>;
/** A field's schema as Jira answers it; an array's element kind is `items`. */
export interface JiraSchema { type: string; items?: string }
/** One issue as a search or a read answers it. id and key are checked by the mapping (jira-item.ts), since a reconcile asks only id. */
export interface JiraIssue { id?: string; key?: string; fields: Record<string, unknown> }
/** What every page and a single read carry with `expand=names,schema`: each field id's name and schema, so the mapping never reads source_fields. */
export interface JiraFieldMeta { names: Record<string, string>; schema: Record<string, JiraSchema> }
export interface JiraSearchPage extends JiraFieldMeta { issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }

export const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const ISSUE_REF = /^(\d+|[A-Z][A-Z0-9_]*-\d+)$/;
export const SEARCH_FIELDS: readonly string[] = ['*navigable', 'description']; // description named in case *navigable leaves it out
export const SEARCH_EXPAND = 'names,schema';
export const PAGE_SIZE = 100;
const MINUTE_MS = 60_000;

type Json = Record<string, unknown>;

function recordAt(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError(what);
  return value as Json;
}
function arrayAt(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new WireError(what);
  return value;
}
function textAt(json: Json, key: string, what: string): string {
  const value = json[key];
  if (typeof value !== 'string') throw new WireError(`${what} ${key}`);
  return value;
}
const optionalText = (json: Json, key: string, what: string): string | undefined => (json[key] === undefined ? undefined : textAt(json, key, what));

/** A parseable date string as UTC ISO: the store compares updated_at as text, so every date is written in one zone. */
export function utcIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The project key is the user's text from Settings: checked before any query, since it is the only thing interpolated into JQL. */
export function projectJql(key: string, minutes?: number): string {
  if (!PROJECT_KEY.test(key)) throw new Error('jira project key is not a Jira key');
  const since = minutes === undefined ? '' : ` AND updated >= "-${minutes}m"`;
  return `project = "${key}"${since} ORDER BY key ASC`;
}

// JQL compares to the minute, in the profile's zone: a relative date has no zone, and the extra minute covers the truncation and clock skew
export function sinceMinutes(cursor: string, now: number): number | undefined {
  const at = Date.parse(cursor);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((now - at) / MINUTE_MS) + 1) : undefined;
}

function schemaOf(value: unknown): JiraSchema | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { type, items } = value as Json;
  if (typeof type !== 'string') return undefined;
  return typeof items === 'string' ? { type, items } : { type };
}

// Anything unreadable is dropped, which becomes "unknown kind, no row" downstream, never a refusal
function metaOf(json: Json): JiraFieldMeta {
  const names = Object.fromEntries(Object.entries(typeof json.names === 'object' && json.names !== null ? json.names : {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const schema = Object.fromEntries(Object.entries(typeof json.schema === 'object' && json.schema !== null ? json.schema : {})
    .flatMap(([id, value]): [string, JiraSchema][] => { const s = schemaOf(value); return s === undefined ? [] : [[id, s]]; }));
  return { names, schema };
}

function issueAt(value: unknown, what: string): JiraIssue {
  const issue = recordAt(value, what);
  return {
    id: optionalText(issue, 'id', what), key: optionalText(issue, 'key', what),
    fields: issue.fields === undefined ? {} : recordAt(issue.fields, `${what} fields`),
  };
}

function searchPageOf(value: unknown): JiraSearchPage {
  const page = recordAt(value, 'jira search page');
  return {
    issues: arrayAt(page.issues, 'jira search issues').map((i) => issueAt(i, 'jira search issue')),
    ...metaOf(page), nextPageToken: optionalText(page, 'nextPageToken', 'jira search'), isLast: page.isLast === true,
  };
}

/** Every page of a JQL search, merged. A repeated token throws: a server answering the same one forever would otherwise page forever. */
export async function searchIssues(call: JiraCall, jql: string, fields: readonly string[], expand?: string): Promise<JiraFieldMeta & { issues: JiraIssue[] }> {
  const pages: JiraSearchPage[] = [];
  let token: string | undefined;
  do {
    const body = JSON.stringify({ jql, fields, expand, maxResults: PAGE_SIZE, nextPageToken: token });
    const page = searchPageOf(await call('/search/jql', { method: 'POST', body }));
    if (page.nextPageToken !== undefined && page.nextPageToken === token) throw new WireError('jira search nextPageToken');
    pages.push(page);
    token = page.isLast === true ? undefined : page.nextPageToken;
  } while (token !== undefined);
  const merge = (pick: (p: JiraSearchPage) => Json): Json => Object.fromEntries(pages.flatMap((p) => Object.entries(pick(p))));
  return {
    issues: pages.flatMap((p) => p.issues),
    names: merge((p) => p.names) as Record<string, string>,
    schema: merge((p) => p.schema) as Record<string, JiraSchema>,
  };
}

export async function readIssue(call: JiraCall, idOrKey: string): Promise<JiraFieldMeta & { issue: JiraIssue }> {
  if (!ISSUE_REF.test(idOrKey)) throw new Error('jira issue id or key is not one');
  const query = new URLSearchParams({ fields: SEARCH_FIELDS.join(','), expand: SEARCH_EXPAND });
  const json = recordAt(await call(`/issue/${encodeURIComponent(idOrKey)}?${query}`), 'jira issue');
  return { issue: issueAt(json, 'jira issue'), ...metaOf(json) };
}
