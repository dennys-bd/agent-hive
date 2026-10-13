import { sessionsOf } from './tasks.js';
import { isScope } from './diff.js';
import { TWEAK_NAME, TWEAKS_MAX, TWEAK_TEXT_MAX } from './design-tweaks.js';
import { DESIGN_VIEWPORTS, type DesignRect, type DesignTarget, type DesignTweakValue, type DesignViewport, type LineAnchor, type State, NEW_SESSION, REVIEW_TEXT_MAX, type ReviewAnchor, type UnpinnedDesignAnchor } from './types.js';

// What the review routes and hive_reply take from a request (#591): checked here, stored as data, never passed to git or the disk.

const PATH_MAX = 4096; // characters; a path git printed
const HASH = /^[0-9a-f]{64}$/;

export const isPath = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= PATH_MAX;
export const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

const LINES_MAX = 10_000;
const EXCERPT_MAX_BYTES = 64 * 1024;
const isLine = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/** A comment or reply trimmed, 1 to REVIEW_TEXT_MAX characters (#591). */
export function textOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' || text.length > REVIEW_TEXT_MAX ? undefined : text;
}

/** A session of this task, or a new one (#591): never another task's. */
export const isTaskSession = (state: Pick<State, 'activityRecords'>, taskId: string, id: unknown): id is string =>
  typeof id === 'string' && (id === NEW_SESSION || sessionsOf(state, taskId).some((s) => s.id === id));

/** A message's recipients (#591): one or more of the task's sessions or NEW_SESSION, each once. */
export function recipientsOf(state: Pick<State, 'activityRecords'>, taskId: string, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => isTaskSession(state, taskId, id))) return undefined;
  return [...new Set(raw as string[])];
}

/** Lines of a diff and their text (#591, #592): the excerpt holds exactly the range's lines, one side's lines being consecutive within a hunk. */
export function parseLineAnchor(raw: unknown): (LineAnchor & { excerpt: string[] }) | undefined {
  const { path, side, start, end, excerpt } = (raw ?? {}) as Record<string, unknown>;
  if (!isPath(path) || (side !== 'old' && side !== 'new') || !isLine(start) || !isLine(end) || end < start || end - start >= LINES_MAX) return undefined;
  if (!Array.isArray(excerpt) || excerpt.length !== end - start + 1 || !excerpt.every((line) => typeof line === 'string')) return undefined;
  if (Buffer.byteLength(JSON.stringify(excerpt), 'utf8') > EXCERPT_MAX_BYTES) return undefined;
  return { path, side, start, end, excerpt: excerpt as string[] };
}

/** Where a comment sits (#591): its scope and its lines. */
export function parseAnchor(raw: unknown): ReviewAnchor | undefined {
  const { scope } = (raw ?? {}) as Record<string, unknown>;
  const lines = parseLineAnchor(raw);
  return isScope(scope) && lines !== undefined ? { scope, ...lines } : undefined;
}

const SELECTOR_MAX = 1000; // characters
const ELEMENT_TEXT_MAX = 500; // characters, stored as sent
const isCoord = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isViewport = (value: unknown): value is DesignViewport => DESIGN_VIEWPORTS.includes(value as DesignViewport);

function rectOf(raw: unknown): DesignRect | undefined {
  const { x, y, width, height } = (raw ?? {}) as Record<string, unknown>;
  if (!isCoord(x) || !isCoord(y) || !isCoord(width) || !isCoord(height) || width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

// An element (selector and text, data the agent reads, never run) or an area, each with its rect
function targetOf(raw: Record<string, unknown>): DesignTarget | undefined {
  const rect = rectOf(raw.rect);
  if (rect === undefined) return undefined;
  if (raw.kind === 'area') return { kind: 'area', rect };
  const { selector, text } = raw;
  if (raw.kind !== 'element' || typeof selector !== 'string' || selector === '' || selector.length > SELECTOR_MAX) return undefined;
  return typeof text === 'string' && text.length <= ELEMENT_TEXT_MAX ? { kind: 'element', selector, text, rect } : undefined;
}

const isTweakValue = (value: unknown): value is DesignTweakValue =>
  typeof value === 'boolean' || (typeof value === 'string' && value.length <= TWEAK_TEXT_MAX) || isCoord(value);

// The tweaks a design comment was made on (#241): names the frame could hold, plain values, a bounded count; data the agent reads
function tweaksOf(raw: unknown): Record<string, DesignTweakValue> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > TWEAKS_MAX || !entries.every(([name, value]) => TWEAK_NAME.test(name) && isTweakValue(value))) return undefined;
  return Object.fromEntries(entries) as Record<string, DesignTweakValue>;
}

/** Where a design comment sits (#111), without its pin: a pin in the body is ignored, the server sets it. */
export function parseDesignAnchor(raw: unknown): UnpinnedDesignAnchor | undefined {
  const body = (raw ?? {}) as Record<string, unknown>;
  const { path, viewport, theme } = body;
  const target = targetOf(body);
  const tweaks = tweaksOf(body.tweaks);
  if (!isPath(path) || !isViewport(viewport) || (theme !== 'dark' && theme !== 'light') || target === undefined || tweaks === undefined) return undefined;
  return { path, viewport, theme, tweaks, ...target };
}

/** A conversation's anchor (#111): a design one when the body carries a kind, else #591's lines. */
export const parseThreadAnchor = (raw: unknown): ReviewAnchor | UnpinnedDesignAnchor | undefined =>
  (typeof raw === 'object' && raw !== null && 'kind' in raw ? parseDesignAnchor(raw) : parseAnchor(raw));
