// The editor pane's colours (#717): the page's tokens (theme.css), as a terminal's (#296), on Monaco's light or dark base, repainted on every
// data-theme change. Monaco has one theme for the whole page, so one name redefined serves both, and every editor follows at once.
import type * as Monaco from 'monaco-editor';

const THEME = 'hive';

// TextMate scopes vs and vs-dark have no rule for (#780): their Monarch tokens are named keyword, number, type; a TextMate scope matches a rule
// by its dotted prefix, so these copy Monaco's own colours for each base
const BASE_COLOURS = { dark: { keyword: '569CD6', number: 'B5CEA8', type: '4EC9B0' }, light: { keyword: '0000FF', number: '098658', type: '267F99' } };
export const TEXTMATE_RULES = (isLight: boolean): { token: string; foreground: string }[] => {
  const c = BASE_COLOURS[isLight ? 'light' : 'dark'];
  return [
    { token: 'storage', foreground: c.keyword }, { token: 'constant.language', foreground: c.keyword }, { token: 'constant.numeric', foreground: c.number },
    { token: 'entity.name.type', foreground: c.type }, { token: 'support.type', foreground: c.type },
  ];
};
type ThemeApi = Pick<typeof Monaco.editor, 'defineTheme' | 'setTheme'>;

function paintEditors(editor: ThemeApi): void {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string): string => css.getPropertyValue(name).trim();
  const isLight = document.documentElement.dataset.theme === 'light';
  editor.defineTheme(THEME, {
    base: isLight ? 'vs' : 'vs-dark',
    inherit: true,
    rules: TEXTMATE_RULES(isLight),
    colors: {
      'editor.background': token('--background'), 'editor.foreground': token('--foreground'), 'editorCursor.foreground': token('--foreground'),
      'editor.selectionBackground': token('--secondary'), 'editor.lineHighlightBackground': token('--card'),
      'editorLineNumber.foreground': token('--muted-foreground'), 'editorLineNumber.activeForeground': token('--foreground'),
      'editorWidget.background': token('--popover'), 'editorWidget.border': token('--border'),
      'editorError.foreground': token('--destructive'), 'editorWarning.foreground': token('--waiting'), 'editorInfo.foreground': token('--review'),
      'editorOverviewRuler.errorForeground': token('--destructive'), 'editorOverviewRuler.warningForeground': token('--waiting'), 'editorOverviewRuler.infoForeground': token('--review'),
      'editorSuggestWidget.background': token('--popover'), 'editorSuggestWidget.border': token('--border'),
      'editorSuggestWidget.selectedBackground': token('--accent'), 'editorSuggestWidget.highlightForeground': token('--foreground'),
      'editorHoverWidget.background': token('--popover'), 'editorHoverWidget.border': token('--border'),
    },
  });
  editor.setTheme(THEME);
}

/** Paints now and on every data-theme change, as followTheme does for xterm (#296). Returns the unsubscribe. */
export function followEditorTheme(editor: ThemeApi): () => void {
  paintEditors(editor);
  const observer = new MutationObserver(() => paintEditors(editor));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
