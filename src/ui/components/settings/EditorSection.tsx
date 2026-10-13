import { LanguageDetail } from '@/components/settings/LanguageDetail';
import { LanguageList } from '@/components/settings/LanguageList';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { WorkspaceScopePicker } from '@/components/settings/WorkspaceScopePicker';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useEditorInstalls } from '@/hooks/use-editor-installs';
import { useCheckerStates, useFormatterStates } from '@/hooks/use-formatter-states';
import { t } from '@/i18n';
import { type EditorDraft, emptyLanguageDraft, type LanguageDraft } from '@/lib/settings-format';
import type { SettingsDraft } from '@/lib/settings-form';
import { contextEntries, type SettingEntry, type SettingText, settingAnchor, settingEntry } from '@/lib/settings-search';
import { formattersOf } from '../../../formatters';
import { LANGUAGES, type LanguageDef, languageDef } from '../../../languages';
import type { LanguageId } from '../../../types';

interface EditorSectionProps { draft: SettingsDraft; language?: LanguageId; onLanguage(language: LanguageId): void; onChange(patch: Partial<SettingsDraft>): void }
interface FormatOnSaveProps { names: readonly string[]; value: EditorDraft['formatOnSave']; onChange(value: EditorDraft['formatOnSave']): void }

// formatar ao salvar (#780): one switch for the Hive
function FormatOnSaveCard({ names, value, onChange }: FormatOnSaveProps) {
  return (
    <section id={settingAnchor('settings.format.onSave')} aria-label={t('settings.format.onSave')} className="grid grid-cols-[auto_minmax(0,1fr)_20rem] items-center gap-4 rounded-xl border bg-card px-5 py-4 shadow-sm">
      <Switch id="format-on-save" aria-label={t('settings.format.onSave')} checked={value.enabled} onCheckedChange={(enabled) => onChange({ ...value, enabled })} />
      <div className="flex flex-col gap-1">
        <Label htmlFor="format-on-save">{t('settings.format.onSave')}</Label>
        <span className="text-muted-foreground text-xs">{t('settings.format.onSaveHint')}</span>
      </div>
      <WorkspaceScopePicker label={t('settings.scope.of', { item: t('settings.format.onSave') })} scope={value.workspaces} names={names} onChange={(workspaces) => onChange({ ...value, workspaces })} />
    </section>
  );
}

/** Settings › editor (#780): the format on save card and the languages card, drafted under the `editor` key. Install actions act at once;
 * the switches, chips, args and custom formatters wait for the footer. */
export function EditorSection({ draft, language = LANGUAGES[0].id, onLanguage, onChange }: EditorSectionProps) {
  const { installs, act } = useEditorInstalls();
  const states = useFormatterStates();
  const checkerStates = useCheckerStates();
  const names = draft.workspaces.map((w) => w.name.trim()).filter((name) => name !== '');
  const setLanguageDraft = (next: LanguageDraft): void => onChange({ editor: { ...draft.editor, languages: { ...draft.editor.languages, [language]: next } } });
  return (
    <>
      <FormatOnSaveCard value={draft.editor.formatOnSave} names={names} onChange={(formatOnSave) => onChange({ editor: { ...draft.editor, formatOnSave } })} />
      <SettingsGroup title="settings.languages" hint="settings.languages.hint" flush>
        <div className="grid min-h-[600px] grid-cols-[18rem_minmax(0,1fr)]">
          <LanguageList selected={language} installs={installs} states={states} onSelect={onLanguage} />
          <LanguageDetail key={language} language={languageDef(language)} draft={draft.editor.languages[language] ?? emptyLanguageDraft()} names={names} installs={installs} states={states} checkerStates={checkerStates} onAct={act} onChange={setLanguageDraft} />
        </div>
      </SettingsGroup>
    </>
  );
}

// A language's entries (#689): it lands on its detail (Note 11), then its cards, its server and each supported formatter by name.
function languageEntries(def: LanguageDef): SettingEntry[] {
  const view = { section: 'editor', language: def.id } as const;
  const name = `editor.language.${def.id}` as const;
  const path: readonly SettingText[] = ['settings.section.editor', name];
  const cards = [
    ...(def.syntax === undefined ? [] : (['settings.syntax'] as const)),
    ...(def.id === 'other' ? [] : (['settings.server'] as const)),
    'settings.formatters', 'settings.checkers',
  ] as const;
  const serverEntry: SettingEntry[] = def.id !== 'other' && def.server !== undefined
    ? [{ label: { raw: def.server }, path: [...path, 'settings.server'], view, anchor: settingAnchor('settings.server', def.id) }] : [];
  return [
    { label: name, path: ['settings.section.editor', 'settings.languages'], view, anchor: settingAnchor('settings.languages', def.id) },
    ...contextEntries(cards, view, path, def.id),
    ...serverEntry,
    ...formattersOf(def.id).map((id): SettingEntry => ({ label: { raw: id }, path: [...path, 'settings.formatters'], view, anchor: settingAnchor('settings.formatters', `${def.id}-${id}`) })),
  ];
}

/** Settings › editor's entries of the Settings search (#689). */
export function searchEntries(): SettingEntry[] {
  return [settingEntry('settings.format.onSave', 'editor'), settingEntry('settings.languages', 'editor'), ...LANGUAGES.flatMap(languageEntries)];
}
