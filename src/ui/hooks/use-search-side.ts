import { useEffect, useEffectEvent } from 'react';
import type { SideTab } from '@/components/FilesPanel';
import { clampSideSize, onShortcutKey, type PanelId, type Side } from '@/lib/dock-layout';
import { editorSelection, openSearch, selectionSeed } from '@/lib/search-query';

export const SEARCH_MIN_PX = 320; // the design's --rs-width on busca

/** The right side's new percent so it is at least SEARCH_MIN_PX wide, clamped by SIDE_BOUNDS; undefined when it already is, or nothing to measure. */
export const widenedSize = (percent: number, frameWidth: number): number | undefined =>
  frameWidth <= 0 || (percent * frameWidth) / 100 >= SEARCH_MIN_PX ? undefined : clampSideSize('right', (SEARCH_MIN_PX / frameWidth) * 100);

interface SearchSideArgs { isOn: boolean; sideTab: SideTab; setSideTab(tab: SideTab): void; activate(id: PanelId): void; size: number; isShown: boolean; resize(side: Side, size: number): void }

/** searchInFiles / replaceInFiles while an activity shows (#868): the right side opens on busca, the field focused, seeded with the editor's
 * selection; replaceInFiles opens the replace field too. Once busca shows, a side under SEARCH_MIN_PX widens to it; leaving never shrinks it. */
export function useSearchSide({ isOn, sideTab, setSideTab, activate, size, isShown, resize }: SearchSideArgs): void {
  useEffect(() => (isOn ? onShortcutKey<boolean>([[false, 'searchInFiles'], [true, 'replaceInFiles']], (isReplace) => {
    activate('detail');
    setSideTab('search');
    void editorSelection().then((text) => openSearch({ isReplace, seed: selectionSeed(text) }));
  }) : undefined), [isOn, activate, setSideTab]);
  // size is read when busca starts to show, not a dependency: a drag afterwards must not be undone
  const widen = useEffectEvent(() => {
    const next = widenedSize(size, document.querySelector('[data-dock-frame]')?.clientWidth ?? 0);
    if (next !== undefined) resize('right', next);
  });
  const isSearchShown = isShown && sideTab === 'search';
  useEffect(() => {
    if (isSearchShown) widen();
  }, [isSearchShown]);
}
