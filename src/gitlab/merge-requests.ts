// The Hive's own merge request calls (#1053): a project's id and default branch, a merge request opened (or the project's open one adopted),
// and the head of a merged one. Each caller picks GitHub or GitLab by the host; this is the only GitLab side, and it goes through the
// GitlabApi of the host's account, the only code that sends its token (#1047, #1048).
import { type GitlabApi, listAll, projectPath } from './api.js';
import { mrState } from './mr-state.js';

/** The client of a GitLab host's stored account, undefined with none: gitlabAccess of #1048, injected so the tests pass a fake. */
export type GitlabAccess = (host: string) => Promise<GitlabApi | undefined>;

export interface MergeRequestInput { source: string; target: string; title: string; body: string }

const field = (body: unknown, name: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const projectRoute = (path: string): string => `projects/${projectPath(path)}`;

/** The project's id, as a string (the shape readRepository answers for GitHub, so a delivery's docs keep theirs), and its default branch. */
export async function readProject(api: GitlabApi, path: string): Promise<{ id: string; defaultBranch: string }> {
  const { body } = await api.get(projectRoute(path));
  const id = field(body, 'id');
  const defaultBranch = field(body, 'default_branch');
  if (!isId(id) || typeof defaultBranch !== 'string' || defaultBranch === '') throw new Error(`gitlab api: ${path} answered no project with a default branch`);
  return { id: String(id), defaultBranch };
}

// One merge request as GitLab answers it: its iid and link, or a throw, never a guessed number
function mergeRequestOf(body: unknown): { iid: number; url: string } {
  const iid = field(body, 'iid');
  const url = field(body, 'web_url');
  if (!isId(iid) || typeof url !== 'string' || !url.startsWith('https://')) throw new Error('gitlab api: the merge request answer has no iid or link');
  return { iid, url };
}

// The open MR of this branch into the target whose source is the project itself: a fork's MR of the same branch name is not ours
async function openOne(api: GitlabApi, path: string, mr: MergeRequestInput): Promise<{ iid: number; url: string } | undefined> {
  const { id } = await readProject(api, path);
  const query = new URLSearchParams({ state: 'opened', source_branch: mr.source, target_branch: mr.target });
  const open = await listAll(api, `${projectRoute(path)}/merge_requests?${query.toString()}`);
  const own = open.find((m) => String(field(m, 'source_project_id')) === id);
  return own === undefined ? undefined : mergeRequestOf(own);
}

/** The MR from `source` into `target`; when GitLab refuses the create (a crash between opening and recording leaves one), the project's own
 * open MR of that branch. None: the create's error. */
export async function openMergeRequest(api: GitlabApi, path: string, mr: MergeRequestInput): Promise<{ iid: number; url: string }> {
  const body = { source_branch: mr.source, target_branch: mr.target, title: mr.title, description: mr.body };
  try {
    return mergeRequestOf((await api.post(`${projectRoute(path)}/merge_requests`, body)).body);
  } catch (err) {
    const open = await openOne(api, path, mr).catch(() => undefined);
    if (open === undefined) throw err;
    return open;
  }
}

/** The head GitLab merged, undefined when the MR is not merged or names no sha; an answer with no state throws. */
export async function mergedMrHead(api: GitlabApi, path: string, iid: number): Promise<string | undefined> {
  const { body } = await api.get(`${projectRoute(path)}/merge_requests/${iid}`);
  const state = field(body, 'state');
  if (typeof state !== 'string') throw new Error('gitlab api: the merge request answer has no state');
  const sha = field(body, 'sha');
  return mrState(state) === 'merged' && typeof sha === 'string' && sha !== '' ? sha : undefined;
}
