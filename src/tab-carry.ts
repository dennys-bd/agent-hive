// A tab crossing between the main window and a detached one (#534, #551). The center's tab ref and its parser live here, not in
// center-layout.ts: main checks every moved payload and the node build excludes that file, so both pages and main read stored layouts and
// moved tabs through this one parser. Pure: no DOM, no React.
import type { DiffScope } from './types.js';
import { leavesOf, type Panes, parsePanes } from './ui/lib/pane-split.js';
import { isObject } from './ui/lib/split-tree.js';

/** What a layout stores of a tab: enough to rebuild it from the activity's live runs and its task. A run's tab split into panes (#641) keeps
 * one of its runs, the anchor, as its ptyId and its key; the anchor is always one of its panes. A run tab whose anchor holds a session names
 * it (#696): after a restart the tab still knows the session to continue. */
export type CenterTabRef = { kind: 'run'; ptyId: string; panes?: Panes; sessionId?: string } | { kind: 'diff'; scope: DiffScope; checkpoint?: number } | { kind: 'console'; channel?: string; locked?: true; run?: string } | { kind: 'file'; path: string } | { kind: 'preview'; path: string } | { kind: 'design'; path: string } | { kind: 'changes'; path: string } | { kind: 'untitled'; n: number };
export type RunRef = Extract<CenterTabRef, { kind: 'run' }>;
/** A console tab (#755): the channel it shows, its own and saved with the layout; locked on a commands stage's channel, with no channel select.
 * No channel: the newest one, as a tab stored before #755 reads. */
export type ConsoleRef = Extract<CenterTabRef, { kind: 'console' }>;
export const consoleRef = (channel?: string, locked = false, run?: string): ConsoleRef =>
  ({ kind: 'console', ...(channel === undefined ? {} : { channel }), ...(locked ? { locked: true as const } : {}), ...(run === undefined ? {} : { run }) });
// A posix path with its `.` and empty segments gone and each `..` taken back (#697): a relative path's leading `..` stays, for isFilePath to
// refuse, and the root's parent is the root. String work only: the page has no node:path
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/');
  const parts: string[] = []; // local to this call, so the push below mutates nothing shared
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else if (!isAbsolute) parts.push(part);
  }
  return `${isAbsolute ? '/' : ''}${parts.join('/')}`;
}

/** A file tab's path (#717, #697): relative to the activity's folder without a `..` segment, or absolute (a file outside it) as
 * normalizePath leaves it; never empty. */
export const isFilePath = (path: string): boolean =>
  path !== '' && path !== '/' && !path.split('/').includes('..') && (!path.startsWith('/') || normalizePath(path) === path);

// A stored run tab: with panes (#641), only when parsePanes reads them and the anchor is one of them; its session (#696) only as a string
function parseRun({ ptyId, panes, sessionId }: Record<string, unknown>): RunRef | undefined {
  if (typeof ptyId !== 'string' || ptyId === '') return undefined;
  const session = typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {};
  if (panes === undefined) return { kind: 'run', ptyId, ...session };
  const parsed = parsePanes(panes);
  return parsed !== undefined && leavesOf(parsed.root).includes(ptyId) ? { kind: 'run', ptyId, panes: parsed, ...session } : undefined;
}

// A stored console tab (#755): its channel only as a non-empty string, locked and run only beside one; anything else is the plain console
const parseConsole = ({ channel, locked, run }: Record<string, unknown>): ConsoleRef =>
  (typeof channel === 'string' && channel !== '' ? consoleRef(channel, locked === true, typeof run === 'string' && run !== '' ? run : undefined) : consoleRef());

const DIFF_SCOPE_NAMES: readonly DiffScope[] = ['stage', 'worktree', 'commit', 'checkpoint'];

/** A tab ref read back (#458), from a stored layout or a moved tab: only what was written, unknown keys dropped. An untitled tab (#818) is
 *  never stored, so it reads only under `untitled`, which a moved tab passes (#551), and only with a whole positive n. */
export function parseTabRef(value: unknown, { untitled = false }: { untitled?: boolean } = {}): CenterTabRef | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind === 'run') return parseRun(value);
  if (value.kind === 'diff' && DIFF_SCOPE_NAMES.includes(value.scope as DiffScope)) { // #619: a checkpoint only as a whole positive number
    const checkpoint = value.scope === 'checkpoint' && Number.isInteger(value.checkpoint) && (value.checkpoint as number) >= 1 ? { checkpoint: value.checkpoint as number } : {};
    return { kind: 'diff', scope: value.scope as DiffScope, ...checkpoint };
  }
  if (value.kind === 'file' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'file', path: value.path }; // #717
  if (value.kind === 'preview' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'preview', path: value.path }; // #697
  if (value.kind === 'design' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'design', path: value.path }; // #109
  if (value.kind === 'changes' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'changes', path: value.path }; // #668
  if (value.kind === 'console') return parseConsole(value); // #755
  if (untitled && value.kind === 'untitled' && Number.isInteger(value.n) && (value.n as number) >= 1) return { kind: 'untitled', n: value.n as number };
  return undefined;
}

/** What only the renderer holds of a moved tab (#534): a dirty buffer's text, its base version, the editor's opaque view state. */
export interface TabCarry { text: string; base: string; viewState?: object }
/** A tab crossing between windows (#534): the activity's key, the center's ref, and its carry. */
export interface MovedTab { activity: string; ref: CenterTabRef; carry?: TabCarry }

// The tabs whose state only the renderer holds (#551): runs, diffs, consoles and designs live in the daemon, a preview re-reads its file
const CARRIED_KINDS: ReadonlySet<CenterTabRef['kind']> = new Set(['file', 'changes', 'untitled']);

// A carry as takeCarry made it: string text and base, a view state only as a plain object (Monaco's own, never read here); other keys dropped
function parseCarry(value: unknown): TabCarry | undefined {
  if (!isObject(value)) return undefined;
  const { text, base, viewState } = value;
  if (typeof text !== 'string' || typeof base !== 'string') return undefined;
  if (viewState === undefined) return { text, base };
  return isObject(viewState) ? { text, base, viewState } : undefined;
}

/** A moved tab as main and both pages accept it (#551): a non-empty activity, a ref parseTabRef reads (an untitled one included), and a carry
 *  only on a tab that holds one. Anything else is refused whole; unknown keys are dropped. */
export function parseMovedTab(value: unknown): MovedTab | undefined {
  if (!isObject(value)) return undefined;
  const { activity, carry } = value;
  const ref = parseTabRef(value.ref, { untitled: true });
  if (typeof activity !== 'string' || activity === '' || ref === undefined) return undefined;
  if (carry === undefined) return { activity, ref };
  const parsed = CARRIED_KINDS.has(ref.kind) ? parseCarry(carry) : undefined;
  return parsed === undefined ? undefined : { activity, ref, carry: parsed };
}
