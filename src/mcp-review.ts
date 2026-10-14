import { localWorkspaceOf, taskOfWorker } from './activities.js';
import type { ReviewStore } from './review-store.js';
import type { State, Worker } from './types.js';

// Where hive_reply looks a conversation up (#591, #344): a task's session in its task's review, a local session in its workspace's local
// review. The worker names its activity, so neither ever reaches the other's file.

export type ReviewAccess = Pick<ReviewStore, 'read' | 'update'>;

/** The review files hive_reply reads and writes, and the event each write sends. */
export interface ReplyReviews {
  reviews: ReviewAccess; // a task's review file (#591)
  notifyReview(taskId: string): void;
  localReviews: ReviewAccess; // a workspace's local review file (#344)
  notifyLocalReview(workspace: string): void;
}

/** The review a worker's session answers in: its file's store and key, and the event its write sends. */
export interface WorkerReview { store: ReviewAccess; key: string; notify(): void }

/** The worker's task's review; with no task, its local activity's workspace's; undefined for anything else. */
export function workerReview(deps: ReplyReviews, state: Pick<State, 'tasks' | 'activityRecords'>, worker: Worker): WorkerReview | undefined {
  const taskId = taskOfWorker(state, worker)?.item.itemId;
  if (taskId !== undefined) return { store: deps.reviews, key: taskId, notify: () => deps.notifyReview(taskId) };
  const workspace = worker.activityId === undefined ? undefined : localWorkspaceOf(worker.activityId);
  return workspace === undefined ? undefined : { store: deps.localReviews, key: workspace, notify: () => deps.notifyLocalReview(workspace) };
}
