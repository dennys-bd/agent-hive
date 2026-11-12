// The decomposition write's state (#781), above the dialog so the write outlives its mount: per activity, whether its dialog is open, whether a
// write runs and how the last one failed. Module state, as use-repositories.ts: each window has its own store, so each window hosts its own dialog.
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

export interface DecompositionChoice { source?: string; column?: string }
export interface DecompositionWrite { isOpen: boolean; isRunning: boolean; error?: string; ref: string }

// refuseWrite in server-decomposition.ts: the write started and failed, so issues may already exist. Every other refusal wrote nothing
const HTTP_BAD_GATEWAY = 502;
const ENDS_SENTENCE = /[.!?]$/;
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
// 502 can leave created issues behind, so only it promises they stay
function failureText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, status } = err as Error & { code?: unknown; status?: unknown };
  if (code === 'transient') return t('decomposition.transient');
  if (status !== HTTP_BAD_GATEWAY) return err.message;
  return `${err.message}${ENDS_SENTENCE.test(err.message) ? '' : '.'} ${t('decomposition.recover')}`;
}

// The same text the dialog would show inline; reabrir brings the dialog back with it
function toastFailure(activityId: string, description: string): void {
  const { ref } = writeOf(activityId);
  toast.error(t('decomposition.failedTitle', { ref }), { description, action: { label: t('decomposition.reopen'), onClick: () => openDecomposition(activityId, ref) } });
}

/** Opens the activity's dialog (#781), keeping a running write and the last error. One dialog per window: any other open one closes, so its
 * write's failure toasts. */
export function openDecomposition(activityId: string, ref: string): void {
  const others = Object.fromEntries(Object.entries(writes).map(([id, write]) => [id, write.isOpen ? { ...write, isOpen: false } : write]));
  writes = { ...others, [activityId]: { ...writeOf(activityId), isOpen: true, ref } };
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
  update(activityId, { isRunning: true, error: undefined });
  try {
    await postJson(`/activities/${encodeURIComponent(activityId)}/decomposition`, choice);
    update(activityId, { isRunning: false, isOpen: false });
  } catch (err) {
    const error = failureText(err);
    update(activityId, { isRunning: false, error });
    if (!writeOf(activityId).isOpen) toastFailure(activityId, error);
  }
}

/** The activity's write, as the store holds it. */
export const useDecompositionWrite = (activityId: string): DecompositionWrite => useSyncExternalStore(subscribe, () => writeOf(activityId));

const openOf = (): string | undefined => Object.keys(writes).find((id) => writes[id]?.isOpen === true);
/** The activity whose dialog is open in this window, if any. */
export const useOpenDecomposition = (): string | undefined => useSyncExternalStore(subscribe, openOf);

/** Tests only: no write, no dialog open. */
export function resetDecompositionWrites(): void {
  writes = {};
}
