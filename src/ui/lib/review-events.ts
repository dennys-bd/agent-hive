// The review events (#591, #592): useHiveState's one EventSource hears them; every open pane listens here instead of opening a stream of its own.
function channel(): { on(listener: (key: string) => void): () => void; emit(key: string): void } {
  const listeners = new Set<(key: string) => void>();
  return {
    on: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit: (key) => { for (const listener of listeners) listener(key); },
  };
}

const review = channel(); // a task's review file changed: its item id
const prReview = channel(); // a PR's review file changed, or a write reached GitHub (#592): its link
const readModel = channel(); // #765 spike: a repository's rows changed in the read model: its owner/name

export const onReviewEvent = (listener: (taskId: string) => void): (() => void) => review.on(listener);
export const emitReviewEvent = (taskId: string): void => review.emit(taskId);
export const onPrReviewEvent = (listener: (url: string) => void): (() => void) => prReview.on(listener);
export const emitPrReviewEvent = (url: string): void => prReview.emit(url);
export const onReadModelEvent = (listener: (repository: string) => void): (() => void) => readModel.on(listener);
export const emitReadModelEvent = (repository: string): void => readModel.emit(repository);
