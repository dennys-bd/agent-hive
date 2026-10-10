// The bases a file's changes compare against (#668), by `<activityId>:<path>`: the text the editor pane's gutter marks and the changes pane
// diff the buffer with. Module level, as editor-models.ts is, so a file's two panes share one entry. The pick between HEAD and the task's base
// is the viewer's, kept in the view state like the split edge (#536), never a setting.
import { isLocalActivityId } from '../../activities';
import type { ChangesBase, FileBase } from '../../types';
import { readView, writeView } from '@/lib/view-state';

interface Entry { activityId: string; base: FileBase }
interface Ask { activityId: string; n: number }

const entries = new Map<string, Entry>();
const asks = new Map<string, Ask>(); // the latest refresh per key: an answer older than it, or landing after a close, is dropped
const failed = new Set<string>(); // keys whose latest answer failed: with no base held, the pane stops waiting
const listeners = new Set<() => void>();

const keyOf = (activityId: string, path: string): string => `${activityId}:${path}`;
const notify = (): void => {
  for (const listener of listeners) listener();
};

// The stored picks: only the task base is stored, HEAD being the default; anything else reads as none.
// ponytail: a pick stays after its file's tabs close, one entry per file the viewer ever moved to the task base; prune it if that grows
function storedPicks(): Record<string, 'task'> {
  const value = readView('changesBase');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, pick]) => (pick === 'task' ? [[key, 'task'] as const] : [])));
}

/** The base the file compares against (#668): the viewer's pick, HEAD unless it picked the task's base; always HEAD on a local activity, which
 * has no task. */
export const chosenBase = (activityId: string, path: string): ChangesBase =>
  (!isLocalActivityId(activityId) && storedPicks()[keyOf(activityId, path)] === 'task' ? 'task' : 'head');

/** The base the store holds for the file (#668); undefined before its first answer. */
export const baseOf = (activityId: string, path: string): FileBase | undefined => entries.get(keyOf(activityId, path))?.base;

/** Whether the file's latest base answer failed (#668): a refusal, a daemon away or a body that is no base. */
export const hasFailed = (activityId: string, path: string): boolean => failed.has(keyOf(activityId, path));

/** Called on every change of a base or a pick (#668); returns the unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The route's answer checked: untrusted JSON until it has FileBase's shape
function isFileBase(value: unknown): value is FileBase {
  if (typeof value !== 'object' || value === null) return false;
  const { against, label, oid, text } = value as Record<string, unknown>;
  const isOptionalText = (field: unknown): boolean => field === undefined || typeof field === 'string';
  return (against === 'head' || against === 'task') && typeof label === 'string' && isOptionalText(oid) && isOptionalText(text);
}

// Monaco holds a buffer's leading BOM apart from its text, so a base that kept it inline would read line 1 as modified and a revert would
// write it back into the buffer
const withoutBom = (answer: FileBase): FileBase => (answer.text?.startsWith('\uFEFF') ? { ...answer, text: answer.text.slice(1) } : answer);

// What the store keeps of an answer: one without text over the blob it holds keeps that text, with the answer's label
function merged(held: FileBase | undefined, answer: FileBase): FileBase {
  const isSameBlob = held !== undefined && answer.text === undefined && answer.against === held.against && answer.oid !== undefined && answer.oid === held.oid;
  return isSameBlob ? { ...held, label: answer.label } : answer;
}

/** Asks the route for the file's base (#668), with the blob id held for the same pick, so an unchanged base answers without its text. A
 * refusal, a failure or an answer older than the latest ask leaves the entry as it is: the next poll asks again. */
export async function refresh(activityId: string, path: string): Promise<void> {
  const key = keyOf(activityId, path);
  const against = chosenBase(activityId, path);
  const held = entries.get(key)?.base;
  const oid = held?.against === against ? held.oid : undefined;
  const mine = (asks.get(key)?.n ?? 0) + 1;
  asks.set(key, { activityId, n: mine });
  const query = new URLSearchParams({ path, against, ...(oid === undefined ? {} : { oid }) });
  const answer: unknown = await fetch(`/activities/${encodeURIComponent(activityId)}/file-base?${query}`)
    .then((res) => (res.ok ? res.json() : undefined))
    .catch(() => undefined); // the daemon away or a body that is no JSON: the last answer stands
  if (asks.get(key)?.n !== mine) return;
  if (!isFileBase(answer)) {
    if (!failed.has(key)) {
      failed.add(key);
      notify();
    }
    return;
  }
  const wasFailed = failed.delete(key);
  const next = merged(entries.get(key)?.base, withoutBom(answer));
  if (JSON.stringify(next) === JSON.stringify(entries.get(key)?.base)) {
    if (wasFailed) notify();
    return;
  }
  entries.set(key, { activityId, base: next });
  notify();
}

/** The viewer's pick for the file (#668): kept in the view state (HEAD by dropping the stored pick), then the base asked again. */
export function choose(activityId: string, path: string, against: ChangesBase): void {
  const key = keyOf(activityId, path);
  const rest = Object.fromEntries(Object.entries(storedPicks()).filter(([stored]) => stored !== key));
  writeView('changesBase', against === 'task' ? { ...rest, [key]: against } : rest);
  notify();
  void refresh(activityId, path);
}

/** A file the tree renamed or moved (#818): everything held under its old path (the base, the latest ask, a failure, the task pick) is
 *  re-keyed to the new one, as editor-models.renamed does the buffer. An answer in flight for the old path then finds no ask and is dropped. */
export function moved(activityId: string, from: string, to: string): void {
  const [was, now] = [keyOf(activityId, from), keyOf(activityId, to)];
  const entry = entries.get(was);
  const ask = asks.get(was);
  const picks = storedPicks();
  const isPicked = picks[was] === 'task';
  const isFailed = failed.delete(was);
  if (entry === undefined && ask === undefined && !isPicked && !isFailed) return;
  entries.delete(was);
  asks.delete(was);
  if (entry !== undefined) entries.set(now, entry);
  if (ask !== undefined) asks.set(now, ask);
  if (isFailed) failed.add(now);
  if (isPicked) writeView('changesBase', Object.fromEntries([...Object.entries(picks).filter(([key]) => key !== was), [now, 'task']]));
  notify();
}

/** The file's base forgotten (#668), with the last tab that shows the file, as editor-models.close. */
export function close(activityId: string, path: string): void {
  const key = keyOf(activityId, path);
  asks.delete(key);
  failed.delete(key);
  if (entries.delete(key)) notify();
}

/** Every base of an activity no longer listed goes (#668), as editor-models.closeExcept. */
export function closeExcept(liveIds: ReadonlySet<string>): void {
  for (const [key, ask] of [...asks]) {
    if (!liveIds.has(ask.activityId)) {
      asks.delete(key);
      failed.delete(key);
    }
  }
  for (const [key, entry] of [...entries]) {
    if (!liveIds.has(entry.activityId)) entries.delete(key);
  }
  notify();
}
