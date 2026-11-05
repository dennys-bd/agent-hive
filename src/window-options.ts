// The BrowserWindow chrome per platform (#648): main.ts and detached-window.ts pass process.platform, so node:test covers every platform on
// any machine. Electron is imported for its types only. Not src/ui/lib/window-chrome.ts, which holds the UI's classes.
import type { BrowserWindowConstructorOptions } from 'electron';
import type { ResolvedTheme } from './ui/lib/theme.js';

// The two --background values of src/ui/theme.css (test/theme.test.ts keeps them in sync): a window paints before its page, so it takes
// the saved theme's background and never flashes white or the other theme (#296). Also the caption buttons' backdrop on Windows (#648).
export const WINDOW_BACKGROUND = { dark: '#111418', light: '#f5f6f8' } as const;
// The two --foreground values of theme.css: the caption buttons' ink on Windows, so they read as the header's own controls (#648)
export const WINDOW_FOREGROUND = { dark: '#e6e6e6', light: '#1f2328' } as const;
// The handoff's: 12px lights 16px from the top of a 44px header. Every Hive window hides its title bar (#533, #552)
export const TRAFFIC_LIGHTS = { x: 14, y: 16 };
const HEADER_HEIGHT = 44; // h-11: the overlay must sit inside the header

export interface TitleBarOverlay { color: string; symbolColor: string; height: number }
export type WindowChrome = Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition' | 'backgroundColor'>;

/** Windows' caption buttons in the theme's colours: at a window's creation, and again at every theme the page resolves (window:theme). */
export const titleBarOverlayFor = (theme: ResolvedTheme): TitleBarOverlay =>
  ({ color: WINDOW_BACKGROUND[theme], symbolColor: WINDOW_FOREGROUND[theme], height: HEADER_HEIGHT });

/** The title bar options of a Hive window. win32: the caption buttons over the header's right end, and the menu, still set for its
 *  accelerators, never shown. Everywhere else: today's, the traffic lights inside the header's left inset. */
export function windowChromeOptions(platform: NodeJS.Platform, theme: ResolvedTheme): WindowChrome {
  const backgroundColor = WINDOW_BACKGROUND[theme];
  if (platform !== 'win32') return { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS, backgroundColor };
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayFor(theme), backgroundColor };
}
