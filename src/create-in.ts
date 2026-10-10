// The four rules of comb.createIn (#846), shared by the parser (config.ts, which words them for the file) and the settings form (which shows
// them through t()), the way branchProblem is shared.
import { HIVE_SOURCE } from './tasks.js';

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
