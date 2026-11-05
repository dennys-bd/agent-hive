// What a read past the listing makes of a started task the poll's listing lacks (#568). Out of tasks.ts, past 400 lines. Pure. tasks.ts imports
// this module and this one imports tasks.ts: neither calls the other at load time, as task-tree.ts and tasks.ts already do
import { activityOf } from './activities.js';
import { inAction, type Runs, seenAgain, taskId, workersOf } from './tasks.js';
import type { Flow, Item, SourceItemRead, Task } from './types.js';

// A worker holds it: a close on the source never kills a live session; the next poll reads it again. A terminal holds nothing
const isHeld = (task: Task, runs: Runs): boolean => {
  const live = activityOf(runs, taskId(task));
  return live?.workerId !== undefined || inAction(live) || workersOf(runs, task).length > 0;
};

// Off the Project the issue carries no Project fields (#567): only what the issue itself says changes
const issueFields = (item: Item, read: Item): Item =>
  ({ ...item, title: read.title, body: read.body, url: read.url, ...(read.createdAt === undefined ? {} : { createdAt: read.createdAt }) });

/** A started task the listing lacks against item()'s answer (#568): listing and filter merge as seenAgain does, project refreshes the issue
 * alone, closed lets it go (undefined) unless a worker holds it, gone turns it orphan. No answer (a rejected read, or a task that started after
 * the listing): marked listing once, else as it is. */
export function outOfRead(task: Task, read: SourceItemRead | undefined, flows: readonly Flow[], runs: Runs, now: string): Task | undefined {
  if (read === undefined) return task.outOfListing === undefined ? { ...task, outOfListing: 'listing' } : task;
  switch (read.reason) {
    case 'listing':
    case 'filter':
      return { ...seenAgain(task, read.entry, flows, runs, now), outOfListing: read.reason };
    case 'project':
      return { ...task, item: issueFields(task.item, read.item), outOfListing: 'project' };
    case 'closed':
      return isHeld(task, runs) ? task : undefined;
    case 'gone': {
      const { outOfListing: _outOfListing, ...rest } = task;
      return { ...rest, orphan: true };
    }
  }
}
