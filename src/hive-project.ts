import { HIVE_SOURCE, sourceOf } from './tasks.js';
import type { ActivityRecord, ProjectItem, ProjectPr, ProjectView, State, Task } from './types.js';

/** The text field the hive's view shows a task's workspace in (#582): the table renders it as any source's text field. */
export const WORKSPACE_FIELD = 'Workspace';

const PR_NUMBER = /\/pull\/(\d+)/;
const LOCAL_PARENT = /^local:(\d+)$/;

// The task's PRs as the PR column shows them (#582): what its activity records hold, no checks (they stay with the PR views). A link
// without /pull/<n> has no number to show, so it is dropped
function prsOf(itemId: string, records: ActivityRecord[]): ProjectPr[] {
  return records.filter((r) => r.taskIds.includes(itemId)).flatMap((r) => r.prs ?? []).flatMap((pr) => {
    const match = PR_NUMBER.exec(pr.url);
    return match ? [{ number: Number(match[1]), url: pr.url, state: pr.state }] : [];
  });
}

// One hive task's row: found by its itemId as a source row is; a stageless task (#566) has no status, as an unset GitHub Status
function rowOf(task: Task, records: ActivityRecord[]): ProjectItem {
  const { item } = task;
  const parent = LOCAL_PARENT.exec(item.parent ?? '')?.[1];
  return {
    itemId: item.itemId, id: item.id, title: item.title, body: item.body, url: item.url,
    ...(task.stage === undefined ? {} : { status: task.stage }),
    labels: [], assignees: [],
    fields: task.workspace === undefined ? {} : { [WORKSPACE_FIELD]: task.workspace },
    pullRequests: prsOf(item.itemId, records),
    ...(parent === undefined ? {} : { parent: Number(parent) }),
  };
}

/** The hive's native view (#582), from the state alone: every stage of every flow as a status citing itself, and the tasks created in the
 * Hive in its order. The state holds every one, so it is never truncated. */
export function hiveProject(state: Pick<State, 'flows' | 'tasks' | 'activityRecords'>): ProjectView {
  return {
    statuses: state.flows.flatMap((flow) => flow.stages.map(({ name }) => ({ name, stage: name }))),
    fields: [{ name: WORKSPACE_FIELD, type: 'text' }],
    builtins: { status: 0 },
    items: state.tasks.filter((task) => sourceOf(task) === HIVE_SOURCE).map((task) => rowOf(task, state.activityRecords)),
    truncated: false,
  };
}
