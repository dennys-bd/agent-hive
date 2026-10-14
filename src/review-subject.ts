import type { Request, Response } from 'express';
import { localActivityId } from './activities.js';
import { localSessionsOf } from './local-sessions.js';
import { isLocalSession, isTaskSession } from './review-bodies.js';
import type { Deliver, Delivery } from './review-deliver.js';
import { type AgentOf, agentsIn, agentsOf } from './review-message.js';
import type { ReviewStore } from './review-store.js';
import type { State, Task } from './types.js';

// What a review route works on once its target is resolved (#344): a task's review or a workspace's local one. The handlers are written once
// over it, so the two cannot drift; they differ only in the key, the session check, the agents, the delivery and the event.

export interface ReviewSubject {
  key: string; // the store key: an item id, or a workspace name
  guard: string; // the submit guard's key: an item id, or localActivityId(ws)
  store: ReviewStore;
  isSession(id: unknown): id is string; // a recipient this subject may name
  agentOf: AgentOf;
  deliver(to: string, text: string): Promise<Delivery>;
  notify(): void; // the review event
}

/** What the file and draft routes need of a subject: they deliver nothing. */
export type StoreSubject = Pick<ReviewSubject, 'key' | 'store' | 'isSession' | 'notify'>;

/** A route's subject, or undefined once its refusal (409, 404) is out. */
export type SubjectOf<S> = (req: Request, res: Response) => S | undefined;

export interface TaskReviewDeps { reviews: ReviewStore; notifyReview(taskId: string): void }
export interface LocalReviewDeps { localReviews: ReviewStore; notifyLocalReview(workspace: string): void; deliverLocal: Deliver }

type SessionState = Pick<State, 'activityRecords' | 'defaultAgent'>;

/** A task's review file (#591): its sessions, its event. */
export function taskStoreSubject(deps: TaskReviewDeps, state: SessionState, task: Task): StoreSubject {
  const key = task.item.itemId;
  return { key, store: deps.reviews, isSession: (id: unknown): id is string => isTaskSession(state, key, id), notify: () => deps.notifyReview(key) };
}

/** A task's review (#591), with its sessions' agents and its delivery. */
export function taskSubject(deps: TaskReviewDeps & { deliver: Deliver }, state: SessionState, task: Task): ReviewSubject {
  const key = task.item.itemId;
  return { ...taskStoreSubject(deps, state, task), guard: key, agentOf: agentsOf(state, key), deliver: (to, text) => deps.deliver(key, to, text) };
}

/** A workspace's local review (#344): its local record's sessions, delivered in its main checkout. The guard is the local activity id, a
 * `local:` key no message id meets. */
export function localSubject(deps: LocalReviewDeps, state: SessionState, workspace: string): ReviewSubject {
  return {
    key: workspace,
    guard: localActivityId(workspace),
    store: deps.localReviews,
    isSession: (id: unknown): id is string => isLocalSession(state, workspace, id),
    agentOf: agentsIn(state, localSessionsOf(state, workspace)),
    deliver: (to, text) => deps.deliverLocal(workspace, to, text),
    notify: () => deps.notifyLocalReview(workspace),
  };
}
