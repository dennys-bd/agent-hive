import type { JiraCredential } from '../credentials.js';
import type { Logger } from '../log.js';
import type { ReportRetry } from '../source-errors.js';
import type { JiraCall } from '../sources/jira-queries.js';
import { syncProject, type JiraSyncDeps } from '../sources/jira-sync.js';
import type { SourceConfig, SourceSync } from '../types.js';
import type { ReadModel, SyncKind } from './db.js';

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

async function syncGroup(deps: JiraRoundDeps, group: JiraGroup, accountId: string): Promise<void> {
  const { changed } = await syncProject(syncDepsOf(deps, group, accountId));
  if (changed) deps.notify(whereOf(group), ['items']); // one event per shared sync; no GitHub view reacts to items
}

// No login for the site: no call, one debug line. The poll reports the missing login through listItems, not the loop
async function runGroup(deps: JiraRoundDeps, group: JiraGroup): Promise<void> {
  const cred = await deps.credential(group.site);
  if (cred === undefined) {
    deps.log.debug(`read model: ${whereOf(group)} is not synced: jira:${group.site} is not connected`);
    return;
  }
  await syncGroup(deps, group, cred.accountId);
}

/** The Jira part of a round (#824): one sync per site and project, in config order; checked for a stop before each group. */
export async function syncJira(deps: JiraRoundDeps, sources: readonly JiraRoundSource[]): Promise<void> {
  for (const group of groupsOf(sources)) {
    if (deps.isStopped()) return; // the database must never close under a Jira transaction
    await runGroup(deps, group);
  }
}
