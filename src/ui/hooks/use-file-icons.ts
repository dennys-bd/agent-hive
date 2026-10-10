// The files tree's icons (#754): App.tsx provides the saved choice and the theme applyTheme painted; FilesBody reads them through useFileIcons,
// once per tree, and hands the view to each row.
import { createContext, useContext, useEffect, useState } from 'react';
import { type IconResolver, type LoadedIconSet, loadIconSet } from '@/lib/file-icons';
import type { ResolvedTheme } from '@/lib/theme';
import type { FileIconScope, FileIcons } from '../../types';

export interface FileIconsSettings extends FileIcons { theme: ResolvedTheme }
/** Off outside App.tsx's provider: a tree rendered alone shows its carets only. */
export const FileIconsContext = createContext<FileIconsSettings>({ set: 'none', scope: 'all', muted: false, theme: 'dark' });

export interface FileIconsView {
  isOn: boolean; // the rows draw an icon slot: a set is chosen and its chunk did not fail
  resolve?: IconResolver; // undefined while loading, on failure and with none
  scope: FileIconScope;
  muted: boolean;
  theme: ResolvedTheme;
}

// One promise per set for the page's life: switching back is instant, and a failed chunk is not fetched again by every tree that mounts
const LOADS = new Map<LoadedIconSet, Promise<IconResolver>>();
function loaded(set: LoadedIconSet): Promise<IconResolver> {
  const known = LOADS.get(set);
  if (known !== undefined) return known;
  const load = loadIconSet(set);
  LOADS.set(set, load);
  return load;
}

interface Loaded { set: LoadedIconSet; resolve?: IconResolver } // resolve absent: that set's import failed

/** The chosen set's resolver once its chunk is in. A failed import is logged and the tree goes on without icons, as with none. */
export function useFileIcons(): FileIconsView {
  const { set, scope, muted, theme } = useContext(FileIconsContext);
  const [current, setCurrent] = useState<Loaded>();
  useEffect(() => {
    if (set === 'none') return;
    let isLive = true;
    loaded(set).then(
      (resolve) => { if (isLive) setCurrent({ set, resolve }); },
      (err: unknown) => {
        console.warn(`file icons: the ${set} set did not load`, err);
        if (isLive) setCurrent({ set });
      },
    );
    return () => { isLive = false; };
  }, [set]);
  const mine = current?.set === set ? current : undefined; // a result for the set chosen before is not this one's
  const hasFailed = mine !== undefined && mine.resolve === undefined;
  return { isOn: set !== 'none' && !hasFailed, resolve: mine?.resolve, scope, muted, theme };
}
