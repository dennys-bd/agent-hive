import type { GqlJson } from '../sources/github-gql.js';
import { ADD_COMMENT, ADD_LABELS, ISSUE_STATE, REMOVE_LABELS, REPO_LABELS, UPDATE_ISSUE } from './github-repo-queries.js';

/** A repository's owner and name, the variables every query of one repository takes (#757). */
export const ownerName = (repository: string): { owner: string; name: string } => {
  const [owner = '', name = ''] = repository.split('/');
  return { owner, name };
};

/** The `repository` of an answer, or an error naming it when GitHub answers none. */
export function repositoryOf<T>(data: unknown, repository: string): T {
  const repo = (data as { repository?: T | null } | null)?.repository;
  if (!repo) throw new Error(`repository not found: ${repository}`);
  return repo;
}

/** The issue changed on GitHub since the page read it (#757): the edit is refused and nothing is written. */
export class IssueChanged extends Error {
  constructor() {
    super('the issue changed on GitHub since it was read');
    this.name = 'IssueChanged';
  }
}

/** The issue's node id and updatedAt, what every write reads first (#757). */
export async function issueState(gql: GqlJson, repository: string, number: number): Promise<{ id: string; updatedAt: string }> {
  const data = await gql(ISSUE_STATE, { ...ownerName(repository), number });
  const issue = repositoryOf<{ issue?: { id: string; updatedAt: string } | null }>(data, repository).issue;
  if (!issue) throw new Error(`issue not found: ${repository}#${number}`);
  return issue;
}

/** A title or description edit (#757): only the fields sent. */
export interface IssueEdit { title?: string; body?: string }

/** The edit, unless GitHub's updatedAt is not the one the page read: IssueChanged then. ponytail: the check reads then writes, so an edit
 * landing between the two is overwritten; updateIssue takes no expected updatedAt. */
export async function editIssue(gql: GqlJson, repository: string, number: number, edit: IssueEdit, updatedAt: string): Promise<void> {
  const issue = await issueState(gql, repository, number);
  if (issue.updatedAt !== updatedAt) throw new IssueChanged();
  await gql(UPDATE_ISSUE, { id: issue.id, ...edit });
}

// The repository's labels, name -> id, in GitHub's order by name; serves setLabels
async function labelIds(gql: GqlJson, repository: string): Promise<Map<string, string>> {
  const data = await gql(REPO_LABELS, ownerName(repository));
  const labels = repositoryOf<{ labels: { nodes: { id: string; name: string }[] } }>(data, repository).labels.nodes;
  return new Map(labels.map((label) => [label.name, label.id]));
}

/** A label name the repository does not have (#757): the write is refused before anything is sent. */
export class UnknownLabel extends Error {
  constructor(name: string) {
    super(`label not in the repository: ${name}`);
    this.name = 'UnknownLabel';
  }
}

/** Adds and removes labels on the issue by name (#757), each list in one call; an empty list sends nothing. Labels check no updatedAt. */
export async function setLabels(gql: GqlJson, repository: string, number: number, add: string[], remove: string[]): Promise<void> {
  const ids = await labelIds(gql, repository);
  const idOf = (name: string): string => {
    const id = ids.get(name);
    if (id === undefined) throw new UnknownLabel(name);
    return id;
  };
  const adding = add.map(idOf);
  const removing = remove.map(idOf);
  const { id } = await issueState(gql, repository, number);
  if (adding.length > 0) await gql(ADD_LABELS, { id, labels: adding });
  if (removing.length > 0) await gql(REMOVE_LABELS, { id, labels: removing });
}

/** A comment on the issue (#757), posted with the Hive's login. */
export async function comment(gql: GqlJson, repository: string, number: number, body: string): Promise<void> {
  const { id } = await issueState(gql, repository, number);
  await gql(ADD_COMMENT, { id, body });
}
