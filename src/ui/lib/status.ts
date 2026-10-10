// What the flow task's tile and the footer's chips share about a status (#164, #216, #229): its border, its tint, and which one wins
// when a task runs several sessions at once.
import type { Worker, Status } from '../../types.js';

/** A task's state (#663, #727): its sessions' status, or new before it has an activity. Neutral: new reads like empty in every colour. */
export type TaskState = Status | 'new';

export const STATUS_BORDER: Record<TaskState, string> = { new: 'border-empty', empty: 'border-empty', working: 'border-working', waiting: 'border-waiting', review: 'border-review', approval: 'border-approval', backoff: 'border-backoff' };

/** A session segment's own fill (#229): --color-<status> at 20% (index.css). Literal per-status strings, not built from a
 * template, so Tailwind's scanner picks up every class. */
export const STATUS_TINT: Record<TaskState, string> = { new: 'bg-empty/20', empty: 'bg-empty/20', working: 'bg-working/20', waiting: 'bg-waiting/20', review: 'bg-review/20', approval: 'bg-approval/20', backoff: 'bg-backoff/20' };

// Worst first: a session blocked on the user outranks a held approval (which has its own deadline), which outranks a review,
// which outranks a run waiting out an API error (#805: it needs nobody but is not moving), which outranks a run still working. Never 'empty': mostUrgent answers that itself when there is no occupied worker.
const RANK: Exclude<Status, 'empty'>[] = ['waiting', 'approval', 'review', 'backoff', 'working'];

/** The one status a task with several sessions shows as its own (#229): the worst of its occupied workers, or 'empty' with none.
 * What the flow task's tile and the footer's fused chip both border themselves with. */
export function mostUrgent(workers: Worker[]): Status {
  const present = new Set(workers.map((worker) => worker.status));
  return RANK.find((status) => present.has(status)) ?? 'empty';
}

/** A status's place in the urgency order (#759): RANK's, and after all of them for empty, so a sleeping session sorts last. */
export const urgencyIndex = (status: Status): number => (status === 'empty' ? RANK.length : RANK.indexOf(status));

/** A status as a solid dot (redesign 08): the home's rows show the status as a dot and its word. */
export const STATUS_DOT: Record<TaskState, string> = { new: 'bg-empty', empty: 'bg-empty', working: 'bg-working', waiting: 'bg-waiting', review: 'bg-review', approval: 'bg-approval', backoff: 'bg-backoff' };

/** A status word in its own colour (redesign 08); a stopped one stays muted, as its grey would not read as text. */
export const STATUS_TEXT: Record<TaskState, string> = { new: 'text-muted-foreground', empty: 'text-muted-foreground', working: 'text-working', waiting: 'text-waiting', review: 'text-review', approval: 'text-approval', backoff: 'text-backoff' };
