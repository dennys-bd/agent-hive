import type { ReactNode } from 'react';
import { taskOfIssue } from '../../repos/issue-task';
import { resolveWorkspace } from '../../tasks';
import type { State } from '../../types';
import { DetailSlot, SlotTitle } from '@/components/DetailSlot';
import { IssueBody } from '@/components/IssueBody';
import { IssueProperties } from '@/components/IssueProperties';
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
}

/** An issue's own page (#757, handoff 01 "Página da issue"): one page for both lists, under the header it was opened from. Read when it opens
 * and after every write, never polled. Its properties are its block in the details panel's slot (#64), headed by the issue's title when the
 * issue is no task; while it reads, or after its read fails, the slot shows the same line as the center, so the panel is never empty. */
export function IssuePage(props: IssuePageProps) {
  const { state, issue: ref, meta, workspace, header, onGoTo } = props;
  const { load, reload } = useIssue(ref.repository, ref.number);
  if (load.kind !== 'issue') {
    const line = load.kind === 'loading' ? t('project.loading') : load.message;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header(reload)}
        <p className="px-3.5 py-2 text-muted-foreground text-xs">{line}</p>
        <DetailSlot><p className="text-muted-foreground text-xs">{line}</p></DetailSlot>
      </div>
    );
  }
  const { issue } = load;
  const task = taskOfIssue(state.tasks, issue.url, ref.itemId);
  const shownWorkspace = task ? resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks) : workspace;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(reload)}
      <div className="flex min-h-0 flex-1">
        <IssueBody issue={issue} task={task} state={state} meta={[meta, ...(shownWorkspace === undefined ? [] : [shownWorkspace])].join(' · ')} onChanged={reload} />
      </div>
      <DetailSlot>
        {task === undefined && <SlotTitle>{issue.title}</SlotTitle>}
        <IssueProperties issue={issue} task={task} state={state} workspace={shownWorkspace} itemId={ref.itemId} meta={meta} onGoTo={onGoTo} onChanged={reload} />
      </DetailSlot>
    </div>
  );
}
