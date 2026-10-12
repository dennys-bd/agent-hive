// The Settings page's sections (#510): their order, which one owns each draft field, what is unsaved, and the nav search. Pure, so node:test
// checks it; the page, the footer and settings-form's problems all read it.
import { formattersOf } from '../../formatters.js';
import { LANGUAGES } from '../../languages.js';
import { SHORTCUTS } from '../../shortcut-registry.js';
import { type MessageKey, t } from '../i18n.js';
import type { LanguageId } from '../../types.js';
import type { SettingsDraft } from './settings-form.js';

export const SETTINGS_SECTIONS = ['workspaces', 'flow', 'execution', 'rules', 'app', 'editor', 'shortcuts', 'maintenance'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/** Maintenance's actions run at once (#181): no draft field lives there. */
export type FormSection = Exclude<SettingsSection, 'maintenance'>;
/** Where the page is (#514): a section, and inside flow optionally one source's detail, by row id; language (#780): editor opens on it. */
export interface SettingsView { section: SettingsSection; source?: string; language?: LanguageId }

// A Record over every draft key: a new SettingsDraft field fails tsc until it is given a section.
export const SECTION_OF: Record<keyof SettingsDraft, FormSection> = {
  workspaces: 'workspaces', commands: 'workspaces',
  prefix: 'flow', hiveSource: 'flow', createIn: 'flow', sources: 'flow', auth: 'flow', stages: 'flow', transitions: 'flow',
  defaultAgent: 'execution', agentArgs: 'execution', branch: 'execution', baseBranch: 'execution', approvalMinutes: 'execution', rateLimitWaitMinutes: 'execution', shutdownIdleMinutes: 'execution', deleteActivity: 'execution',
  closeSessionTab: 'execution', closeStageTab: 'execution', closeSessionTabNotice: 'execution', closeStageTabNotice: 'execution', // #614
  closeTerminalTab: 'execution', closeTerminalTabNotice: 'execution', // #696
  sleepNotice: 'execution', sleepAutoNotice: 'execution', sleepIdleNotice: 'execution', sleepAllNotice: 'execution', // #672
  budgetHour: 'rules', budgetDay: 'rules', rules: 'rules', showGithubQuota: 'rules', signals: 'rules',
  language: 'app', theme: 'app', fileIcons: 'app', sidebarsPerView: 'app', terminalFont: 'app', trustedDomains: 'app', consoleLines: 'app', onClose: 'app', notifications: 'app',
  editor: 'editor', // #780
  shortcuts: 'shortcuts',
};

// Field labels the search also matches, besides the section's own label and hint.
const KEYWORDS: Record<SettingsSection, readonly MessageKey[]> = {
  workspaces: ['settings.workspaces', 'settings.workspaces.setup', 'settings.workspaces.teardown', 'settings.workspaces.stepTimeout', 'settings.env.group', 'settings.group.commands', 'settings.commands.col.impls', 'settings.commands.col.menu'
],
  flow: ['settings.sources.local', 'settings.prefix', 'settings.connections', 'settings.sources', 'settings.stages'],
  execution: ['settings.defaultAgent', 'settings.branch', 'settings.baseBranch', 'settings.approvalMinutes', 'settings.rateLimitWait', 'settings.shutdownIdle', 'settings.deleteActivity', 'settings.closeSessionTab', 'settings.closeStageTab', 'settings.closeTerminalTab', 'settings.closeTabNotice', 'settings.sleepNotice', 'settings.sleepAutoNotice', 'settings.sleepIdleNotice', 'settings.sleepAllNotice'],
  rules: ['settings.budgetHour', 'settings.budgetDay', 'settings.showGithubQuota', 'settings.group.budget', 'settings.group.rules', 'settings.group.github', 'settings.rules.measure', 'settings.signal.title'],
  app: ['settings.language', 'settings.theme', 'settings.fileIcons', 'settings.sidebarsPerView', 'settings.terminalFont', 'settings.trustedDomains', 'settings.consoleLines', 'settings.onClose', 'settings.notifications'],
  editor: ['settings.format.onSave', 'settings.languages', 'settings.syntax', 'settings.server', 'settings.formatters'],
  shortcuts: SHORTCUTS.map((s) => s.label),
  maintenance: ['settings.group.orphans', 'worktrees.cleanOrphans'],
};

const DRAFT_KEYS = Object.keys(SECTION_OF) as (keyof SettingsDraft)[];

/** The draft keys whose value differs from the saved draft. Row ids are generated once per draft and kept, so they compare equal. */
export const unsavedKeys = (saved: SettingsDraft, draft: SettingsDraft): (keyof SettingsDraft)[] =>
  DRAFT_KEYS.filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key]));

/** The sections those keys belong to, each once, in nav order. */
export const unsavedSections = (keys: readonly (keyof SettingsDraft)[]): FormSection[] =>
  SETTINGS_SECTIONS.filter((s): s is FormSection => keys.some((key) => SECTION_OF[key] === s));

const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** The offered sections whose label, hint or a field label holds the query; all of them for an empty query. */
export function matchingSections(query: string, offered: readonly SettingsSection[]): SettingsSection[] {
  const q = fold(query.trim());
  if (q === '') return [...offered];
  return offered.filter((s) => [`settings.section.${s}` as const, `settings.section.${s}.hint` as const, ...KEYWORDS[s]].some((key) => fold(t(key)).includes(q)));
}

/** A Settings search result inside editor (#780): what it names, the path to it, and the language it selects. */
export interface EditorEntry { language: LanguageId; text: string; path: string }

/** The languages, servers and formatters the query matches (#780), in the catalog's order: prettier once per language it serves. */
export function editorEntries(query: string): EditorEntry[] {
  const q = fold(query.trim());
  if (q === '') return [];
  return LANGUAGES.flatMap((def) => {
    const name = t(`editor.language.${def.id}`);
    const server = def.server === undefined ? [] : [{ language: def.id, text: def.server, path: t('settings.search.editor.server', { language: name }) }];
    const formatters = formattersOf(def.id).map((id) => ({ language: def.id, text: id, path: t('settings.search.editor.formatter', { language: name }) }));
    return [{ language: def.id, text: name, path: t('settings.search.editor.languages') }, ...server, ...formatters].filter((entry) => fold(entry.text).includes(q));
  });
}
