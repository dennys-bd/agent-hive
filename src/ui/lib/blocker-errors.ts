// The blockers route's refusal codes (#56) as their copy, for every place that edits a relation: the details panel (#57) and the Project's
// blocked-by cell (#61). Anything else reads as unexpected, so a raw message never reaches the screen; the route already logs it to hive.log
import type { RefGrammar } from '../../blocker-refs.js';
import { type MessageKey, t } from '../i18n.js';

const CODES: readonly MessageKey[] = [
  'blockers.unknownItem', 'blockers.unknownRef', 'blockers.crossSource', 'blockers.self', 'blockers.cycle', 'blockers.refused', 'blockers.badRequest',
];

/** A failed blockers edit as its `blockers.*` copy; parseJson puts the route's code on the error. A bad request names the item's own forms
 * (#810), so `grammar` is the item's source type's, absent on a hive task, which reads only a task id. */
export function blockerErrorText(err: unknown, grammar: RefGrammar | undefined): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  if (code === 'blockers.badRequest') return grammar === undefined ? t('blockers.badRefHive') : t('blockers.badRequest', { forms: grammar.forms });
  return t(CODES.find((c) => c === code) ?? 'blockers.unexpected');
}

/** #810 decision 11: what ↵ with nothing to add says under the field: the item's source type's forms, or a task id alone on a hive task. */
export const badRefText = (grammar: RefGrammar | undefined): string =>
  (grammar === undefined ? t('blockers.badRefHive') : t('blockers.badRef', { forms: grammar.forms }));
