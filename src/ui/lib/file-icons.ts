// The files tree's icons (#754): one resolver per icon set, each in its own chunk, loaded by a dynamic import only while that set is chosen.
// vscode-icons' JSON is 3.8 MB; nobody on Material or on none pays for it.
import type { ResolvedTheme } from '@/lib/theme';
import type { FileIconSet } from '../../types';

export interface IconQuery { name: string; isFolder: boolean; isOpen: boolean; theme: ResolvedTheme }
/** A row's icon as an image URL. */
export type IconResolver = (query: IconQuery) => string;
export type LoadedIconSet = Exclude<FileIconSet, 'none'>;

/** The set's resolver; rejects when its chunk fails to load (useFileIcons logs it and the tree goes on without icons). */
export function loadIconSet(set: LoadedIconSet): Promise<IconResolver> {
  if (set === 'material') return import('@/lib/file-icons-material').then((chunk) => chunk.materialResolver);
  return import('@/lib/file-icons-vscode').then((chunk) => chunk.vscodeResolver);
}
