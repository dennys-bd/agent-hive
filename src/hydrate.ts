import { taskId } from './tasks.js';
import type { SourceItem, Task } from './types.js';

// #191: here and not in tasks.ts, which is already over its size (as column-write.ts), and with no Node import, as tasks.ts.

/** The loaded tasks with each item the read model holds in place of its lean one, before any rule runs. Nothing else of a task moves
 * (stage, column, columnWrite): the first poll does that. A stored item with no task is not a new task. */
export function hydrate(tasks: Task[], stored: SourceItem[]): Task[] {
  const items = new Map(stored.map((entry) => [entry.item.itemId, entry.item]));
  return tasks.map((task) => {
    const item = items.get(taskId(task));
    return item === undefined ? task : { ...task, item };
  });
}
