import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import type { LanguageId } from '../../../types';
import { editorEntries, matchingSections, type SettingsSection } from '@/lib/settings-sections';

interface SettingsNavProps { offered: readonly SettingsSection[]; current: SettingsSection; onPick(section: SettingsSection): void; onPickLanguage(language: LanguageId): void }

// The Settings nav (#510): the search narrows the items by label, hint or field label; the search also lists editor's languages, servers and formatters (#780); maintenance stays pinned under a border.
export function SettingsNav({ offered, current, onPick, onPickLanguage }: SettingsNavProps) {
  const [query, setQuery] = useState('');
  const shown = matchingSections(query, offered);
  const entries = editorEntries(query);
  const item = (s: SettingsSection) => (
    <button
      key={s} type="button" aria-current={s === current ? 'page' : undefined} aria-label={t(`settings.section.${s}`)} aria-describedby={`settings-hint-${s}`}
      className={`flex flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left ${s === current ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
      onClick={() => onPick(s)}
    >
      <span className="text-sm">{t(`settings.section.${s}`)}</span>
      <span id={`settings-hint-${s}`} className="text-muted-foreground text-xs">{t(`settings.section.${s}.hint`)}</span>
    </button>
  );
  return (
    <nav aria-label={t('settings.nav')} className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r bg-card px-3 py-4">
      <Input type="search" className="mb-3" aria-label={t('settings.search')} placeholder={t('settings.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {shown.filter((s) => s !== 'maintenance').map(item)}
      {shown.length === 0 && entries.length === 0 && <p className="px-3 text-muted-foreground text-xs">{t('settings.search.none')}</p>}
      {entries.length > 0 && (
        <fieldset aria-label={t('settings.search.editor.results')} className="flex min-w-0 flex-col gap-0.5 border-t pt-2">
          {entries.map((entry) => (
            <button key={`${entry.language}:${entry.text}`} type="button" className="flex flex-col items-start rounded-md px-3 py-1.5 text-left hover:bg-accent/50" onClick={() => { setQuery(''); onPickLanguage(entry.language); }}>
              <span className="text-sm">{entry.text}</span>
              <span className="text-muted-foreground text-xs">{entry.path}</span>
            </button>
          ))}
        </fieldset>
      )}
      {shown.includes('maintenance') && <div className="mt-auto border-t pt-2">{item('maintenance')}</div>}
    </nav>
  );
}
