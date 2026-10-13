import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { t } from '@/i18n';
import type { SettingEntry } from '@/lib/settings-search';
import type { SettingsSection } from '@/lib/settings-sections';

interface SettingsNavProps { offered: readonly SettingsSection[]; current: SettingsSection; entries: readonly SettingEntry[]; onPick(section: SettingsSection): void; onPickEntry(entry: SettingEntry): void }

// The Settings nav (#510): it lists every section; the search lists settings (#689). The field sits outside the scrolling list so its 360px result list is not clipped; maintenance stays pinned under a border.
export function SettingsNav({ offered, current, entries, onPick, onPickEntry }: SettingsNavProps) {
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
    <nav aria-label={t('settings.nav')} className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="px-3 pt-4 pb-3"><SettingsSearch entries={entries} onPick={onPickEntry} /></div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
        {offered.filter((s) => s !== 'maintenance').map(item)}
        {offered.includes('maintenance') && <div className="mt-auto border-t pt-2">{item('maintenance')}</div>}
      </div>
    </nav>
  );
}
