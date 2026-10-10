import { join } from 'node:path';
import { createJsonStore, type JsonStore } from './json-store.js';
import { droppedReviews } from './review-store.js';
import { prsOf } from './activities.js';
import type { FileDiff, HiveEvent, PrDraft, PrReviewFile, State } from './types.js';

// A PR's review (#592): one JSON file per PR link under <home>/pr-reviews/, outside State, as a task's #591 review is. Keyed by the link, not
// the task, so a PR with no task fits later. GitHub's threads are never stored: they are read again. The edits are pure.

const DIR = 'pr-reviews';
export const EMPTY_PR_REVIEW: PrReviewFile = { reviewed: [], drafts: [] };

/** The file of a PR (#592): its link encoded, so its `/` and `:` never leave the directory. */
export const prReviewPath = (home: string, url: string): string => join(home, DIR, `${encodeURIComponent(url)}.json`);

// ponytail: a shallow check, the Hive is the file's only writer; a deep one if a hand edit ever breaks a page. A #592 file's general comment
// is left out (#758): the review's summary is no longer stored
function parsePrReviewFile(raw: unknown): PrReviewFile {
  const file = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(file.reviewed) || !Array.isArray(file.drafts)) throw new Error('not a PR review file');
  return { reviewed: file.reviewed as PrReviewFile['reviewed'], drafts: file.drafts as PrDraft[] };
}

export type PrReviewStore = JsonStore<PrReviewFile>;

/** The PR review files (#592, #758): every link's is live, since a PR without a task keeps its file too; a task's PRs' files go with the task
 * (droppedPrReviews). ponytail: an edit racing a task's delete may leave a small file behind. */
export function createPrReviewStore(home: string): PrReviewStore {
  return createJsonStore({ pathOf: (url) => prReviewPath(home, url), empty: EMPTY_PR_REVIEW, parse: parsePrReviewFile, isLive: () => true });
}

/** The PR links whose file goes with a reduction (#592): every PR of a task droppedReviews names, unless a task still in the State holds it. */
export function droppedPrReviews(prev: State, next: State, event: HiveEvent): string[] {
  const dropped = new Set(droppedReviews(prev, next, event));
  const kept = new Set(next.activityRecords.flatMap((r) => (r.prs ?? []).map((pr) => pr.url)));
  const urls = [...dropped].flatMap((id) => prsOf(prev, id).map((pr) => pr.url));
  return [...new Set(urls)].filter((url) => !kept.has(url));
}

/** A file of the PR marked reviewed with its hash now, or unmarked (#592): a PR has one diff, so no scope. */
export function markPrReviewed(file: PrReviewFile, mark: { path: string; hash: string }, reviewed: boolean): PrReviewFile {
  const rest = file.reviewed.filter((m) => m.path !== mark.path);
  return { ...file, reviewed: reviewed ? [...rest, mark] : rest };
}

/** The marks whose file changed since, or left the diff, dropped (#592, as #591's); `file` itself when none goes. */
export function dropStalePrMarks(file: PrReviewFile, files: Pick<FileDiff, 'path' | 'hash'>[]): PrReviewFile {
  const hashes = new Map(files.map((f) => [f.path, f.hash]));
  const kept = file.reviewed.filter((m) => hashes.get(m.path) === m.hash);
  return kept.length === file.reviewed.length ? file : { ...file, reviewed: kept };
}

export const addPrDraft = (file: PrReviewFile, draft: PrDraft): PrReviewFile => ({ ...file, drafts: [...file.drafts, draft] });
export const updatePrDraft = (file: PrReviewFile, id: string, text: string): PrReviewFile =>
  ({ ...file, drafts: file.drafts.map((d) => (d.id === id ? { ...d, text } : d)) });
export const removePrDraft = (file: PrReviewFile, id: string): PrReviewFile => ({ ...file, drafts: file.drafts.filter((d) => d.id !== id) });

/** A PR review GitHub took (#592, #758): the drafts it carried go; a draft added while it was out stays. */
export const clearSubmitted = (file: PrReviewFile, sent: string[]): PrReviewFile => ({ ...file, drafts: file.drafts.filter((d) => !sent.includes(d.id)) });
