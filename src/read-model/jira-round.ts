import type { JiraCredential } from '../credentials.js';
import type { Logger } from '../log.js';
import { inRetryWait } from '../polling.js';
import { isNotConnected, isRateLimited, type ReportRetry } from '../source-errors.js';
import type { JiraCall } from '../sources/jira-queries.js';
import { reconcileProject, syncProject, type JiraSyncDeps } from '../sources/jira-sync.js';
import type { SourceConfig, SourceSync } from '../types.js';
import type { ReadModel, SyncKind } from './db.js';
import { isReconcileDue } from './reconcile.js';

/** A jira source as the round reads it (#824): its name, where it reads, and the retry wait its sync line holds (#812). */
export interface JiraRoundSource { name: string; site: string; project: string; backoffUntil?: string }

/** What the Jira round needs (#824): the loop's model, event, log, clock and stop, and each site's stored login and transport. */
export interface JiraRoundDeps {
  db: ReadModel;
  credential(site: string): Promise<JiraCredential | undefined>;
  call(site: string): JiraCall;
  reportRetry: ReportRetry;
  notify(repository: string, kinds: SyncKind[]): void;
  log: Pick<Logger, 'debug' | 'error'>;
  now(): Date;
  isStopped(): boolean;
}

/** One shared sync: a site and a project, and every source that reads it. */
export interface JiraGroup { site: string; project: string; sources: JiraRoundSource[] }

/** Each jira member of the config as the round reads it, its wait taken from its sync line. */
export function jiraRoundSources(sources: readonly SourceConfig[], syncs: Readonly<Record<string, SourceSync>>): JiraRoundSource[] {
  return sources.flatMap((source) => {
    if (source.type !== 'jira') return [];
    const until = Object.hasOwn(syncs, source.name) ? syncs[source.name].backoffUntil : undefined;
    return [{ name: source.name, site: source.site, project: source.project, ...(until === undefined ? {} : { backoffUntil: until }) }];
  });
}

/** The sources by site and project, in first-seen order: a Map keeps a key's first place when it is set again. */
export function groupsOf(sources: readonly JiraRoundSource[]): JiraGroup[] {
  const groups = new Map<string, JiraGroup>();
  for (const source of sources) {
    const key = JSON.stringify([source.site, source.project]);
    const group = groups.get(key);
    groups.set(key, group === undefined ? { site: source.site, project: source.project, sources: [source] } : { ...group, sources: [...group.sources, source] });
  }
  return [...groups.values()];
}

const whereOf = (group: JiraGroup): string => `${group.site}/${group.project}`;

// The store key #819 writes under and #820 reads under; syncProject's clock is in ms, the loop's a Date
const syncDepsOf = (deps: JiraRoundDeps, group: JiraGroup, accountId: string): JiraSyncDeps => ({
  call: deps.call(group.site), db: deps.db, source: `jira:${group.site}:${accountId}`, project: group.project, now: () => deps.now().getTime(),
});

// Beside the items' cursor in sync_scopes, under the project as GitHub's sits under its repository: persisted, so a restart does not reconcile early
function stamp(deps: JiraRoundDeps, sync: JiraSyncDeps): void {
  deps.db.setScope(sync.source, sync.project, 'reconcile', { cursor: null, etag: null, syncedAt: deps.now().toISOString() });
}

// A first sync (no cursor before it) read the whole project: it counts as the reconcile, as GitHub's full first round does (#180).
// A reconcile that fails after the sync stored rows still names them: they are in the model, and the unwritten stamp keeps it due
async function syncGroup(deps: JiraRoundDeps, group: JiraGroup, accountId: string): Promise<void> {
  const sync = syncDepsOf(deps, group, accountId);
  const first = deps.db.items.cursor(sync.source, sync.project) === null;
  let changed = (await syncProject(sync)).changed;
  try {
    if (first) stamp(deps, sync);
    else if (isReconcileDue(deps.db.scope(sync.source, sync.project, 'reconcile')?.syncedAt, deps.now())) {
      changed = (await reconcileProject(sync)).changed || changed;
      stamp(deps, sync);
    }
  } finally {
    if (changed) deps.notify(whereOf(group), ['items']); // one event per shared sync; no GitHub view reacts to items
  }
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The limit belongs to the site and account, so every source of the shared sync waits. A failed report is logged, never thrown
async function reportAll(deps: JiraRoundDeps, group: JiraGroup, until: string): Promise<void> {
  await Promise.all(group.sources.map((source) => deps.reportRetry(source.name, until).catch((err: unknown) => {
    deps.log.error(`read model: the retry of ${source.name} was not reported: ${reasonOf(err)}`);
  })));
}

// A missing login or a 401: one debug line, as the poll reports it through listItems. A 429: the retry for the group, and the cursor stays,
// since syncProject writes nothing on a failed page. Anything else: one error line. The poll owns the source's error on its sync line
async function runGroup(deps: JiraRoundDeps, group: JiraGroup): Promise<void> {
  const where = whereOf(group);
  try {
    const cred = await deps.credential(group.site);
    if (cred === undefined) {
      deps.log.debug(`read model: ${where} is not synced: jira:${group.site} is not connected`);
      return;
    }
    await syncGroup(deps, group, cred.accountId);
  } catch (err) {
    if (isRateLimited(err)) await reportAll(deps, group, err.retryAt);
    else if (isNotConnected(err)) deps.log.debug(`read model: ${where} is not synced: ${err.message}`);
    else deps.log.error(`read model: the sync of ${where} failed: ${reasonOf(err)}`);
  }
}

/** The Jira part of a round (#824): one sync per site and project, in config order. A group waits while any of its sources waits out a
 * rate limit (a write's 429 holds for the shared sync too). A stop is checked before each group. Never rejects. */
export async function syncJira(deps: JiraRoundDeps, sources: readonly JiraRoundSource[]): Promise<void> {
  for (const group of groupsOf(sources)) {
    if (deps.isStopped()) return; // the database must never close under a Jira transaction
    const now = deps.now().getTime();
    if (group.sources.some((source) => inRetryWait(source, now))) continue;
    await runGroup(deps, group);
  }
}
