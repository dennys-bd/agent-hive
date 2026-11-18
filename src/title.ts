// A session's title as display text, apart from usage.ts so a transcript reader can use it without importing the runners' registry (a cycle).
const TITLE_MAX = 60; // characters of a session's /rename title a run's tab shows (#489): past it a tab stops being readable
// C0, DEL, C1 and the bidi controls (LRM, RLM, embeddings, overrides, isolates): the transcript is a file outside the Hive's control, and a
// reordered label beside Parar would misname the run it stops. The zero-width joiner stays: emoji sequences need it
const CONTROL_CHARS = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** A session's /rename title as display text (#489): control characters dropped, trimmed, at most TITLE_MAX characters, counted in code
 * points so an emoji is never cut in half. Anything but a string, or nothing left, is no title. The state file's stored name reads through it too. */
export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = Array.from(value.replace(CONTROL_CHARS, '').trim()).slice(0, TITLE_MAX).join('').trim();
  return text === '' ? undefined : text;
}
