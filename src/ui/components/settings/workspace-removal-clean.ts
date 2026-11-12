import { activityDeletionUrl, type Refusal, type Removal, UNEXPECTED_REFUSAL } from '@/components/DeleteActivity';
import { removalUrl } from '@/components/settings/WorktreesTab';
import { postJson } from '@/lib/api';
import type { WorkspaceHoldings, WorktreeRow } from '../../../types';

/** One row the clean up acts on (#751): `key` names it in the dialog, `url` is the route that removes it. */
export interface CleanTarget { key: string; url: string }

/** Where a row stands while and after the clean up. */
export type RowState = { kind: 'queued' } | { kind: 'deleting' } | { kind: 'deleted' } | { kind: 'refused'; refused: Refusal };

export const activityKey = (activityId: string): string => `activity:${activityId}`;
export const worktreeKey = (slug: string): string => `worktree:${slug}`;

/** The worktrees no task owns: a task's worktree goes with its activity. */
export const orphanWorktrees = (holdings: WorkspaceHoldings): WorktreeRow[] => holdings.worktrees.filter((row) => row.task === undefined);

/** What clean up posts, in order: each removable activity, then each orphan worktree. A row that is not removable is never in it. */
export function cleanTargets(holdings: WorkspaceHoldings): CleanTarget[] {
  const activities = holdings.activities.flatMap((a) => (a.removable ? [{ key: activityKey(a.activityId), url: activityDeletionUrl(a.activityId) }] : []));
  return [...activities, ...orphanWorktrees(holdings).map((row) => ({ key: worktreeKey(row.slug), url: removalUrl(row) }))];
}

/** A post's answer; one that threw counts as refused, worded as unexpected: the server's own words are never shown (#660). */
export const postRemoval = (url: string, force?: true): Promise<Removal> =>
  postJson<Removal>(url, force ? { force } : undefined).catch((): Removal => ({ removed: false, refused: UNEXPECTED_REFUSAL }));

const stateOf = (answer: Removal): RowState => (answer.removed ? { kind: 'deleted' } : { kind: 'refused', refused: answer.refused });

/** Posts the targets one after another, never forced; `onState` hears each row go deleting, then deleted or refused. */
export async function runClean(targets: CleanTarget[], onState: (key: string, state: RowState) => void): Promise<void> {
  for (const { key, url } of targets) {
    onState(key, { kind: 'deleting' });
    onState(key, stateOf(await postRemoval(url)));
  }
}

/** The one forced post of a refused row (#660). */
export async function runForce(url: string): Promise<RowState> {
  return stateOf(await postRemoval(url, true));
}

export const hasRefused = (states: Record<string, RowState>): boolean => Object.values(states).some((s) => s.kind === 'refused');

export type States = Record<string, RowState>;

/** The post under way, counting from 1: the rows finished plus the one deleting. */
export const progressOf = (states: States): number => Object.values(states).filter((s) => s.kind !== 'queued').length;

export const countsOf = (states: States): { removed: number; refused: number } => ({
  removed: Object.values(states).filter((s) => s.kind === 'deleted').length, refused: Object.values(states).filter((s) => s.kind === 'refused').length,
});
