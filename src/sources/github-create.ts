import type { Gql } from '../types.js';
import { ADD_PROJECT_ITEM, CREATE_ISSUE, REPOSITORY_ID, SET_OPTION, type AddProjectItemData, type CreateIssueData } from './github-queries.js';

/** Where a new issue goes (#846): the Project, its Status field and the option to set, and the repository's node id. */
export interface IssueTarget { projectId: string; statusFieldId: string; optionId: string; repositoryId: string }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The node id of `repository` (owner/name, as the parser checked it): what createIssue takes. */
export async function repositoryNodeId(gql: Gql, repository: string): Promise<string> {
  const [owner, name] = repository.split('/');
  const id = ((await gql(REPOSITORY_ID, { owner, name })) as { repository?: { id: string } | null }).repository?.id;
  if (!id) throw new Error(`repository ${repository} not found`);
  return id;
}

/** The issue, then its Project item, then its Status, in that order; resolves to the item's id. A failure once the issue exists names its url so
 * the user can find it: nothing is rolled back. */
export async function createProjectIssue(gql: Gql, target: IssueTarget, fields: { title: string; body?: string }): Promise<string> {
  const created = (await gql(CREATE_ISSUE, { repositoryId: target.repositoryId, title: fields.title, body: fields.body ?? '' })) as CreateIssueData;
  const issue = created.createIssue?.issue;
  if (!issue) throw new Error('GitHub created no issue');
  try {
    const added = (await gql(ADD_PROJECT_ITEM, { projectId: target.projectId, contentId: issue.id })) as AddProjectItemData;
    const itemId = added.addProjectV2ItemById?.item?.id;
    if (!itemId) throw new Error('GitHub added no project item');
    await gql(SET_OPTION, { projectId: target.projectId, itemId, fieldId: target.statusFieldId, singleSelectOptionId: target.optionId });
    return itemId;
  } catch (err) {
    throw new Error(`issue ${issue.url} was created but not placed on the Project: ${errorMessage(err)}`);
  }
}
