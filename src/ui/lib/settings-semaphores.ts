// Settings › rules' Command Semaphores (#803): the card's rows as typed, their save and their first problem, out of settings-form.ts, which is
// near 400 lines. A command line points at a row by its id (settings-commands.ts), so a rename or an unsaved row needs no special case.
import { SEMAPHORE_NAME } from '../../run-commands.js';
import { timeoutMs } from '../../timeout.js';
import type { CommandSemaphore } from '../../types.js';
import { t } from '../i18n.js';
import type { CommandDraft, ImplDraft } from './settings-commands.js';
import type { SettingsProblem } from './settings-form.js';

/** A row of the card (#803): texts as typed. id is what a line's semaphore holds and the React key, never sent; savedName is the name it was
 * loaded with, absent on a new row: what the now column reads State by until the save. */
export interface SemaphoreDraft { id: string; savedName?: string; name: string; limit: string; reservation: string }
/** The fields of a row the parser would refuse: the card marks them aria-invalid. */
export interface SemaphoreFaults { name: boolean; limit: boolean; reservation: boolean }

// decision 6: the smallest valid limit and the design's shortest reservation; the empty name is refused until typed
const NEW_LIMIT = '1';
const NEW_RESERVATION = '1m';

export const emptySemaphore = (): SemaphoreDraft => ({ id: crypto.randomUUID(), name: '', limit: NEW_LIMIT, reservation: NEW_RESERVATION });

export const semaphoreDrafts = (saved: readonly CommandSemaphore[]): SemaphoreDraft[] =>
  saved.map((s) => ({ ...emptySemaphore(), savedName: s.name, name: s.name, limit: String(s.limit), reservation: s.reservation }));

// validateSettings ran first, so every limit is a whole number
export const semaphoresFrom = (drafts: readonly SemaphoreDraft[]): CommandSemaphore[] =>
  drafts.map((d) => ({ name: d.name.trim(), limit: Number(d.limit.trim()), reservation: d.reservation.trim() }));

// The parser's rules (parseSemaphore in run-commands.ts): one word, an integer of 1 or more, a TIMEOUT text
const isName = (text: string): boolean => SEMAPHORE_NAME.test(text.trim());
const isLimit = (text: string): boolean => /^\d+$/.test(text.trim()) && Number(text.trim()) >= 1;
const isReservation = (text: string): boolean => timeoutMs(text) !== undefined;

export function semaphoreFaults(drafts: readonly SemaphoreDraft[], row: SemaphoreDraft): SemaphoreFaults {
  const isTwice = drafts.some((d) => d.id !== row.id && d.name.trim() === row.name.trim());
  return { name: !isName(row.name) || isTwice, limit: !isLimit(row.limit), reservation: !isReservation(row.reservation) };
}

// Names first (by row number while one may be empty), then the duplicates, then the limits and reservations by the now valid name
function semaphoreMessage(drafts: readonly SemaphoreDraft[]): string | undefined {
  const badName = drafts.findIndex((d) => !isName(d.name));
  if (badName !== -1) return t('settings.error.semaphoreName', { n: badName + 1 });
  const names = drafts.map((d) => d.name.trim());
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) return t('settings.error.semaphoreDuplicate', { name: twice });
  const badLimit = drafts.find((d) => !isLimit(d.limit));
  if (badLimit !== undefined) return t('settings.error.semaphoreLimit', { name: badLimit.name.trim() });
  const badReservation = drafts.find((d) => !isReservation(d.reservation));
  return badReservation === undefined ? undefined : t('settings.error.semaphoreReservation', { name: badReservation.name.trim() });
}

/** The card's first problem (decision 5), on rules as every other form problem. */
export function semaphoresProblem(drafts: readonly SemaphoreDraft[]): SettingsProblem | undefined {
  const message = semaphoreMessage(drafts);
  return message === undefined ? undefined : { section: 'rules', message };
}

const lineWithout = ({ semaphore: _semaphore, ...line }: ImplDraft): ImplDraft => line;

/** The commands with the row's id cleared from every line (decision 4): removing a row needs no confirmation, the save is it. */
export const withoutSemaphore = (commands: readonly CommandDraft[], id: string): CommandDraft[] =>
  commands.map((c) => ({ ...c, impls: c.impls.map((i) => (i.semaphore === id ? lineWithout(i) : i)) }));
