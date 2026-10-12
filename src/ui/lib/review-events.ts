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

const review = channel<string>(); // a task's review file changed: its item id
const prReview = channel<string>(); // a PR's review file changed, or a write reached GitHub (#592): its link
const readModel = channel<ReadModelChange>(); // a sync changed a repository's rows in the read model (#182)

export const onReviewEvent = (listener: (taskId: string) => void): (() => void) => review.on(listener);
export const emitReviewEvent = (taskId: string): void => review.emit(taskId);
export const onPrReviewEvent = (listener: (url: string) => void): (() => void) => prReview.on(listener);
export const emitPrReviewEvent = (url: string): void => prReview.emit(url);
export const onReadModelEvent = (listener: (change: ReadModelChange) => void): (() => void) => readModel.on(listener);
export const emitReadModelEvent = (change: ReadModelChange): void => readModel.emit(change);
