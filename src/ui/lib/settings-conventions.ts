import { CONVENTION_KEYS, type ConventionKey, conventionValue } from '../../conventions.js';
import { type Conventions, DELIVERIES, FEATURE_FLAGS, type Workspace } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import type { SettingsProblem, WorkspaceDraft } from './settings-form.js';

// Settings › workspaces' conventions card (#692), out of settings-form.ts, as settings-commands.ts is.

/** A row of a workspace's conventions card (#692): id is its React key, never sent. value holds the text or the select's pick; min and max only
 * the slice size. */
export interface ConventionRowDraft { id: string; key: ConventionKey; value: string; min: string; max: string }
/** One option of an enumerated convention and its label's key. */
export interface Choice { value: string; label: MessageKey }

/** The enumerated conventions (#692): their select's options, in the parser's order. */
export const CHOICES: Partial<Record<ConventionKey, readonly Choice[]>> = {
  delivery: DELIVERIES.map((value) => ({ value, label: `settings.conventions.delivery.${value}` as const })),
  featureFlags: FEATURE_FLAGS.map((value) => ({ value, label: `settings.conventions.featureFlags.${value}` as const })),
};

/** A row for `key` (#692): an enumeration on its first option, anything else empty. `id` kept when a row changes its key. */
export const rowFor = (key: ConventionKey, id: string = crypto.randomUUID()): ConventionRowDraft => ({ id, key, value: CHOICES[key]?.[0]?.value ?? '', min: '', max: '' });

/** The keys a row may take (#692): its own and the ones no row uses, in CONVENTION_KEYS order. */
export const unusedKeys = (rows: ConventionRowDraft[], own?: ConventionKey): ConventionKey[] =>
  CONVENTION_KEYS.filter((key) => key === own || !rows.some((r) => r.key === key));

/** The saved conventions as rows, in CONVENTION_KEYS order (#692). */
export function conventionRows(conventions: Conventions | undefined): ConventionRowDraft[] {
  return CONVENTION_KEYS.flatMap((key) => {
    const value = conventions?.[key];
    if (value === undefined) return [];
    return [typeof value === 'object' ? { ...rowFor(key), min: String(value.min), max: String(value.max) } : { ...rowFor(key), value }];
  });
}

// A row with no value is a + never filled: dropped, never an error (#692)
const isBlank = (r: ConventionRowDraft): boolean => (r.key === 'sliceSize' ? r.min.trim() === '' && r.max.trim() === '' : r.value.trim() === '');
// What the parser would read: the slice size as two numbers ('' reads 0 and fails its bound), anything else as typed
const rawValue = (r: ConventionRowDraft): unknown => (r.key === 'sliceSize' ? { min: Number(r.min), max: Number(r.max) } : r.value);

/** A card's rows as the config's object (#692): blank rows dropped, values as the parser keeps them; no key when none is left. validateSettings
 * ran first. */
export function conventionsFrom(rows: ConventionRowDraft[]): Pick<Workspace, 'conventions'> {
  const entries = rows.filter((r) => !isBlank(r)).map((r) => [r.key, conventionValue(r.key, rawValue(r))] as const);
  return entries.length === 0 ? {} : { conventions: Object.fromEntries(entries) as Conventions };
}

// Each key's message, the parser's own words with the workspace in front (#692)
const PROBLEMS: Record<ConventionKey, MessageKey> = {
  docsRepo: 'settings.error.conventions.docsRepo', specsDir: 'settings.error.conventions.dir', plansDir: 'settings.error.conventions.dir',
  walkthroughsDir: 'settings.error.conventions.dir', designsDir: 'settings.error.conventions.dir', docsLanguage: 'settings.error.conventions.language', chatLanguage: 'settings.error.conventions.language',
  delivery: 'settings.error.conventions.delivery', sliceSize: 'settings.error.conventions.sliceSize', featureFlags: 'settings.error.conventions.featureFlags',
  uiCheck: 'settings.error.conventions.uiCheck', testCommand: 'settings.error.conventions.testCommand',
  decompositionLabel: 'settings.error.conventions.decompositionLabel',
};

/** The first conventions row the parser would refuse (#692), named as its message names it, on workspaces. */
export function conventionsProblem(workspaces: WorkspaceDraft[]): SettingsProblem | undefined {
  for (const w of workspaces) {
    const bad = w.conventions.find((r) => !isBlank(r) && conventionValue(r.key, rawValue(r)) === undefined);
    if (bad) return { section: 'workspaces', message: t(PROBLEMS[bad.key], { workspace: w.name.trim(), key: bad.key }) };
  }
  return undefined;
}
