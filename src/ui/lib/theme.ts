// The page's theme (#296): data-theme on <html>, which theme.css reads. Shared by the main window (App.tsx) and the terminal page (terminal.ts).
import type { Theme } from '../../types.js';

export type ResolvedTheme = 'light' | 'dark';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What `theme` paints: system follows macOS, light and dark force their own. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}

/** Sets data-theme for `theme` and hands every resolved value to `onResolved`; only system follows macOS live, through matchMedia (Chromium
 * reports the real appearance: the Hive never sets nativeTheme.themeSource). Returns the unsubscribe: call it before applying another theme. */
export function applyTheme(theme: Theme, onResolved?: (resolved: ResolvedTheme) => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  const apply = (prefersDark: boolean): void => {
    const resolved = resolveTheme(theme, prefersDark);
    document.documentElement.dataset.theme = resolved;
    onResolved?.(resolved);
  };
  apply(query.matches);
  if (theme !== 'system') return () => {};
  const onChange = (event: MediaQueryListEvent): void => apply(event.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
