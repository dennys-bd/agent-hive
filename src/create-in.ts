// The four rules of comb.createIn (#846), shared by the parser (config.ts, which words them for the file) and the settings form (which shows
// them through t()), the way branchProblem is shared.
import { HIVE_SOURCE } from './tasks.js';
import type { SourceFields } from './types.js';

/** What the predicate reads of a source (#811): its type and, for GitHub, the repository new issues go to. */
export interface CreateCandidate { type: SourceFields['type']; repository?: string }
export type CanCreate = (source: CreateCandidate) => boolean;

/** Whether a source can take new tasks (#811): one case per type, so the parser, the form, the create and the UI ask the same question.
 * No default: a new SourceFields member fails to compile here until it says how it creates. */
export function canCreate(source: CreateCandidate): boolean {
  switch (source.type) {
    case 'github': return source.repository !== undefined;
    case 'jira': return false; // #820: node 6 adds create
  }
}

export type CreateInProblem =
  | 'settings.error.hiveSource.noSource' | 'settings.error.createIn.hiveOff' | 'settings.error.createIn.unknown' | 'settings.error.createIn.cannotCreate';

export interface CreateInFields { hiveSource: boolean; createIn: string; sources: readonly (CreateCandidate & { name: string })[] }

/** The first rule `fields` break, or undefined: hive off needs a source; createIn is hive while it is on, or a source canCreate accepts (#811). */
export function createInProblem({ hiveSource, createIn, sources }: CreateInFields, can: CanCreate = canCreate): CreateInProblem | undefined {
  if (!hiveSource && sources.length === 0) return 'settings.error.hiveSource.noSource';
  if (createIn === HIVE_SOURCE) return hiveSource ? undefined : 'settings.error.createIn.hiveOff';
  const source = sources.find((s) => s.name === createIn);
  if (source === undefined) return 'settings.error.createIn.unknown';
  return can(source) ? undefined : 'settings.error.createIn.cannotCreate';
}

/** Which types have issue types (#831): a Record, as NO_CREATE_REASON is, so a new type has to say. GitHub's org issue types are a field of
 * the fields panel (#686), not a create input. */
const HAS_ISSUE_TYPES: Record<SourceFields['type'], boolean> = { github: false, jira: true };
/** Whether a create may name an issue type and a parent; false for a type the Record lacks (a test's cast type). */
export const hasIssueTypes = (type: string): boolean => Object.hasOwn(HAS_ISSUE_TYPES, type) && HAS_ISSUE_TYPES[type as SourceFields['type']];

const SOURCE_TYPE_NAMES: Record<SourceFields['type'], string> = { github: 'GitHub', jira: 'Jira' };
/** A type's name in a hive.log line (#831); "the source" for no type or one the Record lacks. */
export const sourceTypeName = (type: string | undefined): string =>
  (type !== undefined && Object.hasOwn(SOURCE_TYPE_NAMES, type) ? SOURCE_TYPE_NAMES[type as SourceFields['type']] : 'the source');
