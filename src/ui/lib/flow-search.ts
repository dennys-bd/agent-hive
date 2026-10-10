import { taskLabel } from '../../tasks.js';
import type { Task } from '../../types.js';

/** Whether a task matches the flow's buscar tasks (#542): a case-insensitive substring of its label (`#12 Title`, `HIVE-3 Title`: the
 * number and the title) or of its branch, its live activity's (#629), which the caller reads. A blank term matches every task. */
export function matchesSearch(task: Pick<Task, 'item' | 'created'>, branch: string, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return true;
  return [taskLabel(task), branch].some((text) => text.toLowerCase().includes(needle));
}
