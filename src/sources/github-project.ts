import { STATUS } from '../field-values.js';
import type { ReadModel } from '../read-model/db.js';
import { readListing, type ListingKey } from '../read-model/items.js';
import { rebuildFields } from '../read-model/items-rebuild.js';
import { matchTaskProps } from '../task-props.js';
import type { BlockerRef, EpicsMode, FilterRule, Gql, ProjectBuiltins, ProjectField, ProjectItem, ProjectPr, ProjectView, Signal, SourceTaskProps } from '../types.js';
import { matchesFilter } from './github-filter.js';
// A cycle with github.js, which calls readProject: only functions cross it, and they run after both modules loaded
import { isEpicItem, itemReader } from './github.js';
import { pageItems, PROJECT_ITEM_LIMIT } from './github-pages.js';
// A cycle (github-blockers → github-fields → this module): only functions cross it, and they run after every module loaded
import { refsOf } from './github-blockers.js';
import { ITEMS, type GhItemNode, type GhProjectField, type GhPullRequest } from './github-queries.js';

// GitHub's ProjectV2FieldType → how the view renders it; any other kind (reviewers, tracks, tracked by, one GitHub adds later) is `other`
const FIELD_TYPES: Record<string, ProjectField['type']> = {
  SINGLE_SELECT: 'singleSelect', TEXT: 'text', NUMBER: 'number', DATE: 'date', ITERATION: 'iteration', SUB_ISSUES_PROGRESS: 'progress',
  MILESTONE: 'milestone', REPOSITORY: 'repository', PARENT_ISSUE: 'parentIssue', ISSUE_TYPE: 'issueType',
};
// The kinds a fixed column already shows (#756): the title in the issue cell, labels, assignees, and the linked PRs in the PR column
const FIXED = new Set(['TITLE', 'LABELS', 'ASSIGNEES', 'LINKED_PULL_REQUESTS']);
const CHECKS: Record<string, Signal> = { SUCCESS: 'green', FAILURE: 'red', ERROR: 'red', PENDING: 'yellow', EXPECTED: 'yellow' };

/** What readProject needs of the adapter (#756): the resolved login, the filter without its blocked rules, `@me`, the epics mode and the
 * task properties: what is private to the adapter, handed in. */
export interface ProjectRead {
  login: string; number: number; notFound: string; filter: FilterRule[]; me: string | undefined; epics: EpicsMode; taskProps: SourceTaskProps;
}

// The fixed columns' built-in fields (#756): Status is a single-select told by its name, Labels and Assignees by their kind
const BUILTIN: Record<string, keyof ProjectBuiltins> = { LABELS: 'labels', ASSIGNEES: 'assignees' };

const kindOf = (f: GhProjectField): ProjectField['type'] =>
  f.dataType !== undefined && Object.hasOwn(FIELD_TYPES, f.dataType) ? FIELD_TYPES[f.dataType] : 'other';

// Every named field but Status and the fixed columns' kinds is a column (addendum 2); a field GitHub could not read answers {}
const isShown = (f: GhProjectField): f is GhProjectField & { name: string } => f.name !== undefined && f.name !== STATUS && !FIXED.has(f.dataType ?? '');

const builtinOf = (f: GhProjectField): keyof ProjectBuiltins | undefined =>
  f.name === STATUS ? 'status' : f.dataType !== undefined && Object.hasOwn(BUILTIN, f.dataType) ? BUILTIN[f.dataType] : undefined;

// A single-select's options or an iteration field's iterations, in the project's order: absent on a field with neither
const optionsOf = (f: GhProjectField): string[] | undefined => f.options?.map((o) => o.name) ?? f.configuration?.iterations?.map((i) => i.title);

/** The project's fields the view shows, in the project's order, with their options (#756). */
export function projectFields(raw: GhProjectField[]): ProjectField[] {
  return raw.filter(isShown).map((f) => {
    const options = optionsOf(f);
    return { name: f.name, type: kindOf(f), ...(options === undefined ? {} : { options }) };
  });
}

/** Where each built-in field sits (#756): how many shown fields come before it in the project. */
export function projectBuiltins(raw: GhProjectField[]): ProjectBuiltins {
  return Object.fromEntries(raw.flatMap((f, at) => {
    const key = builtinOf(f);
    return key === undefined ? [] : [[key, raw.slice(0, at).filter(isShown).length]];
  }));
}

type GhIssue = NonNullable<GhItemNode['content']>;
// #61: the issue's blocked-by refs, short ids in its own repository. Absent when the read asked none: a row never claims no blockers it did not read
const blockedByOf = (c: GhIssue): BlockerRef[] | undefined =>
  (c.blockedBy ? refsOf(c.blockedBy.nodes, c.repository?.nameWithOwner ?? '') : undefined);

// The kinds read off the issue rather than a field value: one read whatever the project lists. The progress only on an issue with sub-issues
const FROM_ISSUE: Partial<Record<ProjectField['type'], (c: GhIssue) => string | undefined>> = {
  progress: ({ subIssuesSummary: s }) => (s && s.total > 0 ? `${s.completed ?? 0}/${s.total}` : undefined),
  milestone: (c) => c.milestone?.title,
  repository: (c) => c.repository?.nameWithOwner,
  parentIssue: ({ parent }) => (parent ? `#${parent.number} ${parent.title}` : undefined),
  issueType: (c) => c.issueType?.name,
};

/** Each shown field's value by its name (#756): the set value of its kind (any kind's, `other` included), else what the issue says of it; a field write's read too (#686). */
export function valuesOf(node: GhItemNode, fields: ProjectField[]): Record<string, string | number> {
  const shown = new Set(fields.map((f) => f.name));
  const set = (node.fieldValues?.nodes ?? []).flatMap((v): [string, string | number][] => {
    const name = v.field?.name;
    const value = v.name ?? v.text ?? v.number ?? v.date ?? v.title;
    return name !== undefined && shown.has(name) && value !== undefined ? [[name, value]] : [];
  });
  const content = node.content;
  const fromIssue = content ? fields.flatMap((f): [string, string][] => {
    const value = FROM_ISSUE[f.type]?.(content);
    return value === undefined ? [] : [[f.name, value]];
  }) : [];
  return Object.fromEntries([...set, ...fromIssue]);
}

/** A PR that closes an issue as the views show it (#756, #757): its state, its checks' rollup as a signal and, on a draft, draft. */
export function pullRequest(pr: GhPullRequest): ProjectPr {
  const state = pr.merged ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed';
  const rollup = pr.statusCheckRollup?.state;
  const checks = rollup !== undefined && Object.hasOwn(CHECKS, rollup) ? CHECKS[rollup] : undefined;
  return { number: pr.number, url: pr.url, state, ...(checks === undefined ? {} : { checks }), ...(pr.isDraft === true ? { draft: true as const } : {}) };
}

// Why the Hive does not take the issue, in the order listItems drops: the filter's rules, then a hidden epic (#30). ponytail: the blocked rules
// are not judged (they need the relations query for every item), so an issue kept out only by one shows as passing (#756)
function outOf(node: GhItemNode, read: ProjectRead): ProjectItem['out'] {
  if (!matchesFilter(read.filter, read.me, node)) return 'filter';
  return read.epics === 'hide' && isEpicItem(node.content) ? 'epic' : undefined;
}

/** An issue's row; a draft or a pull request on the project is not the view's (#756). The hint comes from a rule only, as on a listed task. A field write's re-read builds one too (#686). */
export function projectItem(node: GhItemNode, fields: ProjectField[], read: ProjectRead): ProjectItem | undefined {
  const c = node.content;
  if (c?.__typename !== 'Issue' || typeof c.number !== 'number' || !c.url) return undefined;
  const status = node.fieldValueByName?.name;
  const { workspace } = matchTaskProps(read.taskProps.rules, itemReader(node));
  const out = outOf(node, read);
  const blockedBy = blockedByOf(c);
  return {
    itemId: node.id, id: String(c.number), title: c.title ?? `#${c.number}`, body: c.body ?? '', url: c.url,
    ...(status === undefined ? {} : { status }),
    labels: (c.labels?.nodes ?? []).map((n) => n.name),
    assignees: (c.assignees?.nodes ?? []).map((n) => n.login),
    ...(c.repository ? { repository: c.repository.nameWithOwner } : {}),
    ...(workspace === undefined ? {} : { workspaceHint: workspace }),
    fields: valuesOf(node, fields),
    pullRequests: (c.closedByPullRequestsReferences?.nodes ?? []).map(pullRequest),
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(out === undefined ? {} : { out }),
    ...(c.createdAt ? { createdAt: c.createdAt } : {}), ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}), ...(c.closedAt ? { closedAt: c.closedAt } : {}),
  };
}

// One view from any read: the fields the view shows, where the built-ins sit, and every issue's row
function viewOf(nodes: GhItemNode[], raw: GhProjectField[], read: ProjectRead, truncated: boolean): Omit<ProjectView, 'statuses'> {
  const fields = projectFields(raw);
  return { fields, builtins: projectBuiltins(raw), items: nodes.flatMap((node) => projectItem(node, fields, read) ?? []), truncated };
}

/** A source's issues, unfiltered, in the project's order, with the fields the view shows (#756), read live; the statuses are the adapter's to add. */
export async function readProject(gql: Gql, read: ProjectRead): Promise<Omit<ProjectView, 'statuses'>> {
  const pages = await pageItems(gql, ITEMS, { login: read.login, number: read.number }, read.notFound, PROJECT_ITEM_LIMIT);
  return viewOf(pages.nodes, pages.fields, read, pages.truncated);
}

/** #282: the same view from the read model, no call. ponytail: the stored listing keeps no "items were left" flag, so reaching the ceiling reads as
 * truncated (a Project of exactly 1000 says so); store the flag with the listing if that misleads. */
export function storedProject(db: ReadModel, key: ListingKey, read: ProjectRead): Omit<ProjectView, 'statuses'> {
  const { nodes } = readListing(db, key);
  return viewOf(nodes, rebuildFields(db.projectFields(key.source, key.project)), read, nodes.length >= PROJECT_ITEM_LIMIT);
}
