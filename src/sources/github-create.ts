import type { CreatedRef, Gql } from '../types.js';
import type { ItemStore } from '../read-model/items.js';
import { CreateRefusedError, IssuePlacementError } from '../source-create.js';
import { ADD_PROJECT_ITEM, CREATE_ISSUE, labelsMutation, REPOSITORY_ID, REPOSITORY_LABELS, SET_OPTION, type AddProjectItemData, type CreateIssueData, type RepositoryLabelsData } from './github-queries.js';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The node id of `repository` (owner/name, as the parser checked it): what createIssue takes. */
export async function repositoryNodeId(gql: Gql, repository: string): Promise<string> {
  const [owner, name] = repository.split('/');
  const id = ((await gql(REPOSITORY_ID, { owner, name })) as { repository?: { id: string } | null }).repository?.id;
  if (!id) throw new Error(`repository ${repository} not found`);
  return id;
}

/** The labels of `repository` (#767): one page of REPO_LABEL_LIMIT, what a new issue's label names resolve to. */
export async function repositoryLabels(gql: Gql, repository: string): Promise<{ id: string; name: string }[]> {
  const [owner, name] = repository.split('/');
  const found = ((await gql(REPOSITORY_LABELS, { owner, name })) as RepositoryLabelsData).repository;
  if (!found) throw new Error(`repository ${repository} not found`);
  return found.labels?.nodes ?? [];
}

/** Where a new issue goes (#846): the repository's node id and, unless it stays off the Project (#767), the Project, its Status field and the option to set. */
export interface IssueTarget { repositoryId: string; project?: { projectId: string; statusFieldId: string; optionId: string } }

/** The issue, then its labels, then its Project item and Status, in that order (#846, #767). A failure once the issue exists throws
 * IssuePlacementError naming its url, so the user can find it: nothing is rolled back. Off the Project, no item and no itemId. */
export async function createProjectIssue(gql: Gql, target: IssueTarget, fields: { title: string; body?: string; labelIds: string[] }): Promise<{ itemId?: string; ref: CreatedRef }> {
  const created = (await gql(CREATE_ISSUE, { repositoryId: target.repositoryId, title: fields.title, body: fields.body ?? '' })) as CreateIssueData;
  const issue = created.createIssue?.issue;
  if (!issue) throw new Error('GitHub created no issue');
  const made = { ref: { id: String(issue.number), url: issue.url } };
  try {
    // a scalar Gql carries no list: one ID! variable per label, as the field write's labels (#60)
    const { labelIds } = fields;
    if (labelIds.length > 0) await gql(labelsMutation('addLabelsToLabelable', labelIds.length), { labelableId: issue.id, ...Object.fromEntries(labelIds.map((id, i) => [`l${i}`, id])) });
    if (target.project === undefined) return made;
    const { projectId, statusFieldId, optionId } = target.project;
    const added = (await gql(ADD_PROJECT_ITEM, { projectId, contentId: issue.id })) as AddProjectItemData;
    const itemId = added.addProjectV2ItemById?.item?.id;
    if (!itemId) throw new Error('GitHub added no project item');
    await gql(SET_OPTION, { projectId, itemId, fieldId: statusFieldId, singleSelectOptionId: optionId });
    return { itemId, ...made };
  } catch (err) {
    throw new IssuePlacementError(`issue ${issue.url} was created but not labeled or placed on the Project: ${errorMessage(err)}`, made.ref);
  }
}

/** The create dialog's menus (#768): every Status option in the Project's order, from memory, and the repository's label names, from the
 * read model once its labels scope has completed a round, else read live (not cached: the dialog asks once per repository picked). */
export async function readCreateOptions(gql: Gql, resolved: { options: { name: string }[] } | undefined, repository: string | undefined, items?: ItemStore): Promise<{ statuses: string[]; labels: string[] }> {
  if (!resolved) throw new Error('source not resolved: call resolveFields() first');
  if (repository === undefined) throw new CreateRefusedError('source has no repository for new issues');
  const statuses = resolved.options.map((o) => o.name);
  const rows = await items?.source();
  // syncedAt tells a synced empty set from one never read: labels() answers [] for both
  if (items !== undefined && rows !== undefined && typeof items.db.scope(rows, repository, 'labels')?.syncedAt === 'string') return { statuses, labels: items.db.labels(rows, repository) };
  return { statuses, labels: (await repositoryLabels(gql, repository)).map((l) => l.name) };
}
