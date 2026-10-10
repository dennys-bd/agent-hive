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
import { LANGUAGES, languageDef } from '../../../languages';
import type { LanguageId } from '../../../types';

interface EditorSectionProps { draft: SettingsDraft; language?: LanguageId; onLanguage(language: LanguageId): void; onChange(patch: Partial<SettingsDraft>): void }
interface FormatOnSaveProps { names: readonly string[]; value: EditorDraft['formatOnSave']; onChange(value: EditorDraft['formatOnSave']): void }

// formatar ao salvar (#780): one switch for the Hive
function FormatOnSaveCard({ names, value, onChange }: FormatOnSaveProps) {
  return (
    <section aria-label={t('settings.format.onSave')} className="grid grid-cols-[auto_minmax(0,1fr)_20rem] items-center gap-4 rounded-xl border bg-card px-5 py-4 shadow-sm">
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
