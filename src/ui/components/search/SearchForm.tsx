import { CaseSensitiveIcon, ChevronDownIcon, ChevronRightIcon, RegexIcon, ReplaceAllIcon, WholeWordIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { keyTitle } from '@/components/KeyHint';
import { t } from '@/i18n';
import { setSearchPane, type SearchPaneState } from '@/lib/search-query';
import type { SearchQuery } from '../../../types';

type Toggle = 'isCaseSensitive' | 'isWholeWord' | 'isRegex';
const TOGGLES: ReadonlyArray<{ field: Toggle; id: 'searchMatchCase' | 'searchWholeWord' | 'searchRegex'; Icon: LucideIcon }> = [
  { field: 'isCaseSensitive', id: 'searchMatchCase', Icon: CaseSensitiveIcon },
  { field: 'isWholeWord', id: 'searchWholeWord', Icon: WholeWordIcon },
  { field: 'isRegex', id: 'searchRegex', Icon: RegexIcon },
];
const ICON_BUTTON = 'flex shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground';

interface FormProps { pane: SearchPaneState; error?: string; canReplaceAll: boolean; onReplaceAll(): void }

/** The query field with its three toggles, the chevron that shows the replace field and the invalid-regex alert. */
export function SearchForm({ pane, error, canReplaceAll, onReplaceAll }: FormProps) {
  const input = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusAt is the trigger of a focus (⌘⇧F), not a value it uses
  useEffect(() => { input.current?.focus(); }, [pane.focusAt]);
  const change = (query: Partial<SearchQuery>): void => setSearchPane({ query: { ...pane.query, ...query } });
  const Chevron = pane.isReplaceOpen ? ChevronDownIcon : ChevronRightIcon;
  const label = t(pane.isReplaceOpen ? 'search.hideReplace' : 'search.showReplace');
  const isBroken = error !== undefined;
  const replaceAll = t('shortcuts.searchReplaceAll');
  return (
    <div className="flex gap-0.5 pr-3 pl-1">
      <button type="button" aria-label={label} title={pane.isReplaceOpen ? label : keyTitle(label, 'replaceInFiles')} aria-expanded={pane.isReplaceOpen} onClick={() => setSearchPane({ isReplaceOpen: !pane.isReplaceOpen })} className={`h-[26px] w-5 ${ICON_BUTTON}`}>
        <Chevron aria-hidden="true" className="size-4" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className={`flex h-[26px] items-center gap-px rounded-md border pr-0.5 pl-2 text-[13px] focus-within:ring-[3px] ${isBroken ? 'border-destructive focus-within:ring-destructive/30' : 'border-input focus-within:border-ring focus-within:ring-ring/50'}`}>
          <input ref={input} value={pane.query.q} onChange={(event) => change({ q: event.target.value })} placeholder={t('search.fieldPlaceholder')} aria-label={t('search.field')} aria-invalid={isBroken} spellCheck={false} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
          {TOGGLES.map(({ field, id, Icon }) => {
            const name = t(`shortcuts.${id}`);
            const isOn = pane.query[field];
            return (
              <button key={id} type="button" role="switch" aria-checked={isOn} aria-label={name} title={keyTitle(name, id)} onClick={() => change({ [field]: !isOn })} className={`h-5 w-[22px] border ${ICON_BUTTON} ${isOn ? 'border-muted-foreground bg-accent text-foreground' : 'border-transparent'}`}>
                <Icon aria-hidden="true" className="size-4" />
              </button>
            );
          })}
        </div>
        {isBroken && <div role="alert" className="px-0.5 pt-0.5 text-destructive text-xs">{pane.query.isRegex ? t('search.invalidRegex', { reason: error }) : error}</div>}
        {pane.isReplaceOpen && (
          <div className="flex h-[26px] items-center gap-px rounded-md border border-input pr-0.5 pl-2 text-[13px] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
            <input value={pane.replacement} onChange={(event) => setSearchPane({ replacement: event.target.value })} aria-label={t('search.replaceField')} spellCheck={false} className="min-w-0 flex-1 bg-transparent outline-none" />
            <button type="button" aria-label={replaceAll} title={keyTitle(replaceAll, 'searchReplaceAll')} disabled={!canReplaceAll} onClick={onReplaceAll} className={`h-5 w-[22px] border border-transparent ${ICON_BUTTON} disabled:opacity-50`}>
              <ReplaceAllIcon aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
