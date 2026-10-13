// A full-window header's chrome: the header drags the window (#583), and its controls opt out with [-webkit-app-region:no-drag]. The left
// inset clears the macOS window buttons, which src/main.ts places for a 44px (h-11) header; App.tsx pads the setup error by the same 44px
// (pt-11). index.css sets the inset per state (#295): 84px in a window, 12px in full screen and off macOS. The window header (#221) puts it on
// its left column, not on itself: its columns' % widths need a header with no padding.
export const WINDOW_DRAG = 'h-11 select-none [-webkit-app-region:drag]';
export const WINDOW_INSET = 'pl-(--window-inset)';
// Settings' header (#295): in full screen it moves left only as far as the rail's edge, never over the rail's column
export const SETTINGS_CHROME = `${WINDOW_DRAG} pl-(--settings-inset)`;
