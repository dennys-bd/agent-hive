// The repository lists' column widths (#59), kept in the view state (#484) under repoLists, keyed by repository then by list, so the issue
// and PR lists of one repository resize apart. Its own key keeps `repositories` (the pinned ones, #757) as it is. Anything unreadable reads
// as no saved width, as projectViews does.
import { parseWidths } from './column-widths.js';
import { readView, writeView } from './view-state.js';

export type RepoList = 'issues' | 'prs';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stored = (): Record<string, unknown> => {
  const all = readView('repoLists');
  return isRecord(all) ? all : {};
};

// The repository's entry, own keys only: a name like toString never reads Object.prototype
const entryOf = (all: Record<string, unknown>, repository: string): Record<string, unknown> => {
  const entry = Object.hasOwn(all, repository) ? all[repository] : undefined;
  return isRecord(entry) ? entry : {};
};

export function readRepoListWidths(repository: string, list: RepoList): Record<string, number> {
  return parseWidths(entryOf(stored(), repository)[list]) ?? {};
}

export function writeRepoListWidths(repository: string, list: RepoList, widths: Record<string, number>): void {
  const all = stored();
  writeView('repoLists', { ...all, [repository]: { ...entryOf(all, repository), [list]: widths } });
}
