// The blockers route's refusal codes (#56) as their copy, for every place that edits a relation: the details panel (#57) and the Project's
// blocked-by cell (#61). Anything else reads as unexpected, so a raw message never reaches the screen; the route already logs it to hive.log
import { type MessageKey, t } from '../i18n.js';

const CODES: readonly MessageKey[] = [
  'blockers.unknownItem', 'blockers.unknownRef', 'blockers.crossSource', 'blockers.self', 'blockers.cycle', 'blockers.refused', 'blockers.badRequest',
];

/** A failed blockers edit as its `blockers.*` copy; parseJson puts the route's code on the error. */
export function blockerErrorText(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  return t(CODES.find((c) => c === code) ?? 'blockers.unexpected');
}
