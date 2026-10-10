import { activityOf } from '../../activities';
import { stageSession } from '../../task-runs';
import { SESSION_ID_CHARS, SHORT_SHA, sessionsOf } from '../../tasks';
import type { Stage, State, Task } from '../../types';
import { t, tPlural } from '@/i18n';

// The restart dialog's row texts (#580), pure so vitest checks them without rendering. The server counts only what needs git; the rest is the
// task's activity and records (#629).

/** What the rows read besides the task: its live activity's start and every record's sessions. */
export type RestartWork = Pick<State, 'activities' | 'activityRecords'>;

/** What GET /activities/:id/restart counted: all the descarta row needs from the preview. */
interface Discarded { mode: 'reset' | 'branch'; commits: number; files: number }

/** The descarta row: the commits (reset only: in branch mode they stay on the published branch), the files, and the stage's session, which
 * the restart abandons, not deletes: the panel still lists it. */
export function discardText(task: Task, work: RestartWork, { mode, commits, files }: Discarded): string {
  const session = stageSession(task, work, task.stage);
  return [
    ...(mode === 'reset' ? [tPlural('restart.commits', commits, { n: commits })] : []),
    tPlural('diff.files', files, { n: files }),
    ...(session ? [t('restart.session', { id: session.id.slice(0, SESSION_ID_CHARS) })] : []),
  ].join(' · ');
}

/** The volta para row: the start commit, short, and the stage that ended there; this stage's own start when none did, which is always true.
 * Undefined without a recorded start. */
export function returnTo(task: Task, work: RestartWork): { sha: string; label: string } | undefined {
  const start = activityOf(work, task.item.itemId)?.stageStart;
  if (!start) return undefined;
  const label = start.after === undefined ? t('restart.stageStart', { stage: task.stage }) : t('restart.stageEnd', { stage: start.after });
  return { sha: start.commit.slice(0, SHORT_SHA), label };
}

/** What Restart keeps: the other stages that ran on the task, read from its sessions so that a stage with no result counts too, in column
 * order. A stage no column holds any more has no place in that order and is left out. */
export function keptStages(task: Task, work: RestartWork, stages: Stage[]): string[] {
  const ran = new Set(sessionsOf(work, task.item.itemId).flatMap((s) => s.stages));
  return stages.map((s) => s.name).filter((name) => name !== task.stage && ran.has(name));
}

/** The mantém row: `resultados de a, b e c`, with the language's "and" before the last one. */
export function keptText(names: string[]): string {
  const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${t('restart.and')} ${names.at(-1)}`;
  return t('restart.results', { stages: list });
}
