// The four rules of comb.createIn (#846), shared by the parser (config.ts, which words them for the file) and the settings form (which shows
// them through t()), the way branchProblem is shared.
import { HIVE_SOURCE } from './tasks.js';
import type { SourceFields } from './types.js';

export type CreateInProblem =
  | 'settings.error.hiveSource.noSource' | 'settings.error.createIn.hiveOff' | 'settings.error.createIn.unknown' | 'settings.error.createIn.noRepository';

export interface CreateInFields { hiveSource: boolean; createIn: string; sources: readonly { name: string; repository?: string }[] }

/** The first rule `fields` break, or undefined: hive off needs a source; createIn is hive while it is on, or a source with a repository. */
export function createInProblem({ hiveSource, createIn, sources }: CreateInFields): CreateInProblem | undefined {
  if (!hiveSource && sources.length === 0) return 'settings.error.hiveSource.noSource';
  if (createIn === HIVE_SOURCE) return hiveSource ? undefined : 'settings.error.createIn.hiveOff';
  const source = sources.find((s) => s.name === createIn);
  if (source === undefined) return 'settings.error.createIn.unknown';
  return source.repository === undefined ? 'settings.error.createIn.noRepository' : undefined;
}

/** What the predicate reads of a source (#811): its type and, for GitHub, the repository new issues go to. */
export interface CreateCandidate { type: SourceFields['type']; repository?: string }
export type CanCreate = (source: CreateCandidate) => boolean;

/** Whether a source can take new tasks (#811): one case per type, so the parser, the form, the create and the UI ask the same question.
 * No default: a new SourceFields member fails to compile here until it says how it creates. */
export function canCreate(source: CreateCandidate): boolean {
  switch (source.type) {
    case 'github': return source.repository !== undefined;
  }
}
