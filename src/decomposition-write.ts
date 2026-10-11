// A decomposition written to GitHub (#865), with the Hive's own login (#757): the root (a GitHub goal's own issue, its design posted once as
// a comment, or a local goal's new root issue), every node's issue, each one in the chosen project and column, then the sub-issues in file
// order and the blockers. Each issue is recorded through `record` as soon as GitHub made it, before anything else is asked, so a retry
// creates none twice; everything after the creation is replayed, and a link GitHub already holds is done.
import { DESIGN_KEY, DONE_KEY, ROOT_KEY, designComment, issueBody, rootBody } from './decomposition.js';
import { parentOf } from './decomposition-check.js';
import { ownerName, repositoryOf } from './repos/github-repos.js';
import { ADD_COMMENT } from './repos/github-repo-queries.js';
import type { GqlJson } from './sources/github-gql.js';
import {
  ADD_BLOCKED_BY, ADD_PROJECT_ITEM, ADD_SUB_ISSUE, type AddProjectItemData, CREATE_ISSUE, CREATE_LABEL, type CreateIssueData, type CreateLabelData, ISSUE_ID,
  type IssueIdData, REPOSITORY_ID, REPOSITORY_LABEL, type RepositoryLabelData, SET_OPTION,
} from './sources/github-queries.js';
import type { Decomposition, DecompositionNode } from './types.js';

/** Where a decomposition goes (#865). */
export interface WriteTarget {
  repository: string; // owner/name: the goal issue's, or a local goal's workspace origin
  goal?: number; // a GitHub goal's issue; absent: a local goal, which gets a root issue
  project: { projectId: string; fieldId: string; optionId: string }; // the chosen source's project, its Status field and the chosen option
}

export interface WriteDeps {
  gql: GqlJson; // gh api graphql --input -: the Hive's own login
  record(id: string, number: number): Promise<void>; // the route's decompositionIssue, done before the next step
}

interface Issue { id: string; number: number }
interface Ctx extends WriteDeps { target: WriteTarget; recorded: Readonly<Record<string, number>>; repositoryId(): Promise<string>; labelIds(): Promise<string[]> }

// ponytail: GitHub's words for a sub-issue or a blocker already linked; a stricter match if it ever swallows a real refusal
const EXISTING_LINK = /already|duplicate/i;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
};

const LABEL_COLOR = 'ededed'; // GitHub's own grey for a new label (#936): the user recolours it on GitHub

// The file's label by name, created in the repository when it lacks it (#936)
async function labelId(ctx: Pick<Ctx, 'gql' | 'target' | 'repositoryId'>, name: string): Promise<string> {
  const found = (await ctx.gql(REPOSITORY_LABEL, { ...ownerName(ctx.target.repository), label: name })) as RepositoryLabelData;
  const id = found.repository?.label?.id;
  if (id !== undefined) return id;
  const made = (await ctx.gql(CREATE_LABEL, { repositoryId: await ctx.repositoryId(), name, color: LABEL_COLOR })) as CreateLabelData;
  const created = made.createLabel?.label?.id;
  if (created === undefined) throw new Error(`createLabel answered no label for "${name}"`);
  return created;
}

async function issueAt(ctx: Ctx, number: number): Promise<Issue> {
  const data = (await ctx.gql(ISSUE_ID, { ...ownerName(ctx.target.repository), number })) as IssueIdData;
  const id = data.repository?.issue?.id;
  if (id === undefined) throw new Error(`issue not found: ${ctx.target.repository}#${number}`);
  return { id, number };
}

// A recorded key is resolved again by its number; otherwise the issue is created and recorded before anything else is asked. ponytail: a
// crash between GitHub's answer and the record leaves one duplicate (the spec accepts it)
async function ensure(ctx: Ctx, key: string, title: string, body: string): Promise<Issue> {
  const number = ctx.recorded[key];
  if (number !== undefined) return issueAt(ctx, number);
  const data = (await ctx.gql(CREATE_ISSUE, { repositoryId: await ctx.repositoryId(), title, body, labelIds: await ctx.labelIds() })) as CreateIssueData;
  const issue = data.createIssue?.issue;
  if (!issue) throw new Error(`createIssue answered no issue for "${title}"`);
  await ctx.record(key, issue.number);
  return issue;
}

// A link replayed on every press: one GitHub already holds is done
async function link(ctx: Ctx, query: string, variables: Record<string, string>): Promise<void> {
  try {
    await ctx.gql(query, variables);
  } catch (err) {
    if (!EXISTING_LINK.test(messageOf(err))) throw err;
  }
}

// The tree's root: a GitHub goal's own issue, its design posted once as a comment (never edited into its body); or a local goal's new root issue
async function rootOf(ctx: Ctx, d: Decomposition): Promise<Issue> {
  const { goal } = ctx.target;
  if (goal === undefined) return ensure(ctx, ROOT_KEY, d.title, rootBody(d));
  const issue = await issueAt(ctx, goal);
  if (d.design !== undefined && ctx.recorded[DESIGN_KEY] === undefined) {
    await ctx.gql(ADD_COMMENT, { id: issue.id, body: designComment(d) });
    await ctx.record(DESIGN_KEY, goal);
  }
  return issue;
}

// The issue in the chosen project and column: an item already there is answered as it is, so a replay only sets the Status again
async function place(ctx: Ctx, issue: Issue): Promise<void> {
  const { projectId, fieldId, optionId } = ctx.target.project;
  const data = (await ctx.gql(ADD_PROJECT_ITEM, { projectId, contentId: issue.id })) as AddProjectItemData;
  const itemId = data.addProjectV2ItemById?.item?.id;
  if (itemId === undefined) throw new Error(`addProjectV2ItemById answered no item for #${issue.number}`);
  await ctx.gql(SET_OPTION, { projectId, itemId, fieldId, singleSelectOptionId: optionId });
}

const issueOf = (issues: ReadonlyMap<string, Issue>, id: string): Issue => {
  const issue = issues.get(id);
  if (issue === undefined) throw new Error(`no issue for node ${id}`);
  return issue;
};

// Each issue under its parent, or under the root, in file order (GitHub keeps the order they were added in); then one blocker per edge
async function linkAll(ctx: Ctx, nodes: DecompositionNode[], issues: ReadonlyMap<string, Issue>, root: Issue): Promise<void> {
  for (const node of nodes) {
    const parent = parentOf(node.id);
    await link(ctx, ADD_SUB_ISSUE, { issueId: (parent === '' ? root : issueOf(issues, parent)).id, subIssueId: issueOf(issues, node.id).id });
  }
  for (const node of nodes) {
    for (const blocker of node.blockedBy) await link(ctx, ADD_BLOCKED_BY, { issueId: issueOf(issues, node.id).id, blockingIssueId: issueOf(issues, blocker).id });
  }
}

/** The write (#865), skipping the keys `recorded` holds (matching by id only). Undefined once every step is done and `done` recorded, else
 * the first GitHub error's message: what was done stays recorded, and a second press resumes. A secondary rate limit is such an error. */
export async function writeDecomposition(deps: WriteDeps, d: Decomposition, target: WriteTarget, recorded: Readonly<Record<string, number>>): Promise<string | undefined> {
  const repositoryId = once(async () => repositoryOf<{ id: string }>(await deps.gql(REPOSITORY_ID, ownerName(target.repository)), target.repository).id);
  // asked only when an issue is created, so a retry with every issue recorded asks nothing (#936)
  const labelIds = once(async (): Promise<string[]> => (d.label === undefined ? [] : [await labelId({ gql: deps.gql, target, repositoryId }, d.label)]));
  const ctx: Ctx = { ...deps, target, recorded, repositoryId, labelIds };
  try {
    const root = await rootOf(ctx, d);
    const issues = new Map<string, Issue>();
    for (const node of d.nodes) issues.set(node.id, await ensure(ctx, node.id, node.title, issueBody(node)));
    const placed = target.goal === undefined ? [root, ...issues.values()] : [...issues.values()];
    for (const issue of placed) await place(ctx, issue);
    await linkAll(ctx, d.nodes, issues, root);
    await deps.record(DONE_KEY, root.number);
    return undefined;
  } catch (err) {
    return messageOf(err);
  }
}
