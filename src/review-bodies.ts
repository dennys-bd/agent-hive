import { sessionsOf } from './tasks.js';
import { isScope } from './diff.js';
import { type LineAnchor, type State, NEW_SESSION, REVIEW_TEXT_MAX, type ReviewAnchor } from './types.js';

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
