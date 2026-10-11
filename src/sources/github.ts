import type { Citation } from '../tasks.js';
import { matchesRules } from '../task-filter.js';
import { matchTaskProps } from '../task-props.js';
import type {
  Source, SourceItem, SourceConfig, SourceQuota, CloseAction, CloseReason, FilterOptions, Gql, ItemAction, SourceTaskProps, ProjectSummary, TaskComment, ProjectView, FieldValue, FieldWrite, ItemField,
} from '../types.js';
import { cliGql } from './github-gql.js';
import { facetsOf, filterOptionsFrom, matchesFilter, ME, splitBlocked, usesMe } from './github-filter.js';
import {
  ARCHIVE_ITEM, CLOSE_ISSUE, COMMENTS, DELETE_ISSUE, DELETE_ITEM, ISSUE_ID, ITEMS, PAGE_SIZE, PROJECTS, PROJECT_FIELDS, SELECT_FIELDS, issueRepo, relationsQuery,
  SET_OPTION, VIEWER, type CommentsData, type FieldsData, type GhIssueRelations, type GhItemNode, type GhOption, type GhProjectField, type GhRateLimit, type IssueIdData, type ItemsData,
  type ProjectsData, type RelationsData, type SelectFieldsData, type ViewerData,
} from './github-queries.js';
import { createProjectIssue, repositoryNodeId } from './github-create.js';
import { readItemFields, writeItemField } from './github-fields.js';
import { readProject, type ProjectRead } from './github-project.js';

const ITEM_LIMIT = 200; // the ceiling the gh --limit used to enforce; two pages of 100: the poll's and the filter options'
const GHOST = 'ghost'; // what GitHub itself shows for a deleted account

export type GithubSourceConfig = Extract<SourceConfig, { type: 'github' }>;

interface StatusField { projectId: string; id: string; options: GhOption[] }

// Through the adapter's own gql, so `@me` is whoever the transport polls as: gh's account on cli, the Hive's login on api.
async function viewerLogin(gql: Gql): Promise<string> {
  const login = ((await gql(VIEWER)) as ViewerData).viewer?.login;
  if (!login) throw new Error('could not resolve "@me": the GitHub login has no user');
  return login;
}

// `@me` is the gh CLI's shorthand for the logged-in user; GraphQL has no such login, so it becomes the token's own.
async function ownerLogin(owner: string, gql: Gql): Promise<string> {
  return owner === ME ? viewerLogin(gql) : owner;
}

const sourceNotFound = (owner: string, number: number): string => `source not found: no GitHub Project ${number} for "${owner}"`;

// `repositoryOwner` resolves a user or an org, so a null owner and a null project are the same failure: the source is not there.
// Exported for the decomposition's confirm (#865): the project id, the Status field and its options, read with the Hive's own login there
export async function fetchStatusField(owner: string, number: number, gql: Gql): Promise<StatusField> {
  const data = (await gql(PROJECT_FIELDS, { login: await ownerLogin(owner, gql), number })) as FieldsData;
  const project = data.repositoryOwner?.projectV2;
  if (!project) throw new Error(sourceNotFound(owner, number));
  if (!project.field?.options) throw new Error('source has no single-select "Status" field');
  return { projectId: project.id, id: project.field.id, options: project.field.options };
}

export async function listProjects(owner: string, gql: Gql = cliGql()): Promise<ProjectSummary[]> {
  const data = (await gql(PROJECTS, { login: await ownerLogin(owner, gql) })) as ProjectsData;
  const nodes = data.repositoryOwner?.projectsV2?.nodes ?? []; // an owner the API does not resolve has no project to offer
  return nodes.filter((p) => !p.closed).map(({ number, title, url }) => ({ number, title, url }));
}

export async function listStatusOptions(owner: string, number: number, gql: Gql = cliGql()): Promise<string[]> {
  return (await fetchStatusField(owner, number, gql)).options.map((o) => o.name);
}

const STATE_REASONS: Record<CloseReason, string> = { wontDo: 'NOT_PLANNED', duplicate: 'DUPLICATE' }; // #314

// A close's variables (#314): the reason as GitHub's state reason; a duplicate's original is named by number in the issue's own repository
// and resolved to its node id first. A bare close sends the issue alone, as before.
async function closeVariables(gql: Gql, issueId: string, url: string | undefined, { reason, duplicateOf }: CloseAction): Promise<Record<string, string>> {
  const stated: Record<string, string> = reason === undefined ? { issueId } : { issueId, stateReason: STATE_REASONS[reason] };
  if (duplicateOf === undefined) return stated;
  const repo = issueRepo(url ?? '');
  if (!repo) throw new Error(`"duplicateOf" needs the issue's repository: ${url ?? 'no url'} is no issue url`);
  const original = ((await gql(ISSUE_ID, { ...repo, number: duplicateOf })) as IssueIdData).repository?.issue?.id;
  if (!original) throw new Error(`issue #${duplicateOf} not found in ${repo.owner}/${repo.name}`);
  return { ...stated, duplicateIssueId: original };
}

// Issue dependencies and sub-issues that are still OPEN, in response order, without duplicates.
function openBlockers(issue: GhIssueRelations | null | undefined): string[] {
  if (!issue) return [];
  const nodes = [...(issue.blockedBy?.nodes ?? []), ...(issue.subIssues?.nodes ?? [])];
  return [...new Set(nodes.filter((n) => n.state === 'OPEN').map((n) => String(n.number)))];
}

// An epic is any issue GitHub itself counts sub-issues for, whatever their state: the field costs nothing extra on the
// listing, so this is known before a single relations alias is spent. A fixture (or a field GitHub did not return) with no
// summary reads as not an epic.
export const isEpicItem = (content: GhItemNode['content']): boolean => (content?.subIssuesSummary?.total ?? 0) > 0;

const statusOf = (item: GhItemNode): string | undefined => item.fieldValueByName?.name;
const subIssueIds = (item: GhItemNode): string[] => (item.content?.subIssues?.nodes ?? []).map((n) => n.id);

/** The items in source order with each epic's sub-issues moved right after it, in the epic's own sub-issue order, depth first; only
 * children in the epic's Status column follow it. Items with no epic above them in their column keep their relative source order (#211). */
export function groupUnderEpics(items: GhItemNode[]): GhItemNode[] {
  const byId = new Map(items.flatMap<[string, GhItemNode]>((item) => (item.content?.id ? [[item.content.id, item]] : [])));
  const parentOf = new Map<GhItemNode, GhItemNode>(); // GitHub gives an issue one parent at most; "first in source order" only makes this total
  for (const epic of items) {
    for (const id of subIssueIds(epic)) {
      const child = byId.get(id);
      if (child && child !== epic && !parentOf.has(child) && statusOf(child) === statusOf(epic)) parentOf.set(child, epic);
    }
  }
  const placed = new Set<GhItemNode>(); // a cycle or a duplicate can neither loop nor place a task twice
  const walk = (item: GhItemNode): GhItemNode[] => {
    if (placed.has(item)) return [];
    placed.add(item);
    const children = subIssueIds(item).flatMap((id) => {
      const child = byId.get(id);
      return child && parentOf.get(child) === item ? [child] : [];
    });
    return [item, ...children.flatMap((child) => walk(child))];
  };
  const roots = items.filter((item) => !parentOf.has(item));
  return [...roots, ...items].flatMap((item) => walk(item)); // a cycle leaves its items rootless: they come last, in source order
}

// What a rule reads on one item (#293, #688): `title`, each label's name for `labels`, else the named Project field's set value, single-select or
// text, riding the same fieldValues the task filter already fetches (#245); a field the item has no value for reads nothing.
export function itemReader(item: GhItemNode): (field: string) => string[] {
  return (field) => {
    if (field === 'title') return [item.content?.title ?? ''];
    if (field === 'labels') return (item.content?.labels?.nodes ?? []).map((n) => n.name);
    return (item.fieldValues?.nodes ?? []).flatMap((v) => {
      const value = v.field?.name === field ? (v.name ?? v.text) : undefined;
      return value === undefined ? [] : [value];
    });
  };
}

// The task for an issue item in one of the cited columns; a draft, a pull request or another column is not on the Hive's source. Its facets
// (#374) ride along for a stage's view filter, read off the item the poll already fetched. Its task properties (#688): the hint only from a
// rule, so a default changed in Settings still reaches it through sourceWorkspaces; auto resolved whole, since it is a birth value.
function issueItem(node: GhItemNode, names: Set<string>, taskProps: SourceTaskProps): SourceItem | undefined {
  const column = statusOf(node);
  const c = node.content;
  if (column === undefined || !names.has(column) || c?.__typename !== 'Issue' || typeof c.number !== 'number' || !c.url) return undefined;
  const item = { itemId: node.id, id: String(c.number), title: c.title ?? `#${c.number}`, body: c.body ?? '', url: c.url, facets: facetsOf(node), ...(typeof c.createdAt === 'string' ? { createdAt: c.createdAt } : {}) }; // #742: lead time counts from the issue's own creation
  const { workspace, auto } = matchTaskProps(taskProps.rules, itemReader(node));
  const hinted = workspace === undefined ? item : { ...item, workspaceHint: workspace };
  return { item: { ...hinted, autoOnEntry: auto ?? taskProps.defaults.auto }, column };
}

// Every listed task gets its relations (#441): a stage's view filter and a source's blocked rule read blocked on any task, and a blocked task
// refuses a session wherever it sits. relationsQuery aliases each task by its index here, a task with no
// issue url being skipped, so `i<index>` finds its answer.
async function withBlockers(tasks: SourceItem[], gql: Gql): Promise<SourceItem[]> {
  const query = relationsQuery(tasks.map((c) => c.item));
  if (!query) return tasks;
  const data = (await gql(query)) as RelationsData;
  return tasks.map((task, i) => {
    const blockedBy = openBlockers(data[`i${i}`]?.issue);
    return blockedBy.length > 0 ? { ...task, item: { ...task.item, blockedBy } } : task;
  });
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// The reading taken after a poll, from a field the poll already paid for, and after every repository read (#757). Any other shape → undefined.
export function quotaFrom(rate: GhRateLimit | null | undefined): SourceQuota | undefined {
  const { limit, remaining, resetAt } = rate ?? {};
  if (!isCount(limit) || !isCount(remaining) || typeof resetAt !== 'string') return undefined;
  return { limit, remaining, resetsAt: resetAt, at: new Date().toISOString() };
}

/** What pageItems read (#756): the nodes, the first page's rateLimit and project fields, and whether items were left past the limit. */
export interface ItemPages { nodes: GhItemNode[]; rateLimit?: GhRateLimit | null; fields: GhProjectField[]; truncated: boolean }

// Raw GraphQL caps `items` at 100 per page: up to `limit` items, ITEM_LIMIT for a poll and the filter options (#245), PROJECT_ITEM_LIMIT for
// the native view (#756). The first page's rateLimit is the reading a poll takes its quota from; its fields, what the native view asks.
export async function pageItems(gql: Gql, query: string, variables: Record<string, string | number>, notFound: string, limit: number): Promise<ItemPages> {
  const nodes: GhItemNode[] = [];
  let first: ItemsData | undefined;
  let after: string | undefined;
  for (let pageIndex = 0; pageIndex < limit / PAGE_SIZE; pageIndex++) {
    const data = (await gql(query, { ...variables, ...(after === undefined ? {} : { after }) })) as ItemsData;
    first ??= data;
    const items = data.repositoryOwner?.projectV2?.items;
    if (!items) throw new Error(notFound);
    nodes.push(...items.nodes);
    after = items.pageInfo.hasNextPage && items.pageInfo.endCursor ? items.pageInfo.endCursor : undefined;
    if (after === undefined) break;
  }
  return { nodes, rateLimit: first?.rateLimit, fields: first?.repositoryOwner?.projectV2?.fields?.nodes ?? [], truncated: after !== undefined };
}

/** What the settings form offers a source's filter rules (#245): the values on its items, read with a poll's own pages, and its single-select
 * fields. The owner may be `@me`, as in the listings above. */
export async function listFilterOptions(owner: string, number: number, gql: Gql = cliGql()): Promise<FilterOptions> {
  const login = await ownerLogin(owner, gql);
  const { nodes } = await pageItems(gql, ITEMS, { login, number }, sourceNotFound(owner, number), ITEM_LIMIT);
  const project = ((await gql(SELECT_FIELDS, { login, number })) as SelectFieldsData).repositoryOwner?.projectV2;
  return { ...filterOptionsFrom(nodes, project?.fields?.nodes ?? []), linkedRepositories: (project?.repositories?.nodes ?? []).map((r) => r.nameWithOwner) };
}

export function createGithubSource(source: GithubSourceConfig, cited: Citation[], gql: Gql = cliGql()): Source {
  const { owner, number, epics } = source;
  const { blocked, other } = splitBlocked(source.filter); // #441: the blocked rules wait for the relations query
  let resolved: { projectId: string; statusFieldId: string; options: GhOption[]; optionIds: Record<string, string> } | undefined; // options: every Status option, in order (#756)
  let lastQuota: SourceQuota | undefined; // what the last poll read; undefined before the first one
  let login: string | undefined; // `owner` with `@me` resolved, once; a failed lookup is retried on the next poll
  let me: string | undefined; // the polling account's login, asked only when the filter says @me; a transport change builds a new adapter
  let contents = new Map<string, GhItemNode['content']>(); // every item the last listing saw, draft or filtered out: what apply acts on (#286)

  async function resolveFields(): Promise<void> {
    const status = await fetchStatusField(owner, number, gql);
    const available = status.options.map((o) => o.name);
    const optionIds: Record<string, string> = {};
    for (const { column, by } of cited) {
      const option = status.options.find((o) => o.name === column);
      if (!option) throw new Error(`"${column}" (${by}) not found in source Status options: ${available.join(', ')}`);
      optionIds[column] = option.id;
    }
    if (usesMe(source.filter)) me ??= await viewerLogin(gql);
    resolved = { projectId: status.projectId, statusFieldId: status.id, options: status.options, optionIds };
  }

  async function listNodes(): Promise<GhItemNode[]> {
    login ??= await ownerLogin(owner, gql);
    const { nodes, rateLimit } = await pageItems(gql, ITEMS, { login, number }, sourceNotFound(owner, number), ITEM_LIMIT);
    lastQuota = quotaFrom(rateLimit);
    return nodes;
  }

  // The poll's steps on its items (#211, #245, #441), and on the one item a field write re-read (#686): issue items in a cited column, grouped
  // under their epics, then the filter, the hidden epics, the relations and the blocked rules
  async function listed(items: GhItemNode[]): Promise<SourceItem[]> {
    const names = new Set(cited.map((c) => c.column));
    const tasks = new Map(items.flatMap<[GhItemNode, SourceItem]>((item) => {
      const task = issueItem(item, names, source.taskProps);
      return task ? [[item, task]] : [];
    }));
    // Grouped before anything is dropped: an epic the Hive does not show still lends its place to its sub-issues (#211)
    const kept = groupUnderEpics([...tasks.keys()]).flatMap<SourceItem>((item) => {
      if (!matchesFilter(other, me, item)) return []; // filtered out: to the Hive it is simply not on the source
      if (epics === 'hide' && isEpicItem(item.content)) return []; // #30: not a task for the Hive: its sub-issues take its place; ignore and show list it
      return tasks.get(item) ?? [];
    });
    // Items carry no relations; a failed query rejects the poll, never "no blockers". The blocked rules (#441) are judged on what it read.
    return (await withBlockers(kept, gql)).filter((task) => matchesRules(blocked, task.item));
  }

  async function listItems(): Promise<SourceItem[]> {
    const items = await listNodes();
    contents = new Map(items.map((item) => [item.id, item.content]));
    return listed(items);
  }

  async function setColumn(itemId: string, column: string): Promise<void> {
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    const optionId = resolved.optionIds[column];
    if (optionId === undefined) throw new Error(`"${column}" is not a column the config cites`);
    await gql(SET_OPTION, { projectId: resolved.projectId, itemId, fieldId: resolved.statusFieldId, singleSelectOptionId: optionId });
  }

  let repositoryId: string | undefined; // #846: source.repository's node id, asked once

  // #846: a new issue in source.repository, on the Project, in the Status option `column` (the stage's first from column, cited)
  async function create({ title, body, column }: { title: string; body?: string; column: string }): Promise<string> {
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    if (source.repository === undefined) throw new Error('source has no repository for new issues');
    const option = resolved.options.find((o) => o.name === column);
    if (!option) throw new Error(`"${column}" is not a Status option: ${resolved.options.map((o) => o.name).join(', ')}`);
    repositoryId ??= await repositoryNodeId(gql, source.repository);
    return createProjectIssue(gql, { projectId: resolved.projectId, statusFieldId: resolved.statusFieldId, optionId: option.id, repositoryId }, { title, body });
  }

  // #286: archive and remove act on the project item; close and delete on its issue, known from the last listing. A draft has no issue:
  // it cannot be closed, and deleting it deletes the item. A close from hive_stop carries a reason and maybe the original of a duplicate (#314).
  async function apply(itemId: string, action: ItemAction): Promise<void> {
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    if (!contents.has(itemId)) throw new Error(`item ${itemId} is not on the source`);
    const content = contents.get(itemId);
    const issueId = content?.__typename === 'Issue' ? content.id : undefined;
    const item = { projectId: resolved.projectId, itemId };
    switch (action.type) {
      case 'archive': await gql(ARCHIVE_ITEM, item); return;
      case 'remove': await gql(DELETE_ITEM, item); return;
      case 'close':
        if (issueId === undefined) throw new Error('"close" needs an issue, not a draft or a pull request');
        await gql(CLOSE_ISSUE, await closeVariables(gql, issueId, content?.url, action));
        return;
      case 'delete': await (issueId === undefined ? gql(DELETE_ITEM, item) : gql(DELETE_ISSUE, { issueId })); return;
    }
  }

  async function settingsOptions(): Promise<string[]> {
    return listStatusOptions(owner, number, gql);
  }

  // One call each time the panel opens on a task, never per poll. An item that is gone or not an issue has no comments, which is not an error.
  async function comments(itemId: string): Promise<TaskComment[]> {
    const data = (await gql(COMMENTS, { id: itemId })) as CommentsData;
    const nodes = data.node?.content?.comments?.nodes ?? [];
    return nodes.map((c) => ({ author: c.author?.login ?? GHOST, createdAt: c.createdAt, body: c.body, url: c.url }));
  }

  // What the native view and a field write's row read an issue with (#756, #686): the resolved login, the filter without its blocked rules,
  // `@me`, the epics mode and the task properties
  async function projectRead(): Promise<ProjectRead> {
    login ??= await ownerLogin(owner, gql);
    return { login, number, notFound: sourceNotFound(owner, number), filter: other, me, epics, taskProps: source.taskProps };
  }

  // #756: the native view, every issue unfiltered, read on demand by its route and never by the poll. The stage each option enters is the
  // server's to name, from the Comb's stages
  async function project(): Promise<ProjectView> {
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    const statuses = resolved.options.map((o) => ({ name: o.name }));
    return { statuses, ...(await readProject(gql, await projectRead())) };
  }

  // #686: a field write, then the item re-read and run through the poll's own steps, so `entry` is what the next poll would list
  async function setField(itemId: string, field: string, value: FieldValue): Promise<FieldWrite> {
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    // listed([node]) is the poll's steps on one item. groupUnderEpics only reorders a list and changes no item's data, and the rest of the steps
    // read the item alone, so the one-item entry equals the poll's for that item
    return writeItemField({ gql, projectId: resolved.projectId, read: await projectRead(), entry: async (node) => (await listed([node]))[0] }, itemId, field, value);
  }

  async function fieldsOf(itemId: string): Promise<ItemField[]> { // #686
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    return readItemFields(gql, itemId, resolved.projectId);
  }
  return { resolveFields, listItems, setColumn, create, apply, settingsOptions, comments, project, fieldsOf, setField, quota: async () => lastQuota };
}
