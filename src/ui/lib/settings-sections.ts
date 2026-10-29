// The Settings page's sections (#510): their order, which one owns each draft field and what is unsaved. Pure, so node:test
// checks it; the page, the footer and settings-form's problems all read it.
import type { LanguageId } from '../../types.js';
import type { SettingsDraft } from './settings-form.js';

export const SETTINGS_SECTIONS = ['workspaces', 'flow', 'execution', 'rules', 'app', 'editor', 'shortcuts', 'maintenance'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/** Maintenance's actions run at once (#181): no draft field lives there. */
export type FormSection = Exclude<SettingsSection, 'maintenance'>;
/** Where the page is (#514): a section, and inside flow optionally one source's detail, by row id; language (#780): editor opens on it. */
/** `stage` is a stage's draft row id (#689). */
export interface SettingsView { section: SettingsSection; source?: string; language?: LanguageId; stage?: string }

// A Record over every draft key: a new SettingsDraft field fails tsc until it is given a section.
export const SECTION_OF: Record<keyof SettingsDraft, FormSection> = {
  workspaces: 'workspaces', commands: 'workspaces',
  prefix: 'flow', hiveSource: 'flow', createIn: 'flow', sources: 'flow', auth: 'flow', stages: 'flow', transitions: 'flow',
  defaultAgent: 'execution', agentArgs: 'execution', agentModels: 'execution', agentEnabled: 'execution',branch: 'execution', baseBranch: 'execution', approvalMinutes: 'execution', rateLimitWaitMinutes: 'execution', shutdownIdleMinutes: 'execution', deleteActivity: 'execution',
  closeSessionTab: 'execution', closeStageTab: 'execution', closeSessionTabNotice: 'execution', closeStageTabNotice: 'execution', // #614
  closeTerminalTab: 'execution', closeTerminalTabNotice: 'execution', // #696
  sleepNotice: 'execution', sleepAutoNotice: 'execution', sleepIdleNotice: 'execution', sleepAllNotice: 'execution', // #672
  budgetHour: 'rules', budgetDay: 'rules', rules: 'rules', showGithubQuota: 'rules', signals: 'rules',
  language: 'app', theme: 'app', fileIcons: 'app', sidebarsPerView: 'app', terminalFont: 'app', trustedDomains: 'app', consoleLines: 'app', onClose: 'app', notifications: 'app',
  editor: 'editor', // #780
  shortcuts: 'shortcuts',
};

const DRAFT_KEYS = Object.keys(SECTION_OF) as (keyof SettingsDraft)[];

/** The draft keys whose value differs from the saved draft. Row ids are generated once per draft and kept, so they compare equal. */
export const unsavedKeys = (saved: SettingsDraft, draft: SettingsDraft): (keyof SettingsDraft)[] =>
  DRAFT_KEYS.filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key]));

/** The sections those keys belong to, each once, in nav order. */
export const unsavedSections = (keys: readonly (keyof SettingsDraft)[]): FormSection[] =>
  SETTINGS_SECTIONS.filter((s): s is FormSection => keys.some((key) => SECTION_OF[key] === s));

export const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
