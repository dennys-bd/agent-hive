import type { BlockerChange, BlockerRef, HiveEvent, ItemBlockers, State, Task } from './types.js';

/** Why a hive relation cannot be written (#56): the route answers each with its code, the reducer leaves the state as it is. */
export type BlockerProblem = 'unknownItem' | 'unknownRef' | 'crossSource' | 'self' | 'cycle';

type Kind = BlockerChange['kind'];
const NONE: ItemBlockers = { blockedBy: [], blocking: [] };
const MIRROR: Record<Kind, Kind> = { blockedBy: 'blocking', blocking: 'blockedBy' }; // A blocked by B is B blocking A

const isHive = (task: Task): boolean => task.item.source === undefined;
const hasRef = (task: Task, kind: Kind, id: string): boolean => (task.item.blockers ?? NONE)[kind].some((r) => r.id === id);
// A hive task as the other end of a relation: open while it is in the state
const refTo = (task: Task): BlockerRef => ({ id: task.item.id, title: task.item.title, state: 'open' });

// The item by its itemId; the ref by display id, a hive task first, so a source's task shown under the same id never shadows it
function pairOf(tasks: readonly Task[], itemId: string, ref: string): { task?: Task; other?: Task } {
  return { task: tasks.find((t) => t.item.itemId === itemId), other: tasks.find((t) => isHive(t) && t.item.id === ref) ?? tasks.find((t) => t.item.id === ref) };
}

/** What stops a hive relation (#56), undefined when it can be written. A cycle is only the reverse of an existing relation: two tasks that
 * each wait for the other would never start, and GitHub refuses the same. */
export function blockerProblem(tasks: readonly Task[], itemId: string, change: BlockerChange): BlockerProblem | undefined {
  const { task, other } = pairOf(tasks, itemId, change.ref);
  if (task === undefined || !isHive(task)) return 'unknownItem';
  // A closed ref to a task that left the Hive is still removable, from this end only, as GitHub removes a closed blocker
  if (other === undefined) return change.action === 'remove' && hasRef(task, change.kind, change.ref) ? undefined : 'unknownRef';
  if (!isHive(other)) return 'crossSource';
  if (other === task) return 'self';
  return change.action === 'add' && hasRef(task, MIRROR[change.kind], other.item.id) ? 'cycle' : undefined;
}

// The task with these relations. Its start gate is the ids of its open blocked-by refs, absent when none, as the GitHub adapter leaves it
function withRelations(task: Task, blockers: ItemBlockers): Task {
  const { blockedBy: _gate, ...item } = task.item;
  const open = blockers.blockedBy.filter((r) => r.state === 'open').map((r) => r.id);
  return { ...task, item: { ...item, blockers, ...(open.length > 0 ? { blockedBy: open } : {}) } };
}

// One end of the relation: `ref` added to or removed from the task's `kind` list
function edited(task: Task, kind: Kind, ref: BlockerRef, action: BlockerChange['action']): Task {
  const current = task.item.blockers ?? NONE;
  const kept = current[kind].filter((r) => r.id !== ref.id);
  const next = action === 'add' ? [...kept, ref] : kept;
  return withRelations(task, kind === 'blockedBy' ? { ...current, blockedBy: next } : { ...current, blocking: next });
}

/** blockerSet (#56): the relation written on both hive tasks, A blocked by B as B blocking A. A problem, or a relation already as asked,
 * returns the state itself: the route checked first, so here it is a race or a double click. */
export function blockerSet(state: State, { itemId, change }: Extract<HiveEvent, { type: 'blockerSet' }>): State {
  const { task, other } = pairOf(state.tasks, itemId, change.ref);
  if (task === undefined || blockerProblem(state.tasks, itemId, change) !== undefined) return state;
  if (other === undefined) { // the closed ref of a task that left: only this end remains to edit
    const kept = edited(task, change.kind, { id: change.ref, title: '', state: 'closed' }, 'remove');
    return { ...state, tasks: state.tasks.map((t) => (t === task ? kept : t)) };
  }
  if (hasRef(task, change.kind, other.item.id) === (change.action === 'add')) return state;
  const swapped = new Map([
    [task, edited(task, change.kind, refTo(other), change.action)],
    [other, edited(other, MIRROR[change.kind], refTo(task), change.action)],
  ]);
  return { ...state, tasks: state.tasks.map((t) => swapped.get(t) ?? t) };
}

/** #56: a hive task that left the state stays on the other end of each of its relations as a closed ref, its title kept, as GitHub shows a
 * closed blocker; the start gates it held drop it. A source's task is never a hive ref: the tasks come back as they are. */
export function closeRefsTo(tasks: Task[], dropped: Task): Task[] {
  if (!isHive(dropped)) return tasks;
  const id = dropped.item.id;
  const closed = (list: BlockerRef[]): BlockerRef[] => list.map((r): BlockerRef => (r.id === id ? { ...r, state: 'closed' } : r));
  return tasks.map((t) => {
    const b = t.item.blockers;
    if (!isHive(t) || b === undefined || ![...b.blockedBy, ...b.blocking].some((r) => r.id === id)) return t;
    return withRelations(t, { blockedBy: closed(b.blockedBy), blocking: closed(b.blocking) });
  });
}
