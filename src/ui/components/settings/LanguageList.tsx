import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t } from '@/i18n';
import { attentionCount, type LanguageShow, type LanguageStatus, languageStatus, shownLanguages, summaryOf } from '@/lib/settings-languages';
import type { EditorInstalls, FormatterState, LanguageId } from '../../../types';

interface LanguageListProps { selected: LanguageId; installs?: EditorInstalls; states?: FormatterState[]; onSelect(language: LanguageId): void }

const TONE: Record<LanguageStatus['kind'], { dot: string; text: string }> = {
  installing: { dot: 'bg-working', text: 'text-working' }, failed: { dot: 'bg-destructive', text: 'text-destructive' },
  requires: { dot: 'bg-waiting', text: 'text-waiting' }, update: { dot: 'bg-review', text: 'text-review' },
};
const nameOf = (id: LanguageId): string => t(`editor.language.${id}`);

function StatusWord({ status }: { status: LanguageStatus }) {
  const word = status.kind === 'requires' ? t('settings.languages.status.requires', { tool: status.tool }) : t(`settings.languages.status.${status.kind}`);
  return <span className={`flex items-center gap-1.5 text-xs ${TONE[status.kind].text}`}><span aria-hidden className={`size-1.5 rounded-full ${TONE[status.kind].dot}`} />{word}</span>;
}

/** The languages of Settings › editor (#780): a filter, todas / instaladas / atenção, and one row per language with its summary and status. */
export function LanguageList({ selected, installs, states, onSelect }: LanguageListProps) {
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<LanguageShow>('all');
  const shown = shownLanguages(query, show, installs, nameOf);
  // A selection the filter hides came from outside (the Settings search, the editor bar's instalar): show it, filter cleared.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new selection may clear the filter, not typing in it
  useEffect(() => {
    if (shown.some((def) => def.id === selected)) return;
    setQuery('');
    setShow('all');
  }, [selected]);
  return (
    <div className="flex min-w-0 flex-col gap-2 border-r p-3">
      <Input type="search" aria-label={t('settings.languages.filter')} placeholder={t('settings.languages.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <ToggleGroup type="single" variant="outline" size="sm" value={show} onValueChange={(value) => value && setShow(value as LanguageShow)} aria-label={t('settings.languages.show')} className="w-full">
        <ToggleGroupItem value="all" className="flex-1">{t('settings.languages.show.all')}</ToggleGroupItem>
        <ToggleGroupItem value="installed" className="flex-1">{t('settings.languages.show.installed')}</ToggleGroupItem>
        <ToggleGroupItem value="attention" className="flex-1">{t('settings.languages.show.attention', { n: attentionCount(installs) })}</ToggleGroupItem>
      </ToggleGroup>
      <div role="listbox" aria-label={t('settings.languages')} className="flex flex-col gap-0.5">
        {shown.map((def) => {
          const status = languageStatus(def, installs);
          const summary = summaryOf(def, installs, states);
          return (
            <button key={def.id} type="button" role="option" aria-selected={def.id === selected} onClick={() => onSelect(def.id)}
              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left ${def.id === selected ? 'bg-accent' : 'hover:bg-accent/50'}`}>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm">{nameOf(def.id)}</span>
                <span className="truncate text-muted-foreground text-xs">{summary.length > 0 ? summary.join(' · ') : t('settings.languages.nothing')}</span>
              </span>
              {status && <StatusWord status={status} />}
            </button>
          );
        })}
      </div>
      {shown.length === 0 && <p className="text-muted-foreground text-xs">{t('settings.languages.none')}</p>}
    </div>
  );
}
