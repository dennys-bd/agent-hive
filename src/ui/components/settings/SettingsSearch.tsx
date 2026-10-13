import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { KeyHint } from '@/components/KeyHint';
import { Input } from '@/components/ui/input';
import { currentLanguage, t } from '@/i18n';
import { onShortcutKey } from '@/lib/dock-layout';
import { type SettingEntry, type SettingMatch, searchSettings } from '@/lib/settings-search';

/** The label, with the query's run in bold when the shown text matched (#689). */
function MatchLabel({ label, range }: { label: string; range?: readonly [number, number] }) {
  if (range === undefined) return <>{label}</>;
  return <>{label.slice(0, range[0])}<strong className="font-semibold text-foreground">{label.slice(range[0], range[1])}</strong>{label.slice(range[1])}</>;
}

interface ResultProps { match: SettingMatch; id: string; isActive: boolean; onActive(): void; onPick(): void }

function Result({ match, id, isActive, onActive, onPick }: ResultProps) {
  return (
    // the pick happens on mousedown, before the field blurs and closes the list
    <button type="button" role="option" tabIndex={-1} id={id} aria-selected={isActive} onMouseEnter={onActive}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      className={`flex flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left ${isActive ? 'bg-accent' : ''}`}>
      <span className="text-[13px] text-muted-foreground leading-[18px]"><MatchLabel label={match.label} range={match.range} /></span>
      <span className="text-muted-foreground text-xs">{match.path}</span>
    </button>
  );
}

interface ResultsProps { listId: string; matches: readonly SettingMatch[]; current: number; setActive(i: number): void; pick(m: SettingMatch): void }

function Results({ listId, matches, current, setActive, pick }: ResultsProps) {
  return (
    <div className="absolute top-full left-0 z-50 mt-1 w-[360px] rounded-md border bg-popover p-1 text-popover-foreground shadow-[0_4px_12px_rgb(0_0_0/.45)]">
      {matches.length === 0
        ? <p className="px-2 py-1.5 text-muted-foreground text-xs">{t('settings.search.none')}</p>
        : <div role="listbox" id={listId} aria-label={t('settings.search')} className="flex flex-col">
            {matches.map((m, i) => (
              <Result key={m.entry.anchor + m.path} match={m} id={`${listId}-${i}`} isActive={i === current} onActive={() => setActive(i)} onPick={() => pick(m)} />
            ))}
          </div>}
      <p className="mt-1 border-t px-2 pt-1.5 text-muted-foreground text-xs">{[t('settings.search.navigate'), t('settings.search.open'), t('settings.search.close')].join(' · ')}</p>
    </div>
  );
}

export function SettingsSearch({ entries, onPick }: { entries: readonly SettingEntry[]; onPick(entry: SettingEntry): void }) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const matches = searchSettings(query, entries, currentLanguage());
  const current = Math.min(active, matches.length - 1);
  const isOpen = isFocused && query.trim() !== '';

  // mounted exactly while the Settings page is (#689); Note 4
  useEffect(() => onShortcutKey([[true, 'searchSettings']], () => { input.current?.focus(); input.current?.select(); }), []);

  const pick = (match: SettingMatch) => { setQuery(''); setActive(0); onPick(match.entry); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, Math.min(matches.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && matches.length > 0 && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(matches[current]);
    } else if (e.key === 'Escape') {
      // Settings' own Escape, on document, skips a prevented key: the page stays
      e.preventDefault();
      if (query === '') input.current?.blur(); else { setQuery(''); setActive(0); }
    }
  };

  return (
    <div className="relative">
      <Input ref={input} role="combobox" aria-label={t('settings.search')} placeholder={t('settings.search')} aria-autocomplete="list" aria-controls={isOpen && matches.length > 0 ? listId : undefined}
        aria-expanded={isOpen} aria-activedescendant={isOpen && matches.length > 0 ? `${listId}-${current}` : undefined} value={query} className="pr-14"
        onChange={(e) => { setQuery(e.target.value); setActive(0); }} onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)} onKeyDown={onKeyDown} />
      {query === '' && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center"><KeyHint id="searchSettings" /></span>}
      {isOpen && <Results listId={listId} matches={matches} current={current} setActive={setActive} pick={pick} />}
    </div>
  );
}
