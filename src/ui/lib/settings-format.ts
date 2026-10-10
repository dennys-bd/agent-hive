import { checkersOf } from '../../checkers.js';
import { formattersOf, isCustomName, isExtension, normalizeExtension } from '../../formatters.js';
import { languageDef } from '../../languages.js';
import {
  type CheckerId, type CustomFormatter, EDITOR_DEFAULTS, type EditorConfig, type FormatterId, LANGUAGE_IDS, type LanguageConfig, type LanguageFormatter, type LanguageId,
  type WorkspaceScope,
} from '../../types.js';
import { t } from '../i18n.js';
import type { SettingsDraft, SettingsProblem } from './settings-form.js';

// The editor config as Settings › editor edits it (#780), out of settings-form.ts as settings-conventions.ts is: the draft key `editor`.

/** A supported formatter's setting in one language as edited (#780): args one per line, as typed. */
export interface FormatterDraft { enabled: boolean; args: string; workspaces: WorkspaceScope }
/** A custom formatter's row (#780): id is its React key, never sent; extensions comma separated, as typed. */
export interface CustomFormatterDraft { id: string; name: string; command: string; extensions: string; workspaces: WorkspaceScope }
/** A checker's setting in one language as edited (#782): a formatter's draft. */
export type CheckerDraft = FormatterDraft;
/** One language as edited (#780): its server's scope, its supported formatters' settings, its custom formatters, its checkers' settings (#782). */
export interface LanguageDraft { server: WorkspaceScope; formatters: Partial<Record<FormatterId, FormatterDraft>>; custom: CustomFormatterDraft[]; checkers: Partial<Record<CheckerId, CheckerDraft>> }
export interface EditorDraft { formatOnSave: { enabled: boolean; workspaces: WorkspaceScope }; languages: Partial<Record<LanguageId, LanguageDraft>> }

/** A supported formatter with no entry (#780): on, no args, every workspace. */
export const DEFAULT_FORMATTER_DRAFT: FormatterDraft = { enabled: true, args: '', workspaces: 'all' };
export const emptyLanguageDraft = (): LanguageDraft => ({ server: 'all', formatters: {}, custom: [], checkers: {} });
/** A new custom row (#780): the language's extensions already in, every workspace. */
export const emptyCustomFormatter = (extensions: readonly string[] = []): CustomFormatterDraft =>
  ({ id: crypto.randomUUID(), name: '', command: '', extensions: extensions.join(', '), workspaces: 'all' });

const formatterDraft = (f: LanguageFormatter): FormatterDraft => ({ enabled: f.enabled, args: f.args.join('\n'), workspaces: f.workspaces });
const customDraft = (c: CustomFormatter): CustomFormatterDraft =>
  ({ ...emptyCustomFormatter(), name: c.name, command: c.command, extensions: c.extensions.join(', '), workspaces: c.workspaces });
const draftsOf = (settings: Partial<Record<string, LanguageFormatter>> | undefined): Record<string, FormatterDraft> =>
  Object.fromEntries(Object.entries(settings ?? {}).flatMap(([id, f]) => (f ? [[id, formatterDraft(f)]] : [])));
const languageDraft = (config: LanguageConfig): LanguageDraft => ({
  server: config.server?.workspaces ?? 'all',
  formatters: draftsOf(config.formatters),
  custom: (config.custom ?? []).map(customDraft),
  checkers: draftsOf(config.checkers),
});

/** The saved editor config as Settings › editor edits it (#780); none reads as EDITOR_DEFAULTS. */
export const editorDraft = (editor: EditorConfig = EDITOR_DEFAULTS): EditorDraft => ({
  formatOnSave: { ...editor.formatOnSave },
  languages: Object.fromEntries(Object.entries(editor.languages).flatMap(([id, c]) => (c ? [[id, languageDraft(c)]] : []))),
});

/** Extra args as the config keeps them (#780, #782): one per line, trimmed, blanks dropped. */
export const argLines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
/** A custom row's extensions as the config keeps them (#749): split on commas, trimmed, lowercased, blanks dropped. */
export const extensionsOf = (text: string): string[] => text.split(',').map(normalizeExtension).filter((e) => e !== '');

// A formatter back on its default is left out: the config keeps only what the user changed
function formatterFrom(draft: FormatterDraft | undefined): LanguageFormatter | undefined {
  if (draft === undefined) return undefined;
  const args = argLines(draft.args);
  return draft.enabled && args.length === 0 && draft.workspaces === 'all' ? undefined : { enabled: draft.enabled, args, workspaces: draft.workspaces };
}

// The settings of `ids` that differ from the default, a formatter's or a checker's (#780, #782)
const keptOf = <T extends string>(ids: readonly T[], drafts: Partial<Record<T, FormatterDraft>>): Partial<Record<T, LanguageFormatter>> =>
  Object.fromEntries(ids.flatMap((id) => { const kept = formatterFrom(drafts[id]); return kept ? [[id, kept]] : []; })) as Partial<Record<T, LanguageFormatter>>;

function languageFrom(id: LanguageId, draft: LanguageDraft): LanguageConfig {
  const formatters = keptOf(formattersOf(id), draft.formatters);
  const checkers = keptOf(checkersOf(id).map((c) => c.id), draft.checkers);
  const custom = draft.custom.map((c) => ({ name: c.name.trim(), command: c.command.trim(), extensions: extensionsOf(c.extensions), workspaces: c.workspaces }));
  const hasServer = languageDef(id).server !== undefined && draft.server !== 'all';
  return {
    ...(hasServer ? { server: { workspaces: draft.server } } : {}), ...(Object.keys(formatters).length === 0 ? {} : { formatters }),
    ...(custom.length === 0 ? {} : { custom }), ...(Object.keys(checkers).length === 0 ? {} : { checkers }),
  };
}

/** The draft as the editor config (#780): a language left on every default is not written. validateSettings ran first. */
export function editorFrom(draft: EditorDraft): EditorConfig {
  const languages = Object.fromEntries(LANGUAGE_IDS.flatMap((id) => {
    const language = draft.languages[id];
    const config = language === undefined ? {} : languageFrom(id, language);
    return Object.keys(config).length === 0 ? [] : [[id, config]];
  }));
  return { formatOnSave: { ...draft.formatOnSave }, languages };
}

const where = (language: LanguageId, item: string): string => `${t(`editor.language.${language}`)} · ${item}`;

// A scope naming a workspace the form no longer has: the parser would refuse it
function scopeProblem(scope: WorkspaceScope, names: readonly string[], at: string): string | undefined {
  const gone = scope === 'all' ? undefined : scope.find((name) => !names.includes(name));
  return gone === undefined ? undefined : t('settings.error.editor.scope', { where: at, name: gone });
}

// A language's first custom formatter the parser would refuse, in its order, named in the form's words
function customProblem(id: LanguageId, custom: CustomFormatterDraft[], names: readonly string[]): string | undefined {
  const language = t(`editor.language.${id}`);
  const trimmed = custom.map((c) => c.name.trim());
  for (const [i, row] of custom.entries()) {
    const n = i + 1;
    if (!isCustomName(trimmed[i])) return t('settings.error.format.name', { language, n });
    if (trimmed.indexOf(trimmed[i]) !== i) return t('settings.error.format.duplicate', { language, name: trimmed[i] });
    if (row.command.trim() === '') return t('settings.error.format.command', { language, n });
    const extensions = extensionsOf(row.extensions);
    if (extensions.length === 0 || !extensions.every(isExtension)) return t('settings.error.format.extensions', { language, n });
    const scope = scopeProblem(row.workspaces, names, where(id, trimmed[i]));
    if (scope !== undefined) return scope;
  }
  return undefined;
}

function languageProblem(id: LanguageId, draft: LanguageDraft | undefined, names: readonly string[]): string | undefined {
  if (draft === undefined) return undefined;
  const server = scopeProblem(draft.server, names, where(id, languageDef(id).server ?? ''));
  const settings = [...Object.entries(draft.formatters), ...Object.entries(draft.checkers)];
  const setting = settings.map(([name, s]) => (s ? scopeProblem(s.workspaces, names, where(id, name)) : undefined)).find((m) => m !== undefined);
  return server ?? setting ?? customProblem(id, draft.custom, names);
}

/** The first problem of the editor draft the parser would refuse (#780), on editor. */
export function editorProblem(draft: Pick<SettingsDraft, 'workspaces' | 'editor'>): SettingsProblem | undefined {
  const names = draft.workspaces.map((w) => w.name.trim());
  const message = scopeProblem(draft.editor.formatOnSave.workspaces, names, t('settings.format.onSave'))
    ?? LANGUAGE_IDS.map((id) => languageProblem(id, draft.editor.languages[id], names)).find((m) => m !== undefined);
  return message === undefined ? undefined : { section: 'editor', message };
}
