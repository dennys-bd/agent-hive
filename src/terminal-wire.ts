import { readFile, writeFile } from 'node:fs/promises';

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** BrowserWindow.getBounds() as stored in terminal-bounds.json; x / y absent the first time, so Electron centres the window. */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export const DEFAULT_TERMINAL_WINDOW: WindowBounds = { width: 1000, height: 640 }; // the first window; the last closed one's bounds after that

/** A position in screen pixels (DIPs): the pointer, the cursor, a window's top-left (#252). */
export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

/** Whether a point falls on a rectangle in the same pixels, its edges included: a saved main window's centre on a display (main-window-bounds.ts, #398). */
export function insideRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

// #808: well past any real screen. A grid only ever grows the host's fallback, so an unbounded one would make every later spawn huge
const MAX_COLS = 1000;
const MAX_ROWS = 500;

const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const isGridSide = (value: unknown, max: number): value is number => isPositiveInt(value) && value <= max;

// The pty resize route's body comes from the page: a shape that is not a size is refused, never passed to the pty (#251).
export const isSize = (value: unknown): value is TerminalSize =>
  typeof value === 'object' && value !== null && isGridSide((value as TerminalSize).cols, MAX_COLS) && isGridSide((value as TerminalSize).rows, MAX_ROWS);

/** The grid a POST that opens a run carries (#808): a hint for the pty's first size, rebuilt from its two keys so nothing else reaches the
 * pty. Anything else is no size and the host's fallback, never a refusal: a session is worth more than a resize. */
export function sizeIn(body: unknown): TerminalSize | undefined {
  const size = typeof body === 'object' && body !== null ? (body as { size?: unknown }).size : undefined;
  return isSize(size) ? { cols: size.cols, rows: size.rows } : undefined;
}

/** What a terminal's WebSocket sends the daemon (#407): its keys, and every new grid a fit gives. */
export type PtyMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

// A socket frame comes from the page: anything but the two shapes, checked as the old POST routes did, is undefined and dropped, never a
// throw that would close the terminal (#407). Rebuilt from the known keys, so nothing else rides along to the pty.
export function parsePtyMessage(raw: string): PtyMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, data } = value as Record<string, unknown>;
  if (type === 'input') return typeof data === 'string' ? { type: 'input', data } : undefined;
  if (type === 'resize' && isSize(value)) return { type: 'resize', cols: value.cols, rows: value.rows };
  return undefined;
}

/** Whether a value is a full WindowBounds record: only the shape readBounds and readMainWindowBounds accept as saved, real bounds. */
export const isBounds = (value: unknown): value is Required<WindowBounds> => {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height } = value as Required<WindowBounds>;
  return Number.isInteger(x) && Number.isInteger(y) && isPositiveInt(width) && isPositiveInt(height);
};

/** The last closed terminal window's bounds, or the default when the file is missing or not what writeBounds wrote. */
export async function readBounds(file: string): Promise<WindowBounds> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isBounds(parsed)) {
      const { x, y, width, height } = parsed;
      return { x, y, width, height }; // only the four keys reach BrowserWindow's options
    }
  } catch {
    // missing or corrupt: the default
  }
  return DEFAULT_TERMINAL_WINDOW;
}

/** Stored on every terminal window close; the last close wins. userData exists by then (Electron creates it on ready). */
export function writeBounds(file: string, bounds: WindowBounds): Promise<void> {
  return writeFile(file, JSON.stringify(bounds));
}
