import { useSyncExternalStore } from 'react';
import type { SearchQuery } from '../../types.js';
import { loadMonaco } from './editor-models.js';

/** The busca pane's own state (#868). ActivitySide is keyed by activity and remounts on every switch, so the pane keeps one query in this
 * module's store, as an IDE's search view keeps its query across folders. focusAt: a new value focuses the query field. */
export interface SearchPaneState { query: SearchQuery; replacement: string; isReplaceOpen: boolean; focusAt: number }

let state: SearchPaneState = { query: { q: '', isCaseSensitive: false, isWholeWord: false, isRegex: false }, replacement: '', isReplaceOpen: false, focusAt: 0 };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const useSearchPane = (): SearchPaneState => useSyncExternalStore(subscribe, () => state);

export function setSearchPane(change: Partial<SearchPaneState>): void {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}

/** ⌘⇧F and ⌘⇧H: focus the query field, open the replace field for the second, and replace the query with the editor's selection when there is one. */
export function openSearch({ isReplace, seed }: { isReplace: boolean; seed?: string }): void {
  setSearchPane({
    focusAt: state.focusAt + 1,
    ...(isReplace ? { isReplaceOpen: true } : {}),
    ...(seed === undefined ? {} : { query: { ...state.query, q: seed } }),
  });
}

/** The editor's selection as a query: a non-empty single line only, as an IDE seeds it. */
export const selectionSeed = (text: string | undefined): string | undefined => (text !== undefined && text !== '' && !/[\r\n]/.test(text) ? text : undefined);

/** The focused Monaco editor's selected text; undefined without one (Monaco is not loaded for it when the focus is elsewhere). */
export async function editorSelection(): Promise<string | undefined> {
  if (document.activeElement?.closest('.monaco-editor') == null) return undefined;
  const { monaco } = await loadMonaco();
  const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus());
  const selection = editor?.getSelection();
  return selection === null || selection === undefined ? undefined : editor?.getModel()?.getValueInRange(selection);
}
