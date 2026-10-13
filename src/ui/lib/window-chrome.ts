// A full-window header's chrome: the header drags the window (#583), and its controls opt out with [-webkit-app-region:no-drag]. The left
// inset clears the macOS window buttons, which src/main.ts places for a 44px (h-11) header; App.tsx pads the setup error by the same 44px
// (pt-11). The window header (#221) puts the inset on its left column, not on itself: its columns' % widths need a header with no padding.
export const WINDOW_DRAG = 'h-11 select-none [-webkit-app-region:drag]';
export const WINDOW_INSET = 'pl-[100px]';
export const WINDOW_CHROME = `${WINDOW_DRAG} ${WINDOW_INSET}`;
