import type { Citation } from '../tasks.js';
import { matchesRules } from '../task-filter.js';
import { matchTaskProps } from '../task-props.js';
import type {
  Source, SourceItem, SourceConfig, SourceQuota, CloseAction, CloseReason, FilterOptions, Gql, Item, ItemAction, SourceTaskProps, ProjectSummary, TaskComment, ProjectView, FieldValue, FieldWrite, ItemField, BlockerChange, BlockerWrite, BlockerRef,
} from '../types.js';
import { cliGql } from './github-gql.js';
import { facetsOf, filterOptionsFrom, matchesFilter, ME, splitBlocked, usesMe } from './github-filter.js';
import type { Logger } from '../log.js';
import {
  ARCHIVE_ITEM, CLOSE_ISSUE, COMMENTS, DELETE_ISSUE, DELETE_ITEM, ISSUE_ID, ITEMS, PROJECTS, PROJECT_FIELDS, SELECT_FIELDS, issueRepo,
  SET_OPTION, VIEWER, type CommentsData, type FieldsData, type GhIssueRelations, type GhItemNode, type GhOption, type IssueIdData,
  type ProjectsData, type SelectFieldsData, type ViewerData,
} from './github-queries.js';
import { createProjectIssue, repositoryNodeId } from './github-create.js';
import { answerColumn, readItemFields, writeItemField, type FieldsContext } from './github-fields.js';
import { findBlockers, relateItem } from './github-blockers.js';
import { pageItems, PROJECT_ITEM_LIMIT, quotaFrom, type ItemPages } from './github-pages.js';
import { applyRelations, createItemsSync, fetchRelations, joinRelations, readProbe } from './github-items-sync.js';
import { readListing, type ItemStore, type ListingKey } from '../read-model/items.js';
import { readProject, type ProjectRead } from './github-project.js';
import { groupUnderEpics, statusOf, treeLinks, type TreeLinks } from './github-tree.js';

export { groupUnderEpics, treeLinks, type TreeLinks } from './github-tree.js';

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

// An epic is any issue GitHub itself counts sub-issues for, whatever their state: the field costs nothing extra on the listing, so this is known
// before a single relations alias is spent. A fixture (or a field GitHub did not return) with no summary reads as not an epic.
export const isEpicItem = (content: GhItemNode['content']): boolean => (content?.subIssuesSummary?.total ?? 0) > 0;

// Only what is there (#28): a leaf, and an issue with no parent on the Project, carry none of the three keys
const treeFields = ({ parent, children, closedChildren }: TreeLinks): Pick<Item, 'parent' | 'children' | 'closedChildren'> => ({
  ...(parent === undefined ? {} : { parent }),
  ...(children.length > 0 ? { children } : {}),
  ...(closedChildren.length > 0 ? { closedChildren } : {}),
});

// #28: the last listing with one re-read node in its place (appended when the listing lacked it), so its links equal the next poll's
const inPlace = (nodes: GhItemNode[], node: GhItemNode): GhItemNode[] =>
  nodes.some((n) => n.id === node.id) ? nodes.map((n) => (n.id === node.id ? node : n)) : [...nodes, node];

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
// rule, so a default changed in Settings still reaches it through sourceWorkspaces; auto resolved whole, since it is a birth value. Its tree
// links (#28) come from the whole listing, which the caller read them over.
function issueItem(node: GhItemNode, names: Set<string>, taskProps: SourceTaskProps, links: TreeLinks | undefined): SourceItem | undefined {
  const column = statusOf(node);
  const c = node.content;
  if (column === undefined || !names.has(column) || c?.__typename !== 'Issue' || typeof c.number !== 'number' || !c.url) return undefined;
  const item = {
    itemId: node.id, id: String(c.number), title: c.title ?? `#${c.number}`, body: c.body ?? '', url: c.url, facets: facetsOf(node),
    ...(typeof c.createdAt === 'string' ? { createdAt: c.createdAt } : {}), // #742: lead time counts from the issue's own creation
    ...(links === undefined ? {} : treeFields(links)),
  };
  const { workspace, auto } = matchTaskProps(taskProps.rules, itemReader(node));
  const hinted = workspace === undefined ? item : { ...item, workspaceHint: workspace };
  return { item: { ...hinted, autoOnEntry: auto ?? taskProps.defaults.auto }, column };
}

// #31: under show an issue with sub-issues is an epic: it never runs and its stage follows its children, by the source's own rule
const asEpic = (task: SourceItem, { epicFollows, switchAt }: GithubSourceConfig): SourceItem =>
  ({ ...task, item: { ...task.item, epic: { follows: epicFollows, switchAt } } });

/** What the settings form offers a source's filter rules (#245): the values on its items, read with a poll's own pages, and its single-select
 * fields. The owner may be `@me`, as in the listings above. */
export async function listFilterOptions(owner: string, number: number, gql: Gql = cliGql()): Promise<FilterOptions> {
  const login = await ownerLogin(owner, gql);
  const { nodes } = await pageItems(gql, ITEMS, { login, number }, sourceNotFound(owner, number), PROJECT_ITEM_LIMIT);
  const project = ((await gql(SELECT_FIELDS, { login, number })) as SelectFieldsData).repositoryOwner?.projectV2;
  return { ...filterOptionsFrom(nodes, project?.fields?.nodes ?? []), linkedRepositories: (project?.repositories?.nodes ?? []).map((r) => r.nameWithOwner) };
}

export function createGithubSource(source: GithubSourceConfig, cited: Citation[], gql: Gql = cliGql(), log?: Logger, items?: ItemStore): Source {
  const { owner, number, epics } = source;
  const { blocked, other } = splitBlocked(source.filter); // #441: the blocked rules wait for the relations query
  let resolved: { projectId: string; statusFieldId: string; options: GhOption[]; optionIds: Record<string, string> } | undefined; // options: every Status option, in order (#756)
  let lastQuota: SourceQuota | undefined; // what the last poll read; undefined before the first one
  let login: string | undefined; // `owner` with `@me` resolved, once; a failed lookup is retried on the next poll
  let me: string | undefined; // the polling account's login, asked only when the filter says @me; a transport change builds a new adapter
  let lastNodes: GhItemNode[] = []; // #28: the last listing's nodes, what a field write's re-read reads its tree links over
  let contents = new Map<string, GhItemNode['content']>(); // every item the last listing saw, draft or filtered out: what apply acts on (#286)
  // #190: with a read model the poll probes the project first and lists what the model holds; it reads in full only when the sync says so
  const sync = items && createItemsSync({ store: items, probe, listNodes: async () => (await listNodes()).nodes, kept: (nodes) => keep(nodes), fetchRelations: (tasks) => fetchRelations(gql, tasks), log });
  // #190: every write makes the next poll read in full (a relation write does not move the probe). Cleared again once it lands: a poll that
  // started between the first clear and the mutation read the item from before it
  const written = <A extends unknown[], R>(write: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    sync?.clear();
    try {
      return await write(...args);
    } finally {
      sync?.clear();
    }
  };

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

  // #282: the whole Project, unfiltered (the filter runs in keep()), up to PROJECT_ITEM_LIMIT; past it, the items left never reach the flow
  async function listNodes(): Promise<ItemPages> {
    login ??= await ownerLogin(owner, gql);
    const pages = await pageItems(gql, ITEMS, { login, number }, sourceNotFound(owner, number), PROJECT_ITEM_LIMIT);
    if (pages.truncated) log?.warn(`source ${owner}/${number}: more than ${PROJECT_ITEM_LIMIT} items on the Project; the ones past them never reach the flow`);
    lastQuota = quotaFrom(pages.rateLimit);
    return pages;
  }

  // #190: 1 point; its rateLimit is the quota reading of a poll that reads nothing more. listItems resolved the login first
  async function probe(): Promise<string> {
    login ??= await ownerLogin(owner, gql);
    const { updatedAt, rateLimit } = await readProbe(gql, { login, number }, sourceNotFound(owner, number));
    lastQuota = quotaFrom(rateLimit);
    return updatedAt;
  }

  // The poll's steps on its items (#211, #245, #441), and on the one item a field write re-read (#686): issue items in a cited column, grouped
  // under their epics, then the filter and the hidden epics. The tree links (#28) are read over every node first, before a column or a filter
  // drops one: a child filtered out or in another column is still a child. #191: the boot read skips the filter, which may need `me`
  function keep(items: GhItemNode[], links: Map<string, TreeLinks> = treeLinks(items), filtered = true): SourceItem[] {
    const names = new Set(cited.map((c) => c.column));
    const tasks = new Map(items.flatMap<[GhItemNode, SourceItem]>((item) => {
      const task = issueItem(item, names, source.taskProps, links.get(item.id));
      return task ? [[item, task]] : [];
    }));
    // Grouped before anything is dropped: an epic the Hive does not show still lends its place to its sub-issues (#211)
    return groupUnderEpics([...tasks.keys()]).flatMap<SourceItem>((item) => {
      if (filtered && !matchesFilter(other, me, item)) return []; // filtered out: to the Hive it is simply not on the source
      const epic = isEpicItem(item.content);
      if (epics === 'hide' && epic) return []; // #30: not a task for the Hive: its sub-issues take its place; ignore and show list it
      const task = tasks.get(item);
      if (task === undefined) return [];
      return [epics === 'show' && epic ? asEpic(task, source) : task];
    });
  }

  const blockedOut = (tasks: SourceItem[]): SourceItem[] => tasks.filter((task) => matchesRules(blocked, task.item)); // #441: judged on the relations

  // Then the relations and the blocked rules (#441). The relations query answers blocking; blockedBy and the sub-issues ride on the nodes
  // (#282). A failed query rejects the poll, never "no blockers". What it read is kept for a write's answer (#190)
  async function related(tasks: SourceItem[], nodes: GhItemNode[]): Promise<{ listed: SourceItem[]; relations: Map<string, GhIssueRelations | null> }> {
    const relations = await fetchRelations(gql, tasks);
    return { listed: blockedOut(applyRelations(tasks, joinRelations(nodes, relations))), relations };
  }

  async function listed(nodes: GhItemNode[]): Promise<SourceItem[]> {
    return (await related(keep(nodes), nodes)).listed;
  }

  function remember(nodes: GhItemNode[]): void {
    contents = new Map(nodes.map((node) => [node.id, node.content]));
    lastNodes = nodes;
  }

  // #191: the listing a login's poll stores, and what the boot read reads back
  const keyOf = (rows: string, who: string): ListingKey => {
    const project = `${who}/${number}`;
    return { source: rows, project, scope: project };
  };

  // #190: with a store and a login, the model's listing after a probe; without either (headless, setup mode, no login), the wire's, as before
  async function listItems(): Promise<SourceItem[]> {
    const rows = await items?.source();
    if (sync === undefined || rows === undefined) {
      const { nodes } = await listNodes();
      remember(nodes);
      return listed(nodes);
    }
    login ??= await ownerLogin(owner, gql);
    const read = await sync.list(keyOf(rows, login));
    remember(read.nodes);
    return blockedOut(await sync.relate(rows, keep(read.nodes), read));
  }

  // #191: the model's listing with no network call: the poll's item steps without the filter (`me` may need the network), and the stored
  // relations alone. No store, no account, or an `@me` owner not resolved yet: nothing, and the tasks wait for the first poll
  async function stored(): Promise<SourceItem[]> {
    const rows = await items?.source();
    const offline = login ?? (owner === ME ? undefined : owner);
    if (items === undefined || rows === undefined || offline === undefined) return [];
    const read = readListing(items.db, keyOf(rows, offline));
    return applyRelations(keep(read.nodes, treeLinks(read.nodes), false), joinRelations(read.nodes, read.relations));
  }

  async function setColumn(itemId: string, column: string): Promise<void> {
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    const optionId = resolved.optionIds[column];
    if (optionId === undefined) throw new Error(`"${column}" is not a column the config cites`);
    await gql(SET_OPTION, { projectId: resolved.projectId, itemId, fieldId: resolved.statusFieldId, singleSelectOptionId: optionId });
    // #191: the write's answer in the model under fieldsContext()'s key, so a poll read before it cannot move the task back
    if (sync) await answerColumn(gql, itemId, resolved.projectId, async (node) => sync.answer(node, new Map(), `${(await projectRead()).login}/${number}`), log);
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
    if (contents.size === 0) await listItems(); // #353: at boot another source's poll can run this before ours listed; a truly empty project re-lists
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

  // #686, #56: what a write on one item needs. related(keep([node])) is the poll's steps on one item. groupUnderEpics only reorders a list,
  // the tree links (#28) are read over the last listing with the re-read node in its place, and the rest of the steps read the item alone, so
  // the one-item entry equals the poll's for that item. #190: answer stores the re-read node, and the relations entry read, in the model
  async function fieldsContext(): Promise<FieldsContext> {
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    const read = await projectRead();
    let fetched = new Map<string, GhIssueRelations | null>();
    const entry = async (node: GhItemNode): Promise<SourceItem | undefined> => {
      const one = await related(keep([node], treeLinks(inPlace(lastNodes, node))), [node]);
      fetched = one.relations;
      return one.listed[0];
    };
    const answer = sync && ((node: GhItemNode): Promise<void> => sync.answer(node, fetched, `${read.login}/${number}`));
    return { gql, projectId: resolved.projectId, read, entry, ...(answer === undefined ? {} : { answer }) };
  }

  // #686: a field write, then the item re-read and run through the poll's own steps, so `entry` is what the next poll would list
  async function setField(itemId: string, field: string, value: FieldValue): Promise<FieldWrite> {
    return writeItemField(await fieldsContext(), itemId, field, value);
  }

  // #56: a blocker relation added or removed, then the item's relations and entry re-read as a field write's
  async function relate(itemId: string, change: BlockerChange): Promise<BlockerWrite> {
    return relateItem(await fieldsContext(), itemId, change);
  }

  // #57: the add row's search, under the same context a relation write uses
  async function searchBlockers(itemId: string, text: string): Promise<BlockerRef[]> {
    return findBlockers(await fieldsContext(), itemId, text);
  }

  async function fieldsOf(itemId: string): Promise<ItemField[]> { // #686
    if (!resolved) throw new Error('source not resolved: call resolveFields() first');
    return readItemFields(gql, itemId, resolved.projectId);
  }
  return {
    resolveFields, listItems, stored, setColumn: written(setColumn), create: written(create), apply: written(apply), settingsOptions, comments, project, fieldsOf,
    setField: written(setField), relate: written(relate), findBlockers: searchBlockers, quota: async () => lastQuota,
  };
}
