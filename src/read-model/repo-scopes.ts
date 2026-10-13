import type { SyncKind } from './db.js';
import { labelNamesFromRest, repoFromRest } from './normalize.js';
import { throwIfStopped, type SyncDeps, type SyncReport } from './sync.js';

// The repository's own data (#181): neither endpoint takes since, so each scope keeps only the first page's ETag; a 304 costs no quota
type RepoScopeKind = Extract<SyncKind, 'repo' | 'labels'>;

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
// kept), then the ETag and syncedAt
async function syncConditional(deps: SyncDeps, repository: string, kind: RepoScopeKind, path: string, write: (bodies: unknown[]) => boolean): Promise<SyncReport> {
  const { db, source } = deps;
  const saved = db.scope(source, repository, kind);
  const read = await readAll(deps, path, saved?.etag ?? null);
  const syncedAt = deps.now().toISOString();
  if (read === undefined) {
    db.setScope(source, repository, kind, { cursor: null, etag: saved?.etag ?? null, syncedAt });
    return { kinds: [], requests: { 200: 0, 304: 1 } };
  }
  const wrote = db.transaction(() => write(read.bodies));
  db.setScope(source, repository, kind, { cursor: null, etag: read.etag, syncedAt });
  return { kinds: wrote ? [kind] : [], requests: { 200: read.bodies.length, 304: 0 } };
}

/** The repos row (#181): the summary's url, push rights, issues switch, fork parent and push date. */
export const syncRepo = (deps: SyncDeps, repository: string): Promise<SyncReport> =>
  syncConditional(deps, repository, 'repo', repoPath(repository), ([body]) => deps.db.setRepo(repoFromRest(deps.source, repository, body)));

/** Every label of the repository (#181), replaced whole: what the labels popover lists, a label no issue carries included. */
export const syncLabels = (deps: SyncDeps, repository: string): Promise<SyncReport> =>
  syncConditional(deps, repository, 'labels', labelsPath(repository), (bodies) => deps.db.setLabels(deps.source, repository, bodies.flatMap(labelNamesFromRest)));
