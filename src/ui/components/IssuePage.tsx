import type { ReactNode } from 'react';
import { issueUrl, taskOfIssue } from '../../repos/issue-task';
import { resolveWorkspace } from '../../tasks';
import type { State } from '../../types';
import { DetailSlot, SlotTitle } from '@/components/DetailSlot';
import { IssueBody } from '@/components/IssueBody';
import { IssueProperties } from '@/components/IssueProperties';
import { TaskPrList } from '@/components/TaskPrList';
import { useIssue } from '@/hooks/use-issue';
import { t } from '@/i18n';

/** The issue a page shows (#757): its repository and number; from a native view, the item it came from, whose fields the page edits (#686). */
export interface IssueRef { repository: string; number: number; itemId?: string }

export interface IssuePageProps {
  state: State; issue: IssueRef;
  meta: string; // the source's name, or the repository's owner/name: where the page was opened from
  workspace?: string; // the repository's workspace: the issue's when it is no task
  header(reload: () => Promise<void>): ReactNode; // the header it was opened from; its atualizar reads the issue again
  onGoTo(taskId: string): void;
  onOpenPr(url: string): void; // #65: the task's PRs' "open", the dashboard's PR opener: its page when its repository is listed, else GitHub
}

/** An issue's own page (#757, handoff 01 "Página da issue"): one page for both lists, under the header it was opened from. Read when it opens
 * and after every write, never polled. Its properties are its block in the details panel's slot (#64), headed by the issue's title when the
 * issue is no task; while it reads, or after its read fails, the slot shows the same line as the center, so the panel is never empty. Under
 * them, the task's PRs (#65): here and not in IssueProperties, which the PR page shares, where the stack lists them. One tree for every
 * state, so the PRs list stays mounted when the read lands and its checks are read once. */
export function IssuePage(props: IssuePageProps) {
  const { state, issue: ref, meta, workspace, header, onGoTo, onOpenPr } = props;
  const { load, reload, optimistic } = useIssue(ref.repository, ref.number);
  const issue = load.kind === 'issue' ? load.issue : undefined;
  // Before the read answers, the task from the ref, as the dashboard finds it (#64): the details grid leaves the PRs to this slot (#65)
  const task = taskOfIssue(state.tasks, issue?.url ?? issueUrl(ref.repository, ref.number), ref.itemId);
  const shownWorkspace = task ? resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks) : workspace;
  const line = load.kind === 'loading' ? t('project.loading') : load.kind === 'error' ? load.message : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(reload)}
      {issue ? (
        <div className="flex min-h-0 flex-1">
          <IssueBody issue={issue} task={task} state={state} meta={[meta, ...(shownWorkspace === undefined ? [] : [shownWorkspace])].join(' · ')} onChanged={reload} />
        </div>
      ) : <p className="px-3.5 py-2 text-muted-foreground text-xs">{line}</p>}
      <DetailSlot>
        {issue ? (
          <>
            {task === undefined && <SlotTitle>{issue.title}</SlotTitle>}
            <IssueProperties issue={issue} task={task} state={state} workspace={shownWorkspace} itemId={ref.itemId} meta={meta} onGoTo={onGoTo} onChanged={reload} optimistic={optimistic} />
          </>
        ) : <p className="text-muted-foreground text-xs">{line}</p>}
        {task && <TaskPrList task={task} state={state} onOpenPr={onOpenPr} />}
      </DetailSlot>
    </div>
  );
}
