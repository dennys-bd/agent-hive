import { issueOfLink } from '../../repos/issue-task';
import { repoName } from '../../pull-requests';
import { resolveWorkspace } from '../../tasks';
import type { PrData, RepoSummary, State, Task } from '../../types';
import { IssueProperties } from '@/components/IssueProperties';
import { useIssue } from '@/hooks/use-issue';
import { useRepositories } from '@/hooks/use-repositories';
import { t } from '@/i18n';
import { workspaceColor } from '@/lib/workspace-color';

const MUTED = 'text-muted-foreground';
const BLOCK = 'flex flex-col gap-4 text-xs'; // #64: a block of the details panel's slot, which draws the frame

// A PR without a task, or one whose issue the Hive cannot read (handoff 03 "PR sem tarefa"): its repository and its workspace
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

interface TaskIssueProps { task: Task; issue: { repository: string; number: number }; state: State; onGoTo(taskId: string): void }

// A task PR's properties: its task's issue as the issue page shows it (#757), read with that page's hook
function TaskIssueProperties({ task, issue, state, onGoTo }: TaskIssueProps) {
  const { load, reload } = useIssue(issue.repository, issue.number);
  if (load.kind !== 'issue') return <div className={BLOCK}><p className={MUTED}>{load.kind === 'loading' ? t('project.loading') : load.message}</p></div>;
  return (
    <IssueProperties
      issue={load.issue} task={task} state={state} workspace={resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks)}
      meta={issue.repository} onGoTo={onGoTo} onChanged={reload}
    />
  );
}

export interface PrPropertiesProps { pr?: PrData; task?: Task; summary: RepoSummary; state: State; onGoTo(taskId: string): void }

/** The PR page's properties (#758, handoff 03), a block of the details panel's slot (#64): a task PR shows its task's issue as the issue page
 * does; a PR without a task, or whose task has no issue of a repository the Hive lists (the issue routes answer 404 outside the list), its
 * repository and workspace only. */
export function PrProperties({ pr, task, summary, state, onGoTo }: PrPropertiesProps) {
  const listed = useRepositories();
  const issue = task === undefined ? undefined : issueOfLink(task.item.url);
  if (task === undefined || issue === undefined || !listed.some((r) => r.repository === issue.repository)) return <RepoProperties summary={summary} pr={pr} />;
  return <TaskIssueProperties task={task} issue={issue} state={state} onGoTo={onGoTo} />;
}
