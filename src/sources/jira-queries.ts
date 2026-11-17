import { WireError } from '../read-model/normalize.js';
import { type AdfNode, adfToMarkdown } from './adf.js';

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
// A hard stop for a server that never ends its paging: 1000 pages of 100 is far past any project the Hive lists
const MAX_PAGES = 1000;

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

/** Every page of a JQL search, merged. A token seen before throws, and so does paging past MAX_PAGES: a server cycling its tokens would
 * otherwise page forever and hold every page in memory. */
export async function searchIssues(call: JiraCall, jql: string, fields: readonly string[], expand?: string): Promise<JiraFieldMeta & { issues: JiraIssue[] }> {
  const pages: JiraSearchPage[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    if (pages.length >= MAX_PAGES) throw new WireError('jira search page count');
    const body = JSON.stringify({ jql, fields, expand, maxResults: PAGE_SIZE, nextPageToken: token });
    const page = searchPageOf(await call('/search/jql', { method: 'POST', body }));
    if (page.nextPageToken !== undefined && seen.has(page.nextPageToken)) throw new WireError('jira search nextPageToken');
    if (page.nextPageToken !== undefined) seen.add(page.nextPageToken);
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

/** The path of one issue (#819, #820): the user's or Jira's id or key, checked and encoded before it reaches a REST path. */
export function issuePath(idOrKey: string): string {
  if (!ISSUE_REF.test(idOrKey)) throw new Error('jira issue id or key is not one');
  return `/issue/${encodeURIComponent(idOrKey)}`;
}

export async function readIssue(call: JiraCall, idOrKey: string): Promise<JiraFieldMeta & { issue: JiraIssue }> {
  const query = new URLSearchParams({ fields: SEARCH_FIELDS.join(','), expand: SEARCH_EXPAND });
  const json = recordAt(await call(`${issuePath(idOrKey)}?${query}`), 'jira issue');
  return { issue: issueAt(json, 'jira issue'), ...metaOf(json) };
}

export interface JiraFieldDef { id: string; name: string; schema: JiraSchema | null }
/** A workflow status; category is its statusCategory key (new, indeterminate, done). */
export interface JiraStatus { name: string; category: string }
export interface JiraLinkType { name: string; inward: string; outward: string }
/** created as UTC ISO, so 5.2 sorts comments oldest first as text; body as Markdown. */
export interface JiraComment { id: string; author: string | null; created: string; body: string }

function commentOf(value: unknown): JiraComment {
  const c = recordAt(value, 'jira comments');
  const created = utcIso(c.created);
  if (created === undefined) throw new WireError('jira comment created');
  const author = typeof c.author === 'object' && c.author !== null && !Array.isArray(c.author) ? (c.author as Json).displayName : undefined;
  // the codec checks every node before reading it (adf.ts), so the unchecked wire value is safe to hand it
  return { id: textAt(c, 'id', 'jira comment'), author: typeof author === 'string' ? author : null, created, body: adfToMarkdown(c.body as AdfNode | null | undefined) };
}

/** Every comment of an issue, paged by startAt; an empty page ends it even if total says more. */
export async function readComments(call: JiraCall, id: string): Promise<JiraComment[]> {
  const path = issuePath(id);
  const comments: JiraComment[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let pages = 0; comments.length < total; pages += 1) {
    if (pages >= MAX_PAGES) throw new WireError('jira comments page count');
    const page = recordAt(await call(`${path}/comment?startAt=${comments.length}&maxResults=${PAGE_SIZE}`), 'jira comments');
    if (typeof page.total !== 'number' || !Number.isInteger(page.total) || page.total < 0) throw new WireError('jira comments total');
    total = page.total;
    const read = arrayAt(page.comments, 'jira comments').map(commentOf);
    if (read.length === 0) break;
    comments.push(...read);
  }
  return comments;
}

/** The union of the project's workflow statuses over its issue types, first seen first. */
export async function readStatuses(call: JiraCall, key: string): Promise<JiraStatus[]> {
  if (!PROJECT_KEY.test(key)) throw new Error('jira project key is not a Jira key');
  const types = arrayAt(await call(`/project/${encodeURIComponent(key)}/statuses`), 'jira statuses');
  const all = types.flatMap((t) => arrayAt(recordAt(t, 'jira statuses').statuses, 'jira statuses').map((s) => {
    const status = recordAt(s, 'jira statuses');
    return { name: textAt(status, 'name', 'jira statuses'), category: textAt(recordAt(status.statusCategory, 'jira statuses'), 'key', 'jira statuses') };
  }));
  return all.filter((s, i) => all.findIndex((o) => o.name === s.name) === i);
}

export async function readFields(call: JiraCall): Promise<JiraFieldDef[]> {
  return arrayAt(await call('/field'), 'jira fields').map((f) => {
    const field = recordAt(f, 'jira fields');
    return { id: textAt(field, 'id', 'jira fields'), name: textAt(field, 'name', 'jira fields'), schema: schemaOf(field.schema) ?? null };
  });
}

export async function readLinkTypes(call: JiraCall): Promise<JiraLinkType[]> {
  const json = recordAt(await call('/issueLinkType'), 'jira link types');
  return arrayAt(json.issueLinkTypes, 'jira link types').map((t) => {
    const type = recordAt(t, 'jira link types');
    return { name: textAt(type, 'name', 'jira link type'), inward: textAt(type, 'inward', 'jira link type'), outward: textAt(type, 'outward', 'jira link type') };
  });
}

export interface JiraMyself { accountId: string; displayName?: string }
/** A transition the issue can take now (#820): its id and the status it leads to. */
export interface JiraTransition { id: string; to: string }

export async function readMyself(call: JiraCall): Promise<JiraMyself> {
  const me = recordAt(await call('/myself'), 'jira myself');
  const name = me.displayName;
  return { accountId: textAt(me, 'accountId', 'jira myself'), ...(typeof name === 'string' ? { displayName: name } : {}) };
}

export async function readTransitions(call: JiraCall, id: string): Promise<JiraTransition[]> {
  const json = recordAt(await call(`${issuePath(id)}/transitions`), 'jira transitions');
  return arrayAt(json.transitions, 'jira transitions').map((t) => {
    const transition = recordAt(t, 'jira transitions');
    return { id: textAt(transition, 'id', 'jira transition'), to: textAt(recordAt(transition.to, 'jira transition to'), 'name', 'jira transition to') };
  });
}

export async function postTransition(call: JiraCall, id: string, transition: string): Promise<void> {
  await call(`${issuePath(id)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: transition } }) });
}
