import { taskOfIssue } from '../../repos/issue-task';
import type { PrData, State } from '../../types';
import { PrBlock } from '@/components/PrBlock';
import { PrTaskPopover } from '@/components/PrTaskPopover';
import { AssigneeCell } from '@/components/ProjectRow';
import { ReviewPopover } from '@/components/ReviewPopover';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { relativeTime } from '@/lib/home';
import { viewerRequestOf } from '@/lib/pr-reviewers';

const MUTED = 'text-muted-foreground';

// Topo (handoff 7): the author's avatar, PR by {author}, and how long ago it opened with nothing of the Hive's on it
function AuthorTop({ pr }: { pr: PrData }) {
  return (
    <div className="flex items-center gap-2">
      <AssigneeCell logins={[pr.author]} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-[13px]">{t('pr.other.by', { author: pr.author })}</span>
        <span className={MUTED}>{t('pr.other.opened', { time: relativeTime(pr.createdAt) })}</span>
      </div>
    </div>
  );
}

interface NeutralProps { pr: PrData; state: State; drafts: number; onReloaded(): void }

// Bloco neutro (handoff 7), in the status block's place: the viewer's request only when GitHub holds one, so nothing false is said; review
// on an open PR, as the tab bar's; create task…; the note
function NeutralBlock({ pr, state, drafts, onReloaded }: NeutralProps) {
  const request = viewerRequestOf(pr);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border p-2.5">
      {request && (
        <p className="flex items-center gap-2">
          <span aria-hidden="true" className="text-waiting">●</span>
          <span className="font-medium">{t('pr.other.requested')}</span>
          <span className="flex-1" />
          {request.at !== undefined && <span className={MUTED}>{relativeTime(request.at)}</span>}
        </p>
      )}
      <div className="flex gap-2">
        {pr.state === 'open' && <ReviewPopover pr={pr} drafts={drafts} trigger="primary" onSent={onReloaded} />}
        <PrTaskPopover pr={pr} state={state} />
      </div>
      <p className={`${MUTED} leading-4`}>{t('pr.other.note')}</p>
    </div>
  );
}

// No fluxo (handoff 7): each issue the PR closes that is a task, with its stage and task ›; none, "no task in the flow"
function InFlow({ pr, state, onGoTo }: { pr: PrData; state: State; onGoTo(taskId: string): void }) {
  const rows = pr.closes.flatMap((issue) => {
    const task = taskOfIssue(state.tasks, issue.url);
    return task === undefined ? [] : [{ issue, task }];
  });
  return (
    <section aria-label={t('pr.other.inFlow')} className="flex flex-col gap-1.5">
      <h3 className={MUTED}>{t('pr.other.inFlow')}</h3>
      {rows.length === 0 ? <p className={MUTED}>{t('pr.other.noTask')}</p> : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ issue, task }) => (
            <li key={issue.url} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
              <span className="shrink-0 font-medium">{`#${issue.number}`}</span>
              <span className="min-w-0 flex-1 truncate">{task.item.title}</span>
              <span className={`shrink-0 ${MUTED}`}>{task.stage}</span>
              <Button type="button" variant="link" size="xs" className="h-auto shrink-0 p-0 text-foreground" onClick={() => onGoTo(task.item.itemId)}>{t('pr.other.taskLink')}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface PrWithoutActivityProps {
  pr: PrData; state: State;
  drafts: number; // the page's pending review drafts, as the tab bar's review shows them
  onReloaded(): void; // the page reads the PR again after a review is sent
  onGoTo(taskId: string): void; // in the flow's task ›
  onOpenIssue(url: string): void; // this PR's closes row
}

/** A PR no task holds (#68, handoff 7 "PR sem atividade"), in the details panel's slot: the author's top, the neutral block, this PR without
 * a task and the tasks it closes in the flow. No repository grid, task properties, sessions or open activity: none of them is this PR's. */
export function PrWithoutActivity({ pr, state, drafts, onReloaded, onGoTo, onOpenIssue }: PrWithoutActivityProps) {
  return (
    <div className="flex flex-col gap-3.5 text-xs">
      <AuthorTop pr={pr} />
      <NeutralBlock pr={pr} state={state} drafts={drafts} onReloaded={onReloaded} />
      <PrBlock pr={pr} state={state} onOpenIssue={onOpenIssue} />
      <InFlow pr={pr} state={state} onGoTo={onGoTo} />
    </div>
  );
}
