import { createContext, useContext } from 'react';
import { EDITOR_DEFAULTS, type EditorConfig, type LanguageId } from '../../types';

/** What the editor pane knows of Settings › editor (#780): the saved config, and how `instalar {server}` opens a language there. */
export interface EditorLanguages { editor: EditorConfig; openLanguage?(language: LanguageId): void }
export const EditorLanguagesContext = createContext<EditorLanguages>({ editor: EDITOR_DEFAULTS });
export const useEditorLanguages = (): EditorLanguages => useContext(EditorLanguagesContext);
