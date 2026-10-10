import type { ReactNode } from 'react';
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

// The 320px column the issue page has (#757), for what a PR without a task shows
function Aside({ children }: { children: ReactNode }) {
  return (
    <aside aria-label={t('issue.props')} className="flex w-[320px] shrink-0 flex-col border-l">
      <h2 className="flex h-10 shrink-0 items-center border-b px-3.5 font-medium text-[13px]">{t('issue.props')}</h2>
      <div className="p-3.5 text-xs">{children}</div>
    </aside>
  );
}

// A PR without a task, or one whose issue the Hive cannot read (handoff 03 "PR sem tarefa"): its repository and its workspace
function RepoProperties({ summary, pr }: { summary: RepoSummary; pr?: PrData }) {
  return (
    <Aside>
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
    </Aside>
  );
}

interface TaskIssueProps { task: Task; issue: { repository: string; number: number }; state: State; locale: string; onGoTo(taskId: string): void }

// A task PR's properties: its task's issue as the issue page shows it (#757), read with that page's hook
function TaskIssueProperties({ task, issue, state, locale, onGoTo }: TaskIssueProps) {
  const { load, reload } = useIssue(issue.repository, issue.number);
  if (load.kind !== 'issue') return <Aside><p className={MUTED}>{load.kind === 'loading' ? t('project.loading') : load.message}</p></Aside>;
  return (
    <IssueProperties
      issue={load.issue} task={task} state={state} locale={locale} workspace={resolveWorkspace(task, state.workspaces, state.sourceWorkspaces)}
      meta={issue.repository} onGoTo={onGoTo} onChanged={reload}
    />
  );
}

export interface PrPropertiesProps { pr?: PrData; task?: Task; summary: RepoSummary; state: State; locale: string; onGoTo(taskId: string): void }

/** The PR page's properties (#758, handoff 03): a task PR shows its task's issue as the issue page does; a PR without a task, or whose task
 * has no issue of a repository the Hive lists (the issue routes answer 404 outside the list), its repository and workspace only. */
export function PrProperties({ pr, task, summary, state, locale, onGoTo }: PrPropertiesProps) {
  const listed = useRepositories();
  const issue = task === undefined ? undefined : issueOfLink(task.item.url);
  if (task === undefined || issue === undefined || !listed.some((r) => r.repository === issue.repository)) return <RepoProperties summary={summary} pr={pr} />;
  return <TaskIssueProperties task={task} issue={issue} state={state} locale={locale} onGoTo={onGoTo} />;
}
