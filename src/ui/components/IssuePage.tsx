import type { ReactNode } from 'react';
import { taskOfIssue } from '../../repos/issue-task';
import { resolveWorkspace } from '../../tasks';
import type { State } from '../../types';
import { IssueBody } from '@/components/IssueBody';
import { IssueProperties } from '@/components/IssueProperties';
import { useIssue } from '@/hooks/use-issue';
import { t } from '@/i18n';

/** The issue a page shows (#757): its repository and number; from a native view, the item it came from, whose fields the page edits (#686). */
export interface IssueRef { repository: string; number: number; itemId?: string }

export interface IssuePageProps {
  state: State; locale: string; issue: IssueRef;
  meta: string; // the source's name, or the repository's owner/name: where the page was opened from
  workspace?: string; // the repository's workspace: the issue's when it is no task
  header(reload: () => Promise<void>): ReactNode; // the header it was opened from; its atualizar reads the issue again
  onGoTo(taskId: string): void;
}

/** An issue's own page (#757, handoff 01 "Página da issue"): one page for both lists, under the header it was opened from. Read when it opens
 * and after every write, never polled. */
export function IssuePage(props: IssuePageProps) {
  const { state, locale, issue: ref, meta, workspace, header, onGoTo } = props;
  const { load, reload } = useIssue(ref.repository, ref.number);
  if (load.kind !== 'issue') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header(reload)}
        <p className="px-3.5 py-2 text-muted-foreground text-xs">{load.kind === 'loading' ? t('project.loading') : load.message}</p>
      </div>
    );
  }
  const { issue } = load;
  const task = taskOfIssue(state.tasks, issue.url, ref.itemId);
  const shownWorkspace = task ? resolveWorkspace(task, state.workspaces, state.sourceWorkspaces) : workspace;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(reload)}
      <div className="flex min-h-0 flex-1">
        <IssueBody issue={issue} task={task} state={state} meta={[meta, ...(shownWorkspace === undefined ? [] : [shownWorkspace])].join(' · ')} onChanged={reload} />
        <IssueProperties
          issue={issue} task={task} state={state} locale={locale} workspace={shownWorkspace} itemId={ref.itemId} meta={meta} onGoTo={onGoTo} onChanged={reload}
        />
      </div>
    </div>
  );
}
