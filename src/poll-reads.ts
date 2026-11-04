// The reads a source's poll makes past its listing (#568). Out of server.ts, past 400 lines.
import type { Logger } from './log.js';
import { isStarted, taskId } from './tasks.js';
import type { HiveEvent, Source, SourceItem, State, Task } from './types.js';

export type PollReads = NonNullable<Extract<HiveEvent, { type: 'poll' }>['reads']>;

/** The tasks of `source` a read past the listing still answers for (#568): started, not in `items`, and not orphan, created or leaving. */
export function unlistedStarted(state: State, source: string, items: readonly SourceItem[]): Task[] {
  const listed = new Set(items.map((c) => c.item.itemId));
  return state.tasks.filter((c) => c.item.source === source && !listed.has(taskId(c)) && !c.orphan && !c.created && !c.leaving && isStarted(state, c));
}

/** item() of each task, one after another, so a burst of GraphQL calls stays off the rate limit (#568). A rejected read is logged with the task
 * id and left out: the reducer keeps that task as it was (1.4: a failed read is not an answer). */
export async function readUnlisted(source: Pick<Source, 'item'>, tasks: readonly Task[], log: Pick<Logger, 'error'>): Promise<PollReads> {
  let reads: PollReads = [];
  for (const task of tasks) {
    try {
      reads = [...reads, { itemId: taskId(task), read: await source.item(taskId(task), task.item.url) }];
    } catch (err) {
      log.error(`poll read #${taskId(task)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return reads;
}
