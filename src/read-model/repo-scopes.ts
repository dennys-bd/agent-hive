import type { SyncKind } from './db.js';
import { assigneeLoginsFromRest, issueTypeNamesFromRest, labelNamesFromRest, milestoneTitlesFromRest, repoFromRest } from './normalize.js';
import { throwIfStopped, type SyncDeps, type SyncReport } from './sync.js';

// The repository's own data (#181): neither endpoint takes since, so each scope keeps only the first page's ETag; a 304 costs no quota
type RepoScopeKind = Extract<SyncKind, 'repo' | 'labels' | 'assignees' | 'milestones' | 'issueTypes'>;

export const repoPath = (repository: string): string => `repos/${repository}`;
export const labelsPath = (repository: string): string => `repos/${repository}/labels?per_page=100`;

interface Read { bodies: unknown[]; etag: string | null }

// Every page from `path`, the first sent with the saved ETag (the PR poll's parts read through it too, #186); undefined on a 304, which only that first page can answer. Nothing is written
// here, so a stop or a failure between pages leaves the scope as it was
export async function readAll(deps: SyncDeps, path: string, etag: string | null): Promise<Read | undefined> {
  const bodies: unknown[] = [];
  let next: string | undefined = path;
  let firstEtag: string | null = null;
  while (next !== undefined) {
    throwIfStopped(deps);
    const isFirst = bodies.length === 0;
    const answer = await deps.rest(next, isFirst ? (etag ?? undefined) : undefined);
    if (answer.status === 304) return undefined;
    if (answer.status !== 200) throw new Error(`read model: ${next} answered HTTP ${answer.status}`);
    if (isFirst) firstEtag = answer.etag ?? null;
    bodies.push(answer.body);
    next = answer.next;
  }
  return { bodies, etag: firstEtag };
}

// A 304 stamps syncedAt and writes nothing; a 200 is normalized and written in one transaction (a malformed answer throws before the ETag is
// kept), then the ETag and syncedAt. `key` is a repository, or an owner for issueTypes (#282)
async function syncConditional(deps: SyncDeps, key: string, kind: RepoScopeKind, path: string, write: (bodies: unknown[]) => boolean): Promise<SyncReport> {
  const { db, source } = deps;
  const saved = db.scope(source, key, kind);
  const read = await readAll(deps, path, saved?.etag ?? null);
  const syncedAt = deps.now().toISOString();
  if (read === undefined) {
    db.setScope(source, key, kind, { cursor: null, etag: saved?.etag ?? null, syncedAt });
    return { kinds: [], requests: { 200: 0, 304: 1 } };
  }
  const wrote = db.transaction(() => write(read.bodies));
  db.setScope(source, key, kind, { cursor: null, etag: read.etag, syncedAt });
  return { kinds: wrote ? [kind] : [], requests: { 200: read.bodies.length, 304: 0 } };
}

/** The repos row (#181): the summary's url, push rights, issues switch, fork parent and push date. */
export const syncRepo = (deps: SyncDeps, repository: string): Promise<SyncReport> =>
  syncConditional(deps, repository, 'repo', repoPath(repository), ([body]) => deps.db.setRepo(repoFromRest(deps.source, repository, body)));

/** Every label of the repository (#181), replaced whole: what the labels popover lists, a label no issue carries included. */
export const syncLabels = (deps: SyncDeps, repository: string): Promise<SyncReport> =>
  syncConditional(deps, repository, 'labels', labelsPath(repository), (bodies) => deps.db.setLabels(deps.source, repository, bodies.flatMap(labelNamesFromRest)));

export const assigneesPath = (repository: string): string => `repos/${repository}/assignees?per_page=100`;
export const milestonesPath = (repository: string): string => `repos/${repository}/milestones?state=open&per_page=100`;
export const issueTypesPath = (owner: string): string => `orgs/${owner}/issue-types`;
const ownerOf = (repository: string): string => repository.slice(0, repository.indexOf('/'));

// GitHub answers a user owner's issue types with a 404: none, and the scope still counts as synced. ponytail: no ETag comes with it, so a user
// owner's 404 is asked again every round (one request per repository); keep the 404 as the scope's reading if that shows in the quota
const noneOn404 = (deps: SyncDeps): SyncDeps => ({
  ...deps,
  rest: async (path, etag) => {
    const answer = await deps.rest(path, etag);
    return answer.status === 404 ? { status: 200, body: [] } : answer;
  },
});

/** The repository's assignable users (#282), replaced whole: what the assignees editor offers. */
export const syncAssignees = (deps: SyncDeps, repository: string): Promise<SyncReport> =>
  syncConditional(deps, repository, 'assignees', assigneesPath(repository), (bodies) => deps.db.setAssignees(deps.source, repository, bodies.flatMap(assigneeLoginsFromRest)));

/** The repository's open milestones (#282), replaced whole: what the milestone editor offers. */
export const syncMilestones = (deps: SyncDeps, repository: string): Promise<SyncReport> =>
  syncConditional(deps, repository, 'milestones', milestonesPath(repository), (bodies) => deps.db.setMilestones(deps.source, repository, bodies.flatMap(milestoneTitlesFromRest)));

/** The repository's owner's issue types (#282), replaced whole and keyed by the owner: what the type editor offers. */
export function syncIssueTypes(deps: SyncDeps, repository: string): Promise<SyncReport> {
  const owner = ownerOf(repository);
  return syncConditional(noneOn404(deps), owner, 'issueTypes', issueTypesPath(owner), (bodies) => deps.db.setIssueTypes(deps.source, owner, bodies.flatMap(issueTypeNamesFromRest)));
}
