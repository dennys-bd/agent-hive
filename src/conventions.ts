import { DELIVERIES, FEATURE_FLAGS, type Conventions } from './types.js';

// The plugin's conventions (#692): the keys and their rules, shared by parseConfig and the Settings form, which mirrors the parser's messages.
// No node import: the form bundles it.

export const CONVENTION_KEYS = [
  'docsRepo', 'specsDir', 'plansDir', 'walkthroughsDir', 'docsLanguage', 'chatLanguage', 'delivery', 'sliceSize', 'featureFlags', 'uiCheck', 'testCommand',
] as const satisfies readonly (keyof Conventions)[];
export type ConventionKey = (typeof CONVENTION_KEYS)[number];

export const SLICE_SIZE_MIN = 50;
export const SLICE_SIZE_MAX = 5000;
const LANGUAGE_MAX = 40;
const UI_CHECK_MAX = 2000;
const TEST_COMMAND_MAX = 500;
const DOCS_DIR = 'must be a relative path inside the docs repository';
const LANGUAGE = `must be a language name of 1 to ${LANGUAGE_MAX} characters`;

/** What follows `conventions.<key>` in the parser's message (#692). */
export const CONVENTION_RULES: Record<ConventionKey, string> = {
  docsRepo: 'must be a non-empty path', specsDir: DOCS_DIR, plansDir: DOCS_DIR, walkthroughsDir: DOCS_DIR, docsLanguage: LANGUAGE, chatLanguage: LANGUAGE,
  delivery: `must be one of ${DELIVERIES.join(', ')}`,
  sliceSize: `must be { min, max } with ${SLICE_SIZE_MIN} ≤ min ≤ max ≤ ${SLICE_SIZE_MAX}`,
  featureFlags: `must be one of ${FEATURE_FLAGS.join(', ')}`,
  uiCheck: `must be 1 to ${UI_CHECK_MAX} characters`,
  testCommand: `must be 1 to ${TEST_COMMAND_MAX} characters`,
};

export const isConventionKey = (key: string): key is ConventionKey => (CONVENTION_KEYS as readonly string[]).includes(key);

// Trimmed, 1 to `max` characters
function text(value: unknown, max = Number.POSITIVE_INFINITY): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : undefined;
}

// A docs folder never leaves the docs repository: relative, no `..` segment
function insideDocs(value: unknown): string | undefined {
  const path = text(value);
  return path === undefined || path.startsWith('/') || path.split('/').includes('..') ? undefined : path;
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(value as T) ? (value as T) : undefined);

// Whole numbers, SLICE_SIZE_MIN ≤ min ≤ max ≤ SLICE_SIZE_MAX; rebuilt, so a stray key never reaches the config
function sliceSize(value: unknown): Conventions['sliceSize'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const { min, max } = value as Record<string, unknown>;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return undefined;
  const [low, high] = [min as number, max as number];
  return SLICE_SIZE_MIN <= low && low <= high && high <= SLICE_SIZE_MAX ? { min: low, max: high } : undefined;
}

/** One convention as the config keeps it, trimmed; undefined when the key's rule refuses the value (#692). */
export function conventionValue(key: ConventionKey, value: unknown): Conventions[ConventionKey] {
  switch (key) {
    case 'docsRepo': return text(value);
    case 'specsDir': case 'plansDir': case 'walkthroughsDir': return insideDocs(value);
    case 'docsLanguage': case 'chatLanguage': return text(value, LANGUAGE_MAX);
    case 'delivery': return oneOf(value, DELIVERIES);
    case 'featureFlags': return oneOf(value, FEATURE_FLAGS);
    case 'sliceSize': return sliceSize(value);
    case 'uiCheck': return text(value, UI_CHECK_MAX);
    case 'testCommand': return text(value, TEST_COMMAND_MAX);
  }
}

/** A workspace's raw conventions (#692): the keys set, as conventionValue keeps them, or the first problem as `conventions.<key> <rule>`,
 * the tail of the parser's message. Absent reads as {}. */
export function parseConventions(raw: unknown): Conventions | string {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'conventions must be an object';
  const entries = Object.entries(raw);
  const stray = entries.find(([key]) => !isConventionKey(key));
  if (stray) return `conventions.${stray[0]} is not a convention (known: ${CONVENTION_KEYS.join(', ')})`;
  const kept = entries.map(([key, value]) => [key as ConventionKey, conventionValue(key as ConventionKey, value)] as const);
  const bad = kept.find(([, value]) => value === undefined);
  return bad ? `conventions.${bad[0]} ${CONVENTION_RULES[bad[0]]}` : (Object.fromEntries(kept) as Conventions);
}
