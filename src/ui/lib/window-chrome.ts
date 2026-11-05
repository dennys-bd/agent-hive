import { isWindows } from './shortcut-bindings.js';
// A full-window header's chrome: the header drags the window (#583), and its controls opt out with [-webkit-app-region:no-drag]. The left
// inset clears the macOS window buttons, which src/main.ts places for a 44px (h-11) header; App.tsx pads the setup error by the same 44px
// (pt-11). index.css sets the inset per state (#295): 84px in a window, 12px in full screen and off macOS. The window header (#221) puts it on
// its left column, not on itself: its columns' % widths need a header with no padding.
// Windows (#648): the caption buttons sit over the window's top right. A header with columns keeps them clear in its last column, so the
// columns' % widths and their borders stay the panes'; the detached strip, with none, on itself (index.css)
export const WINDOW_DRAG = 'h-11 select-none [-webkit-app-region:drag]';
export const WINDOW_INSET = 'pl-(--window-inset)';
// Settings' header (#295): in full screen voltar's arrow sits where the rail's icons and the header's panel-left do
export const SETTINGS_CHROME = `${WINDOW_DRAG} pl-(--settings-inset)`;
export type OverlayRoom = 'columns' | 'strip';
export const windowOverlay = (kind: OverlayRoom): { 'data-window-overlay'?: OverlayRoom } => (isWindows() ? { 'data-window-overlay': kind } : {});
