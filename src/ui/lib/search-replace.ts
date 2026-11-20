import type { ReplaceAnswer, ReplaceRequest, SearchFileResult, SearchMatch } from '../../types.js';
import { postJson, sendJson, WriteCancelled } from './api.js';

export type Segment = { kind: 'text'; text: string } | { kind: 'match'; text: string; replacement?: string };

const HTTP_CONFLICT = 409;
// not file-read's activityRoute: that module is not in the node build of this one
const activityPath = (activityId: string, name: string): string => `/activities/${encodeURIComponent(activityId)}/${name}`;

/** A row's text cut at its spans (#868); with a replacement, each match carries it, the preview's struck old and inserted new. */
export function segmentsOf(match: SearchMatch, replacement?: string): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const [start, end] of match.spans) {
    if (start > at) segments.push({ kind: 'text', text: match.text.slice(at, start) });
    const text = match.text.slice(start, end);
    segments.push(replacement === undefined ? { kind: 'match', text } : { kind: 'match', text, replacement });
    at = end;
  }
  if (at < match.text.length) segments.push({ kind: 'text', text: match.text.slice(at) });
  return segments;
}

export const fileSpans = (file: SearchFileResult): number => file.matches.reduce((n, m) => n + m.spans.length, 0);

/** POST …/search/replace through postJson, so run mode's gate asks first (#469). */
export const replaceIn = (activityId: string, request: ReplaceRequest): Promise<ReplaceAnswer> =>
  postJson<ReplaceAnswer>(activityPath(activityId, 'search/replace'), request);

/** Each changed file's previous text back through PUT …/file with the version the replace answered (#717's save). A 409, the disk moved since,
 * skips the file; any other refusal fails it; the rest go on either way. Answers both lists of paths. Behind the gate as a save is, so
 * the user's cancel of the gate ends the undo. */
export async function undoReplace(activityId: string, changed: ReplaceAnswer['changed']): Promise<{ skipped: string[]; failed: string[] }> {
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const { path, previous, version } of changed) {
    try {
      await sendJson('PUT', activityPath(activityId, 'file'), { path, text: previous, version, format: false });
    } catch (error) {
      if (error instanceof WriteCancelled) throw error;
      ((error as { status?: number }).status === HTTP_CONFLICT ? skipped : failed).push(path);
    }
  }
  return { skipped, failed };
}
