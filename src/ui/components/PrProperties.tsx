import { repoName } from '../../pull-requests';
import type { PrData, RepoSummary, State, Task } from '../../types';
import { PrBlock } from '@/components/PrBlock';
import { TaskPrList } from '@/components/TaskPrList';
import { t } from '@/i18n';
import { workspaceColor } from '@/lib/workspace-color';

const MUTED = 'text-muted-foreground';
const BLOCK = 'flex flex-col gap-4 text-xs'; // #64: a block of the details panel's slot, which draws the frame

// A PR without a task (handoff 03 "PR sem tarefa"): its repository and its workspace, until #68
function RepoProperties({ summary, pr }: { summary: RepoSummary; pr?: PrData }) {
  return (
    <div className={BLOCK}>
      <dl className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-2 gap-y-3">
        <dt className={MUTED}>{t('pr.props.repository')}</dt>
        <dd className="flex min-w-0 items-center gap-1"><span className="truncate">{summary.repository}</span>{summary.role === 'original' && <span className={MUTED}>{t('repos.original')}</span>}</dd>
        {pr !== undefined && pr.headOwner !== '' && pr.headOwner !== pr.baseOwner && ( // #854: the fork the PR comes from
          <>
            <dt className={MUTED}>{t('pr.props.from')}</dt>
            <dd className="flex min-w-0 items-center gap-1"><span className="truncate">{`${pr.headOwner}/${repoName(summary.repository)}`}</span><span className={MUTED}>{t('repos.fork')}</span></dd>
          </>
        )}
        <dt className={MUTED}>{t('issue.props.workspace')}</dt>
        <dd className="flex items-center gap-1">
          <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: workspaceColor(summary.workspace) }} />
          <span>{summary.workspace}</span>
        </dd>
      </dl>
    </div>
  );
}

export interface PrPropertiesProps {
  pr: PrData; task?: Task; summary: RepoSummary; state: State;
  onOpenIssue(url: string): void; // #66: a closing issue's page, or GitHub
  onOpenPr(url: string): void; // #66: another PR of the task's page, or GitHub
}

/** The PR page's properties (#758, handoff 03), a block of the details panel's slot (#64): a task PR shows the this PR box and the task's other
 * PRs (#66); a PR without a task its repository and workspace. The task issue's own fields are the issue page's (#65), never the PR's. */
export function PrProperties({ pr, task, summary, state, onOpenIssue, onOpenPr }: PrPropertiesProps) {
  if (task === undefined) return <RepoProperties summary={summary} pr={pr} />;
  return (
    <div className={BLOCK}>
      <PrBlock pr={pr} task={task} state={state} onOpenIssue={onOpenIssue} />
      <TaskPrList task={task} state={state} except={pr.url} onOpenPr={onOpenPr} />
    </div>
  );
}
