import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { insideRect, isBounds, type Rect, type WindowBounds } from './terminal-wire.js';

/** BrowserWindow.getBounds() plus the two states a rectangle alone cannot carry (#398): a maximized or full-screen main window still
 * remembers its normal (restored) rectangle underneath, since that is what a plain move or resize would return to. */
export interface MainWindowBounds extends WindowBounds {
  maximized: boolean;
  fullScreen: boolean;
}

export const DEFAULT_MAIN_WINDOW: MainWindowBounds = { width: 1280, height: 820, maximized: false, fullScreen: false };

const isMainWindowBounds = (value: unknown): value is Required<WindowBounds> & { maximized: boolean; fullScreen: boolean } => {
  if (!isBounds(value)) return false;
  const { maximized, fullScreen } = value as Record<string, unknown>;
  return typeof maximized === 'boolean' && typeof fullScreen === 'boolean';
};

// Off every connected display (a display unplugged since the last run, #398): the rectangle would open unreachable, so the default
// centres it instead. A window merely partly off-screen still has its centre on some display and is kept as saved.
function centeredOnADisplay(bounds: Required<WindowBounds>, workAreas: Rect[]): boolean {
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return workAreas.some((area) => insideRect(center, area));
}

/** The main window's last size, position and state, or the default (1280×820, centred, normal) when the file is missing, corrupt,
 * or its saved rectangle's centre falls on none of `workAreas`. Only the known keys reach BrowserWindow's options. */
export async function readMainWindowBounds(file: string, workAreas: Rect[]): Promise<MainWindowBounds> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isMainWindowBounds(parsed) && centeredOnADisplay(parsed, workAreas)) {
      const { x, y, width, height, maximized, fullScreen } = parsed;
      return { x, y, width, height, maximized, fullScreen };
    }
  } catch {
    // missing or corrupt: the default
  }
  return DEFAULT_MAIN_WINDOW;
}

/** Stored on the main window's close; the last close wins. Synchronous on purpose: on a quit the process can exit before an async write
 * lands, and a few dozen bytes cost nothing to write in place. Throws on a failed write. */
export function writeMainWindowBounds(file: string, bounds: MainWindowBounds): void {
  writeFileSync(file, JSON.stringify(bounds));
}
