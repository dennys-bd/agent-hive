// Which Hive task an issue is (#757): the one rule the repository list, the issue page and the server's poll after a write share. Pure, no
// Node import: the UI imports it too.
import type { Task } from '../types.js';

/** An issue's link as GitHub writes it, what a task's item.url holds (#757). */
export const issueUrl = (repository: string, number: number): string => `https://github.com/${repository}/issues/${number}`;

/** The task an issue is (#757): the first, in the Hive's order, whose item.url is the issue's; failing that, the first whose origin is
 * `itemId`, the native view item the page was opened from. None: the issue is out of the flow. */
export function taskOfIssue(tasks: Task[], url: string, itemId?: string): Task | undefined {
  return tasks.find((t) => t.item.url === url) ?? (itemId === undefined ? undefined : tasks.find((t) => t.item.origin === itemId));
}

/** The repository and number an issue link names (#758), as issueUrl writes it; undefined for any other link. */
export function issueOfLink(url: string): { repository: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  return match === null ? undefined : { repository: match[1], number: Number(match[2]) };
}
