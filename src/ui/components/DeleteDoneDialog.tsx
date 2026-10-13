import { useState } from 'react';
import { toast } from 'sonner';
import { taskLabel } from '../../tasks';
import { Confirm } from '@/components/Confirm';
import { activityDeletionUrl, type Removal } from '@/components/DeleteActivity';
import { t } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { postJson } from '@/lib/api';

// One delete after another (#586), never forced: a refusal or a failure keeps that activity with git's words, and the rest still run
async function deleteEach(activities: TaskActivity[]): Promise<string[]> {
  const kept: string[] = [];
  for (const { task, activity } of activities) {
    const answer = await postJson<Removal>(activityDeletionUrl(activity.id)).catch((err: Error): Removal => ({ removed: false, refused: err.message }));
    if (!answer.removed) kept.push(`${taskLabel(task)}: ${answer.refused}`);
  }
  return kept;
}

const titles = (activities: TaskActivity[]): string => activities.map(({ task }) => taskLabel(task)).join('\n');

// The confirm's text: what goes, then the local activities it skips, which have no worktree to remove (#444)
function message(deletable: TaskActivity[], skipped: TaskActivity[]): string {
  const text = `${t('activities.deleteAll.text')}\n\n${titles(deletable)}`;
  return skipped.length === 0 ? text : `${text}\n\n${t('activities.deleteAll.local')}\n${titles(skipped)}`;
}

/** done's excluir todas… (#586): a confirm listing the activities, then the delete activity route (#182) once per activity, in turn and
 * without force, and one toast naming those that stayed. Those stay in done, where their own excluir atividade… offers the force. */
export function DeleteDoneDialog({ activities }: { activities: TaskActivity[] }) {
  const deletable = activities.filter(({ activity }) => !activity?.local);
  const skipped = activities.filter(({ activity }) => activity?.local);
  const [isRunning, setIsRunning] = useState(false); // a second batch would see the first's tasks mid-removal and report them as kept
  const run = (): void => {
    setIsRunning(true);
    void deleteEach(deletable).then((kept) => {
      setIsRunning(false);
      // one line per kept activity, and it stays until dismissed: git's reasons are what the user acts on
      if (kept.length > 0) toast.error(t('activities.deleteAll.kept', { list: kept.join('\n') }), { className: 'whitespace-pre-line', duration: Infinity });
    });
  };
  return (
    <Confirm
      title={t('activities.deleteAll.title')} message={message(deletable, skipped)} confirmLabel={t('activities.deleteAll.confirm')} onConfirm={run}
      trigger={<button type="button" disabled={isRunning} className="shrink-0 disabled:cursor-default disabled:opacity-50 cursor-pointer rounded-[4px] border px-1.5 hover:text-foreground">{t('activities.deleteAll')}</button>}
    />
  );
}
