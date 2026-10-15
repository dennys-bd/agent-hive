// The review events (#591, #592) and the read model's (#182): useHiveState's one EventSource hears them; every open pane listens here
// instead of opening a stream of its own.
function channel<T>(): { on(listener: (value: T) => void): () => void; emit(value: T): void } {
  const listeners = new Set<(value: T) => void>();
  return {
    on: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit: (value) => { for (const listener of listeners) listener(value); },
  };
}

/** What the daemon's readModel event says (#182): the repository whose stored rows changed, and the kinds of rows. `kinds` stays a plain
 * string list: the page does not import the daemon's SyncKind, and an unknown kind matches no view. */
export interface ReadModelChange { repository: string; kinds: string[] }

/** A review by its route base (#345): a task's, `/tasks/<id>`, or a workspace's local one, `/workspaces/<name>` (#344). The two route
 * families differ only in that prefix, so the key is the whole difference; the review event carries it too, so a local event refreshes
 * only its workspace's panes. */
export type ReviewKey = `/tasks/${string}` | `/workspaces/${string}`;
export const taskReview = (itemId: string): ReviewKey => `/tasks/${encodeURIComponent(itemId)}`;
export const localReview = (workspace: string): ReviewKey => `/workspaces/${encodeURIComponent(workspace)}`;

const review = channel<ReviewKey>(); // a review file changed: its key (#591, #345)
const prReview = channel<string>(); // a PR's review file changed, or a write reached GitHub (#592): its link
const readModel = channel<ReadModelChange>(); // a sync changed a repository's rows in the read model (#182)

export const onReviewEvent = (listener: (key: ReviewKey) => void): (() => void) => review.on(listener);
export const emitReviewEvent = (key: ReviewKey): void => review.emit(key);
export const onPrReviewEvent = (listener: (url: string) => void): (() => void) => prReview.on(listener);
export const emitPrReviewEvent = (url: string): void => prReview.emit(url);
export const onReadModelEvent = (listener: (change: ReadModelChange) => void): (() => void) => readModel.on(listener);
export const emitReadModelEvent = (change: ReadModelChange): void => readModel.emit(change);
