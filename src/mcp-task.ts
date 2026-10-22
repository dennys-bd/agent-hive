// hive_task's answer (#7): the calling worker's own task as the Hive holds it. Pure, but for the comments, read live on every call as the
// panel's GET /tasks/:id/comments reads them; the registration lives in mcp-optional.ts with the other optional tools
import { resultOf, taskOfWorker } from './activities.js';
import { workerWorkspace } from './mcp-conventions.js';
import type { McpDeps } from './mcp-kit.js';
import { originRepository } from './repos/repositories.js';
import type { BlockerRef, Exec, Item, Source, State, Task, TaskComment, Worker } from './types.js';

/** A task of the tree (#7): its display id, title and stage when the Hive holds it; its itemId alone when it does not. */
export interface TaskRef { id: string; title?: string; stage?: string; closed?: true }
/** A blocker as its source shows it (#56), with the stage of the Hive's task it names. */
export interface TaskBlockerRef extends BlockerRef { stage?: string }
/** The comments half of the answer: read, failed with the source's message, or left out when there are none to read. */
export interface TaskComments { comments?: TaskComment[]; commentsError?: string }
/** The task as hive_task answers it (#7). */
export interface HeldTask extends TaskComments {
  id: string; itemId: string; title: string; body: string; url: string;
  source?: string; workspace?: string; repository?: string;
  stage: string; result?: Record<string, unknown>;
  parent?: TaskRef; children?: TaskRef[];
  blockers?: { blockedBy: TaskBlockerRef[]; blocking: TaskBlockerRef[] };
}
/** null in a session with no task (#256): an answer, not a failure. */
export interface TaskAnswer { task: HeldTask | null }

type Tasks = readonly Task[];
type Live = NonNullable<ReturnType<McpDeps['live']>>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A child closed on its source says so whether or not the Hive still holds it
function refOf(tasks: Tasks, itemId: string, closed: readonly string[] = []): TaskRef {
  const held = tasks.find((t) => t.item.itemId === itemId);
  const ref: TaskRef = held ? { id: held.item.id, title: held.item.title, stage: held.stage } : { id: itemId };
  return closed.includes(itemId) ? { ...ref, closed: true } : ref;
}

// As the details panel names a blocker's stage (#57): the task of the same source under that display id
function blockerOf(tasks: Tasks, source: string | undefined, ref: BlockerRef): TaskBlockerRef {
  const stage = tasks.find((t) => t.item.source === source && t.item.id === ref.id)?.stage;
  return { id: ref.id, title: ref.title, state: ref.state, ...(stage === undefined ? {} : { stage }) };
}

function treeOf(tasks: Tasks, item: Item): Pick<HeldTask, 'parent' | 'children' | 'blockers'> {
  const children = item.children ?? [];
  const named = (refs: readonly BlockerRef[]): TaskBlockerRef[] => refs.map((ref) => blockerOf(tasks, item.source, ref));
  return {
    ...(item.parent === undefined ? {} : { parent: refOf(tasks, item.parent) }),
    ...(children.length === 0 ? {} : { children: children.map((id) => refOf(tasks, id, item.closedChildren)) }),
    ...(item.blockers === undefined ? {} : { blockers: { blockedBy: named(item.blockers.blockedBy), blocking: named(item.blockers.blocking) } }),
  };
}

/** hive_task's answer for `worker` (#7), but for the comments and the repository: a stage run's and a free session's alike, null for a local session. */
export function taskAnswer(state: Pick<State, 'tasks' | 'activityRecords'>, worker: Worker, workspace: string | undefined): TaskAnswer {
  const task = taskOfWorker(state, worker);
  if (!task) return { task: null };
  const { item } = task;
  const result = resultOf(state, item.itemId);
  return {
    task: {
      id: item.id, itemId: item.itemId, title: item.title, body: item.body, url: item.url,
      ...(item.source === undefined ? {} : { source: item.source }), ...(workspace === undefined ? {} : { workspace }),
      stage: task.stage, ...(result === undefined ? {} : { result }), ...treeOf(state.tasks, item),
    },
  };
}

/** The task's comments, read now (#7): none for a task created in the Hive or a source without comments; a source's failure is commentsError, so
 * one failed read never hides the rest of the answer. */
export async function taskComments(source: Pick<Source, 'comments'> | undefined, task: Task): Promise<TaskComments> {
  if (task.created || !source?.comments) return {};
  try {
    return { comments: await source.comments(task.item.itemId) };
  } catch (err) {
    return { commentsError: errorMessage(err) };
  }
}

/** hive_task's whole answer (#7): the pure part, then the workspace's GitHub repository and the task's comments, both read now. */
export async function readTaskAnswer(exec: Exec, live: Live, worker: Worker): Promise<TaskAnswer> {
  const task = taskOfWorker(live.state, worker);
  const workspace = workerWorkspace(live.state, live.config, worker);
  const answer = taskAnswer(live.state, worker, workspace?.name);
  if (!task || answer.task === null) return answer;
  const source = task.item.source === undefined ? undefined : live.sources.get(task.item.source); // the task's own source (#180)
  const [repository, comments] = await Promise.all([originRepository(exec, workspace?.path), taskComments(source, task)]);
  return { task: { ...answer.task, ...(repository === undefined ? {} : { repository }), ...comments } };
}
