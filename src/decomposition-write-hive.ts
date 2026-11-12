// A decomposition written as hive tasks (#783): what the route asks of the hive target (the entries `entra em` offers, the suggested one, the
// stage an entry names, an origin already taken), and the write itself. Pure of Node and GitHub: the route checks the body and delivers.
import { ROOT_KEY, designLink, issueBody } from './decomposition.js';
import { parentOf } from './decomposition-check.js';
import { flowOf } from './flows.js';
import { exitOf } from './transitions.js';
import { END, HIVE_EPIC, type Decomposition, type Flow, type HiveEvent, type State, type Task, type TaskEntry } from './types.js';

/** What `entra em` offers (#783, decision 2): outside the flow, then each flow followed by each of its stages. */
export const hiveEntries = (flows: readonly Flow[]): TaskEntry[] =>
  [null, ...flows.flatMap((f): TaskEntry[] => [{ flow: f.name }, ...f.stages.map((s) => ({ flow: f.name, stage: s.name }))])];

/** The suggested entry (#783, decision 3): the goal moves by its approve, and an epic follows only children of its own flow, so the children
 * start in the flow its approved exit leads to; that exit being END or absent, the goal's own flow; a goal outside the flow, the first. */
export function suggestedEntry(state: Pick<State, 'flows' | 'stages' | 'transitions'>, goal: Pick<Task, 'stage'>): TaskEntry | undefined {
  const exit = goal.stage === undefined ? undefined : exitOf(state, goal.stage, 'approved');
  const landing = exit === undefined || exit.to === END ? undefined : flowOf(state.flows, exit.to);
  const flow = landing ?? flowOf(state.flows, goal.stage) ?? state.flows[0];
  return flow === undefined ? undefined : { flow: flow.name };
}

/** The stage an entry names (#783, decision 7): createTask takes a stage name. */
export const entryStage = (flows: readonly Flow[], entry: TaskEntry): string | undefined =>
  (entry === null ? undefined : entry.stage ?? flows.find((f) => f.name === entry.flow)?.stages[0]?.name);

/** Whether a GitHub goal's root task would point at an item a hive task already holds (#783, decision 9): adopting it, or a second task on
 * the same item, would both go unseen. Skipped once root is recorded, so the write resumes. */
export const originTaken = (state: Pick<State, 'tasks'>, goal: Task, recorded: Readonly<Record<string, number>>): boolean =>
  goal.item.source !== undefined && recorded[ROOT_KEY] === undefined && state.tasks.some((t) => t.item.origin === goal.item.itemId);

export interface HiveWriteDeps {
  dispatch(event: HiveEvent): Promise<unknown>;
  latest(): State | undefined; // the state after each dispatch: what a step is checked in
  record(id: string, number: number): Promise<void>; // the route's decompositionIssue, done before the next step
}
/** A GitHub goal's root task (#783, decision 9): its title, rootBody, its link and its item as origin. */
export interface HiveRoot { title: string; body: string; url: string; origin: string }
/** Where the tree goes (#783): under the goal, or under a root task made from it; at the entry's stage (none: outside the flow), in the goal's
 * workspace; address only when the file is delivered (decision 14). prefix: createTask's, which State does not hold. */
export interface HiveWriteTarget { goal: Task; prefix: string; root?: HiveRoot; stage?: string; workspace?: string; address?: string }
/** The root's itemId once every step landed, else the first step's fixed words (#783, decision 16): what was recorded stays. */
export type HiveWriteOutcome = { root: string } | { error: string };

export const NOT_CREATED_MESSAGE = 'a task of the decomposition was not created: its stage or its parent is gone';
export const NOT_BLOCKED_MESSAGE = 'a blocker of the decomposition was not written: one of its tasks is gone';

interface Made { itemId: string; id: string } // a task of the tree: what a child names as its parent and a blocker as its ref
type CreateFields = Pick<HiveRoot, 'title' | 'body'> & Partial<Pick<HiveRoot, 'url' | 'origin'>>;

const local = (n: number): string => `local:${n}`;
const taskIn = (deps: HiveWriteDeps, itemId: string): Task | undefined => deps.latest()?.tasks.find((t) => t.item.itemId === itemId);
const madeOf = ({ item }: Task): Made => ({ itemId: item.itemId, id: item.id });

// A step recorded before: its task as the state holds it now. One gone keeps the id createTask gave it, so what depends on it stops there
function known(deps: HiveWriteDeps, t: HiveWriteTarget, n: number): Made {
  const task = taskIn(deps, local(n));
  return task === undefined ? { itemId: local(n), id: `${t.prefix}-${n}` } : madeOf(task);
}

// One createTask, checked and recorded. The number is read right before, as createInHive reads it: dispatch reduces before its first await.
// An inner node or a root task is born an epic, so the fill never starts it, even in this reduction
async function create(deps: HiveWriteDeps, t: HiveWriteTarget, key: string, fields: CreateFields, links: { parent?: string; epic: boolean }): Promise<Made> {
  const n = (deps.latest()?.localCount ?? 0) + 1;
  await deps.dispatch({
    type: 'createTask', ...fields, prefix: t.prefix, auto: true, // decision 8: born auto, at the entry, in the goal's workspace, no label
    ...(t.stage === undefined ? {} : { stage: t.stage }), ...(t.workspace === undefined ? {} : { workspace: t.workspace }),
    ...(links.parent === undefined ? {} : { parent: links.parent }), ...(links.epic ? { epic: HIVE_EPIC } : {}),
  });
  // a removed stage leaves no task; a parent gone leaves one with no parent (#782): neither is the tree's
  const task = taskIn(deps, local(n));
  if (task === undefined || task.item.parent !== links.parent) throw new Error(NOT_CREATED_MESSAGE);
  await deps.record(key, n);
  return madeOf(task);
}

async function rootOf(deps: HiveWriteDeps, t: HiveWriteTarget, recorded: Readonly<Record<string, number>>): Promise<Made> {
  if (t.root === undefined) return madeOf(t.goal);
  const n = recorded[ROOT_KEY];
  return n === undefined ? create(deps, t, ROOT_KEY, t.root, { epic: true }) : known(deps, t, n);
}

const madeAt = (made: ReadonlyMap<string, Made>, id: string): Made => {
  const found = made.get(id);
  if (found === undefined) throw new Error(`no task for node ${id}`);
  return found;
};

// Every node in file order: the parser refuses a node before its parent, so the parent's task is known when its child is created
async function createAll(deps: HiveWriteDeps, d: Decomposition, t: HiveWriteTarget, recorded: Readonly<Record<string, number>>, root: Made): Promise<Map<string, Made>> {
  const inner = new Set(d.nodes.map((node) => parentOf(node.id)));
  const made = new Map<string, Made>();
  for (const node of d.nodes) {
    const n = recorded[node.id];
    const parentId = parentOf(node.id);
    const parent = parentId === '' ? root : madeAt(made, parentId);
    const design = t.address === undefined ? {} : { design: designLink(d, node, t.address) }; // #741: a file that stays local is linked by nothing
    const body = issueBody(node, { parent: parent.id, ...design });
    made.set(node.id, n !== undefined ? known(deps, t, n) : await create(deps, t, node.id, { title: node.title, body }, { parent: parent.itemId, epic: inner.has(node.id) }));
  }
  return made;
}

// blockerSet ignores a relation already as asked, so a replay lands each edge once
async function block(deps: HiveWriteDeps, task: Made, blocker: Made): Promise<void> {
  await deps.dispatch({ type: 'blockerSet', itemId: task.itemId, change: { action: 'add', kind: 'blockedBy', ref: blocker.id } });
  if (!(taskIn(deps, task.itemId)?.item.blockers?.blockedBy.some((r) => r.id === blocker.id) ?? false)) throw new Error(NOT_BLOCKED_MESSAGE);
}

/** The hive write (#783, decision 10), skipping the keys `recorded` holds: the root, every node in file order, inner nodes and a created root
 * born epics, then one blocker per edge, run again on a replay and idempotent. A hive goal is stamped by the route at the end (decision 11). */
export async function writeHiveDecomposition(deps: HiveWriteDeps, d: Decomposition, t: HiveWriteTarget, recorded: Readonly<Record<string, number>>): Promise<HiveWriteOutcome> {
  try {
    const root = await rootOf(deps, t, recorded);
    const made = await createAll(deps, d, t, recorded, root);
    for (const node of d.nodes) for (const blocker of node.blockedBy) await block(deps, madeAt(made, node.id), madeAt(made, blocker));
    return { root: root.itemId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
