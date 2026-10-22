import type { FileDiff, PrChanges, PrData, PrThread } from '../../types.js';

/** What the PR page draws (#497): the fields from the model and, once …/changes answered, the diff, the threads, behindBy and the timed review
 * requests; changesHead: the head those were read at, which a line comment goes with. */
export type PrView = PrData & Omit<PrChanges, 'head'> & { changesHead?: string };

// Stable empties: a new array on every render would read as a new diff to the file nav
const NO_FILES: FileDiff[] = [];
const NO_THREADS: PrThread[] = [];

/** The page's PR (#497): before …/changes answers, no files and no threads, and the model's review requests without their times. */
export function prViewOf(pr: PrData, changes: PrChanges | undefined): PrView {
  if (changes === undefined) return { ...pr, files: NO_FILES, threads: NO_THREADS, truncated: false };
  const { head, ...rest } = changes;
  return { ...pr, ...rest, changesHead: head };
}
