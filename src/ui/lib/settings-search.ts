// The Settings search (#689): an entry of the index, the anchor id an entry and its element share, and the ranked match over the Hive's
// language and English. Pure, so node:test checks it; each section's module declares its own entries.
import { type MessageKey, tIn } from '../i18n.js';
import type { Language } from '../../types.js';
import { fold, type SettingsSection, type SettingsView } from './settings-sections.js';

/** A text of the index: a message key (with its placeholders' values), or a name from data, the same in every language. */
export type SettingText = MessageKey | { key: MessageKey; vars: Record<string, string | number> } | { raw: string };
/** label: what the row shows; path: section › sub-topic; view: what a pick opens; anchor: the element it lands on; keys: synonyms. */
export interface SettingEntry { label: SettingText; path: readonly SettingText[]; view: SettingsView; anchor: string; keys?: MessageKey }
/** A result: its texts in the shown language, and the query's run in the label when the shown text matched. */
export interface SettingMatch { entry: SettingEntry; label: string; path: string; range?: readonly [number, number] }

export const MAX_RESULTS = 8;
const PATH_JOIN = ' › ';

export function textIn(text: SettingText, language: Language): string {
  if (typeof text === 'string') return tIn(language, text);
  return 'raw' in text ? text.raw : tIn(language, text.key, text.vars);
}

/** The element id for a setting (#689): the key with dots as dashes, plus the context's id (a workspace, source, stage or language row). */
export const settingAnchor = (key: MessageKey, context?: string): string =>
  `setting-${key.replaceAll('.', '-')}${context === undefined ? '' : `-${context}`}`;

/** A row named by the user, or its fallback while the name is empty. */
export const named = (name: string, fallback: SettingText): SettingText => (name.trim() === '' ? fallback : { raw: name.trim() });

/** A field or card with no context: its key names its anchor; `card` is the sub-topic its path shows. */
export const settingEntry = (label: MessageKey, section: SettingsSection, card?: MessageKey, keys?: MessageKey): SettingEntry => ({
  label, path: card === undefined ? [`settings.section.${section}`] : [`settings.section.${section}`, card], view: { section }, anchor: settingAnchor(label),
  ...(keys === undefined ? {} : { keys }),
});

/** A card and the fields under it. */
export const cardEntries = (section: SettingsSection, card: MessageKey, fields: readonly MessageKey[]): SettingEntry[] =>
  [settingEntry(card, section), ...fields.map((field) => settingEntry(field, section, card))];

/** The fields of one context, each anchor carrying the context's id. */
export const contextEntries = (labels: readonly MessageKey[], view: SettingsView, path: readonly SettingText[], context: string): SettingEntry[] =>
  labels.map((label) => ({ label, path, view, anchor: settingAnchor(label, context) }));

interface Hit { rank: number; at: number }

// 1: the text starts with the query; 2: a word of it does; 3: it holds it. ponytail: fold keeps one char per precomposed Latin letter,
// so an index in the folded text is the index in the shown one; a decomposed or case-expanding text would shift the highlight
function hitIn(text: string, q: string): Hit | undefined {
  const folded = fold(text);
  let inside: number | undefined;
  for (let at = folded.indexOf(q); at !== -1; at = folded.indexOf(q, at + 1)) {
    if (at === 0) return { rank: 1, at };
    if (!/[\p{L}\p{N}]/u.test(folded[at - 1])) return { rank: 2, at };
    inside ??= at;
  }
  return inside === undefined ? undefined : { rank: 3, at: inside };
}

const languagesOf = (language: Language): Language[] => (language === 'en' ? ['en'] : [language, 'en']);

function matchOf(entry: SettingEntry, q: string, language: Language): (SettingMatch & { rank: number }) | undefined {
  const label = textIn(entry.label, language);
  const path = entry.path.map((p) => textIn(p, language)).join(PATH_JOIN);
  const shown = hitIn(label, q);
  const english = language === 'en' ? undefined : hitIn(textIn(entry.label, 'en'), q);
  const rank = Math.min(shown?.rank ?? 4, english?.rank ?? 4);
  const range = shown && ([shown.at, shown.at + q.length] as const);
  if (rank < 4) return { entry, label, path, range, rank };
  const elsewhere = languagesOf(language).flatMap((l) => [entry.path.map((p) => textIn(p, l)).join(PATH_JOIN), entry.keys === undefined ? '' : tIn(l, entry.keys)]);
  return elsewhere.some((text) => fold(text).includes(q)) ? { entry, label, path, rank: 4 } : undefined;
}

/** The entries the query names, best first (#689): rank, then the shorter label, then index order; at most MAX_RESULTS. */
export function searchSettings(query: string, entries: readonly SettingEntry[], language: Language): SettingMatch[] {
  const q = fold(query.trim());
  if (q === '') return [];
  return entries
    .flatMap((entry, index) => { const hit = matchOf(entry, q, language); return hit === undefined ? [] : [{ ...hit, index }]; })
    .sort((a, b) => a.rank - b.rank || a.label.length - b.label.length || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map(({ entry, label, path, range }) => ({ entry, label, path, ...(range === undefined ? {} : { range }) }));
}
