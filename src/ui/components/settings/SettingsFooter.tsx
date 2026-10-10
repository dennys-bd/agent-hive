import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { unsavedSections } from '@/lib/settings-sections';
import type { SettingsDraft } from '@/lib/settings-form';

interface SettingsFooterProps { changed: readonly (keyof SettingsDraft)[]; saving: boolean; savableUnchanged: boolean; saveError?: string; onRevert(): void; onSave(): void }

// Sticky under the content column (#510). savableUnchanged: the first run saves a prefilled draft nobody touched.
// saveError (#739): the footer is always in view, the section heading may be scrolled away; it takes the summary's place and the footer grows for a long message.
export function SettingsFooter({ changed, saving, savableUnchanged, saveError, onRevert, onSave }: SettingsFooterProps) {
  const n = changed.length;
  const sections = unsavedSections(changed).map((s) => t(`settings.section.${s}`)).join(', ');
  return (
    <footer className="flex min-h-16 shrink-0 items-center gap-2 border-t bg-card px-12 py-3">
      {saveError
        ? <span role="alert" className="whitespace-pre-wrap text-destructive text-xs">{saveError}</span>
        : n > 0 && <span className="text-muted-foreground text-xs">{t(n === 1 ? 'settings.unsaved.one' : 'settings.unsaved.other', { n, sections })}</span>}
      <div className="flex-1" />
      <Button type="button" variant="outline" disabled={saving || n === 0} onClick={onRevert}>{t('settings.cancel')}</Button>
      <Button type="button" disabled={saving || (n === 0 && !savableUnchanged)} onClick={onSave}>{t(saving ? 'settings.saving' : 'settings.save')}</Button>
    </footer>
  );
}
