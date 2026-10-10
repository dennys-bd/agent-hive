// A full-window header's chrome: the left inset clears the macOS window buttons, which src/main.ts places for a 44px (h-11)
// header, and the header drags the window (#583). Its controls opt out with [-webkit-app-region:no-drag]. App.tsx pads the setup
// error by the same 44px (pt-11).
export const WINDOW_CHROME = 'h-11 pl-[100px] select-none [-webkit-app-region:drag]';
