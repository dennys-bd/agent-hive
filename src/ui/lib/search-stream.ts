import { useEffect, useState } from 'react';
import type { SearchEnd, SearchFileResult, SearchLine, SearchQuery } from '../../types.js';
import { parseJson } from './api.js';

export const SEARCH_DEBOUNCE_MS = 300;
const NO_WORKTREE = new Set([404, 409]); // the activity has no worktree to search

/** What the pane shows of a search (#868). */
export type SearchView =
  | { kind: 'idle'; repos: string[] } // no query: the empty note
  | { kind: 'running'; files: SearchFileResult[]; total: number; repos: string[] }
  | { kind: 'done'; files: SearchFileResult[]; end: SearchEnd }
  | { kind: 'error'; message: string; repos: string[] } // git's fatal reason: the regex's, or the search's
  | { kind: 'unavailable' }; // 404 / 409: the activity has no worktree

export const START: SearchView = { kind: 'running', files: [], total: 0, repos: [] };

const reposOf = (view: SearchView): string[] => ('repos' in view ? view.repos : view.kind === 'done' ? view.end.repos : []);

/** One NDJSON line folded into the view; pure, the old view is never changed. */
export function reduceLine(view: SearchView, line: SearchLine): SearchView {
  if ('error' in line) return { kind: 'error', message: line.error, repos: reposOf(view) };
  if ('done' in line) return { kind: 'done', files: view.kind === 'running' ? view.files : [], end: line };
  if (view.kind !== 'running') return view;
  const spans = line.matches.reduce((n, m) => n + m.spans.length, 0);
  return { ...view, files: [...view.files, line], total: view.total + spans };
}

export const searchUrl = (activityId: string, { q, isCaseSensitive, isWholeWord, isRegex }: SearchQuery): string => {
  const flags = new URLSearchParams({ q, case: isCaseSensitive ? '1' : '0', word: isWholeWord ? '1' : '0', regex: isRegex ? '1' : '0' });
  return `/activities/${encodeURIComponent(activityId)}/search?${flags}`;
};

/** The NDJSON body, one parsed line at a time; a line split across chunks waits for its end, and a last line needs no line break. */
export async function readLines(res: Response, onLine: (line: SearchLine) => void): Promise<void> {
  if (res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  const flush = (text: string): void => { if (text.trim() !== '') onLine(JSON.parse(text) as SearchLine); };
  for (;;) {
    const { done, value } = await reader.read();
    rest += decoder.decode(value, { stream: !done });
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    parts.forEach(flush);
    if (done) break;
  }
  flush(rest);
}

/** The view an empty query settles in: only the closing line's repos matter. */
const settled = (view: SearchView, isEmpty: boolean): SearchView => (isEmpty && view.kind === 'done' ? { kind: 'idle', repos: view.end.repos } : view);

async function run(url: string, signal: AbortSignal, isEmpty: boolean, set: (update: (view: SearchView) => SearchView) => void): Promise<void> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) await parseJson<unknown>(res); // throws the refusal, with its status
    set(() => START);
    await readLines(res, (line) => { if (!signal.aborted) set((view) => settled(reduceLine(view, line), isEmpty)); });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
    const status = (error as { status?: number }).status;
    set((view) => (status !== undefined && NO_WORKTREE.has(status) ? { kind: 'unavailable' } : { kind: 'error', message: error instanceof Error ? error.message : String(error), repos: reposOf(view) }));
  }
}

/** The search of `query` in `activityId`'s root, SEARCH_DEBOUNCE_MS after its last change, the previous one aborted; bump `run` to search again
 * (after a replace). An empty query asks at once, for the closing line's repositories alone. The old view stays on screen meanwhile, but
 * `isCurrent` is false until the view answers this query, these toggles and this run: nothing may be replaced from a stale view. */
export function useSearch(activityId: string, query: SearchQuery, runId: number): { view: SearchView; isCurrent: boolean } {
  const [held, setHeld] = useState<{ view: SearchView; key: string }>({ view: START, key: '' });
  const { q, isCaseSensitive, isWholeWord, isRegex } = query;
  const key = JSON.stringify([activityId, q, isCaseSensitive, isWholeWord, isRegex, runId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId is the trigger of a new search, not a value it uses
  useEffect(() => {
    const controller = new AbortController();
    const url = searchUrl(activityId, { q, isCaseSensitive, isWholeWord, isRegex });
    const set = (update: (view: SearchView) => SearchView): void => setHeld((prev) => ({ view: update(prev.view), key }));
    const start = (): void => { void run(url, controller.signal, q === '', set); };
    if (q === '') start(); // the scope question has nothing to debounce
    const timer = q === '' ? undefined : setTimeout(start, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activityId, q, isCaseSensitive, isWholeWord, isRegex, runId, key]);
  return { view: held.view, isCurrent: held.key === key };
}
