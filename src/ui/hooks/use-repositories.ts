// The repositories of the flow sidebar (#757): one list for the page, read when the sidebar mounts and on the repository header's refresh,
// never polled and never in the State; the sidebar, the Dashboard's pick and the header read the same answer. The pins live in the view
// state (#484) under `repositories`.
import { useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { RepoSummary } from '../../types';
import { readQuotaJson } from '@/hooks/use-project';
import { onReadModelEvent } from '@/lib/review-events';
import { readView, writeView } from '@/lib/view-state';

export const RECENT_SHOWN = 5; // handoff 02: the recent rows before +N

let repositories: RepoSummary[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** GET /repositories into the page's list (#757); anything but a list reads as none. A failure keeps the last list and toasts; never rejects. */
export async function reloadRepositories(): Promise<void> {
  try {
    const read = await readQuotaJson<unknown>('/repositories');
    repositories = Array.isArray(read) ? (read as RepoSummary[]) : [];
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return;
  }
  for (const listener of listeners) listener();
}

/** The page's repositories, as the last read left them. */
export const useRepositories = (): RepoSummary[] => useSyncExternalStore(subscribe, () => repositories);

/** Tests only: the list before any read. */
export function resetRepositories(): void {
  repositories = [];
}

// #182: a summary's counts and last activity derive from the issue rows and its PR count from the repo rows, so any change reads the list
// again. Subscribed once at load and never dropped: it lives as long as the page, as the list it fills; resetRepositories leaves it
onReadModelEvent(() => { void reloadRepositories(); });

const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string');

// The stored JSON is not trusted: anything but { pinned: string[] } reads as no pins
function readPinned(): string[] {
  const stored = readView('repositories');
  const pinned = typeof stored === 'object' && stored !== null ? (stored as { pinned?: unknown }).pinned : undefined;
  return isNames(pinned) ? pinned : [];
}

/** The pinned repositories in pin order, and how to pin or unpin one: a pin goes last; each change is saved at once. */
export function usePinned(): [string[], (repository: string, isPinned: boolean) => void] {
  const [pinned, setPinned] = useState(readPinned);
  const pin = (repository: string, isPinned: boolean): void => {
    const next = [...pinned.filter((name) => name !== repository), ...(isPinned ? [repository] : [])];
    setPinned(next);
    writeView('repositories', { pinned: next });
  };
  return [pinned, pin];
}

// A fork that joins no unit is drawn as any other repository (#886): its ↳ would point at whatever row came before it. Only the sidebar's
// copy loses the role; the repository page still reads it for the fork's empty states and PR target
const withoutRole = ({ role: _role, ...rest }: RepoSummary): RepoSummary => rest;

// #854, #886: a repository and the fork whose `pair` names it, as one unit, the repository first. The pair is written with both rows'
// names, so it matches where GitHub's parent name does not after a rename. Matched by name only, since the original may be listed by
// another workspace with no role. Any other repository, or a fork with no original listed, is alone. Each row is placed once, so a fork
// whose original is itself another pair's fork, or two forks naming each other, still show
function unitsOf(list: RepoSummary[]): RepoSummary[][] {
  const placed = new Set<string>();
  return list.flatMap((repo) => {
    if (placed.has(repo.repository)) return [];
    placed.add(repo.repository);
    const fork = list.find((r) => r.role === 'fork' && r.pair === repo.repository && !placed.has(r.repository));
    if (fork === undefined) return [[repo.role === 'fork' ? withoutRole(repo) : repo]];
    placed.add(fork.repository);
    return [[repo, fork]];
  });
}
const newest = (unit: RepoSummary[]): string => unit.reduce((best, r) => ((r.lastActivity ?? '') > best ? (r.lastActivity ?? '') : best), '');

/** The sidebar's two groups (#757): the pinned repositories still listed, in pin order; then every other one by last activity, newest first.
 * A fork's pair stays together (#854), found by the fork's `pair` (#886): it sorts by its newest activity, and a pin on either pins both. A
 * fork with no original listed comes out without its role. */
export function repoGroups(list: RepoSummary[], pinned: string[]): { pinned: RepoSummary[]; recent: RepoSummary[] } {
  const units = unitsOf(list);
  const pinOf = (unit: RepoSummary[]): number => Math.min(...unit.map((r) => (pinned.includes(r.repository) ? pinned.indexOf(r.repository) : Number.POSITIVE_INFINITY)));
  const isPinned = (unit: RepoSummary[]): boolean => pinOf(unit) !== Number.POSITIVE_INFINITY;
  return {
    pinned: units.filter(isPinned).sort((a, b) => pinOf(a) - pinOf(b)).flat(),
    recent: units.filter((u) => !isPinned(u)).sort((a, b) => newest(b).localeCompare(newest(a))).flat(),
  };
}

/** A repository's routes (#757): /repositories/<owner>/<name>, each segment encoded. */
export const repoPath = (repository: string): string => `/repositories/${repository.split('/').map(encodeURIComponent).join('/')}`;
