// The decomposition write's state (#781), above the dialog so the write outlives its mount: per activity, whether its dialog is open, whether a
// write runs and how the last one failed. Module state, as use-repositories.ts: each window has its own store, so each window hosts its own dialog.
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { HIVE_SOURCE } from '../../tasks';
import type { TaskEntry } from '../../types';

/** What the dialog posts (#865): a GitHub source and its column, or the hive and the entry its tasks start at (#784, decision 7): entry absent =
 * not chosen yet, null = outside the flow. Posted as is, so the hive's is { source: 'hive', entry }. */
export interface DecompositionChoice { source?: string; column?: string; entry?: TaskEntry }
export interface DecompositionWrite { isOpen: boolean; isRunning: boolean; error?: string; ref: string; choice?: DecompositionChoice }

// refuseWrite in server-decomposition.ts: the write started and failed, so issues may already exist. Every other refusal wrote nothing
const HTTP_BAD_GATEWAY = 502;
const ENDS_SENTENCE = /[.!?]$/;
// #783, decision 16: a hive write that failed midway; its words went to hive.log
const HIVE_CODE = 'hive';
const isHive = (choice?: DecompositionChoice): boolean => choice?.source === HIVE_SOURCE;
const IDLE: DecompositionWrite = { isOpen: false, isRunning: false, ref: '' };

let writes: Readonly<Record<string, DecompositionWrite>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const notify = (): void => { for (const listener of listeners) listener(); };
const writeOf = (activityId: string): DecompositionWrite => writes[activityId] ?? IDLE;
function update(activityId: string, change: Partial<DecompositionWrite>): void {
  writes = { ...writes, [activityId]: { ...writeOf(activityId), ...change } };
  notify();
}

// #702: a transient failure has nothing useful in gh's words, so its own copy (which already says created issues stay) replaces them; only a
// 502 can leave created issues behind, so only it promises they stay. #784: a hive write's own failure has fixed copy, chosen by the write's
// target, since the store maps it with no dialog mounted
function failureText(err: unknown, hive: boolean): string {
  if (!(err instanceof Error)) return String(err);
  const { code, status } = err as Error & { code?: unknown; status?: unknown };
  if (hive && code === HIVE_CODE) return t('decomposition.hiveFailed');
  if (code === 'transient') return t('decomposition.transient');
  if (status !== HTTP_BAD_GATEWAY) return err.message;
  return `${err.message}${ENDS_SENTENCE.test(err.message) ? '' : '.'} ${t('decomposition.recover')}`;
}

// The same text the dialog would show inline; reabrir brings the dialog back with it
// One toast per activity (its id), dismissed when the dialog comes back, so two failures never stack
const toastId = (activityId: string): string => `decomposition-${activityId}`;
function toastFailure(activityId: string, description: string): void {
  const { ref, choice } = writeOf(activityId);
  const title = t(isHive(choice) ? 'decomposition.failedTitleHive' : 'decomposition.failedTitle', { ref }); // #784: the write's own target
  toast.error(title, { id: toastId(activityId), description, action: { label: t('decomposition.reopen'), onClick: () => openDecomposition(activityId, ref) } });
}

/** Opens the activity's dialog (#781), keeping a running write and the last error. One dialog per window: any other open one closes, so its
 * write's failure toasts. */
export function openDecomposition(activityId: string, ref: string): void {
  const others = Object.fromEntries(Object.entries(writes).map(([id, write]) => [id, write.isOpen ? { ...write, isOpen: false } : write]));
  writes = { ...others, [activityId]: { ...writeOf(activityId), isOpen: true, ref } };
  toast.dismiss(toastId(activityId));
  notify();
}

/** Closes the activity's dialog; a write in flight goes on and its promise still settles. */
export function closeDecomposition(activityId: string): void {
  if (writes[activityId] !== undefined) update(activityId, { isOpen: false });
}

/** POST /activities/:id/decomposition (#865), owned here so it outlives the dialog (#781). Never rejects. A second start while one runs posts
 * nothing; a success closes the dialog and shows nothing; a failure is kept as text, and toasted when the dialog is closed by then. */
export async function writeDecomposition(activityId: string, choice: DecompositionChoice): Promise<void> {
  if (writeOf(activityId).isRunning) return;
  // the choice is kept so a reopened dialog shows, and a second press resumes, the write it started (a default would send it elsewhere)
  update(activityId, { isRunning: true, error: undefined, choice });
  try {
    await postJson(`/activities/${encodeURIComponent(activityId)}/decomposition`, choice);
    update(activityId, { isRunning: false, isOpen: false });
  } catch (err) {
    const error = failureText(err, isHive(choice));
    update(activityId, { isRunning: false, error });
    if (!writeOf(activityId).isOpen) toastFailure(activityId, error);
  }
}

/** The choice the activity's last write started with (source and column, or the hive and its entry), if any: the dialog's choice on its open. */
export const lastChoice = (activityId: string): DecompositionChoice | undefined => writes[activityId]?.choice;

/** The activity's write, as the store holds it. */
export const useDecompositionWrite = (activityId: string): DecompositionWrite => useSyncExternalStore(subscribe, () => writeOf(activityId));

const openOf = (): string | undefined => Object.keys(writes).find((id) => writes[id]?.isOpen === true);
/** The activity whose dialog is open in this window, if any. */
export const useOpenDecomposition = (): string | undefined => useSyncExternalStore(subscribe, openOf);

/** Tests only: no write, no dialog open. */
export function resetDecompositionWrites(): void {
  writes = {};
}
