import type { KeyboardEvent, MouseEvent } from 'react';
import type { RepoIssue, State, Task } from '../../types';
import { AssigneeCell, PrCell, taskPrs } from '@/components/ProjectRow';
import { t } from '@/i18n';
import { relativeTime } from '@/lib/home';

const CHIP = 'max-w-full shrink-0 truncate rounded-[4px] border px-1.5 text-muted-foreground text-xs';

export interface RepoIssueRowProps { issue: RepoIssue; task?: Task; columns: string; state: State; onOpen?(issue: RepoIssue): void }

/** One issue of a repository's list (#757, handoff 02): its number and title, labels, first assignee, the stage of its task or out of the
 * flow, its PRs and when it last changed. A click or ↵ opens its issue page; ⇧↵ opens it on GitHub. */
export function RepoIssueRow({ issue, task, columns, state, onOpen }: RepoIssueRowProps) {
  // a click on a cell's own control is not the row's
  const onClick = (e: MouseEvent<HTMLTableRowElement>): void => {
    const target = e.target as Element;
    if (e.currentTarget.contains(target) && !target.closest('button, a')) onOpen?.(issue);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>): void => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
    e.preventDefault();
    if (e.shiftKey) window.open(issue.url, '_blank', 'noreferrer');
    else onOpen?.(issue);
  };
  return (
    <tr
      tabIndex={0} onClick={onClick} onKeyDown={onKeyDown} style={{ gridTemplateColumns: columns }}
      className="grid h-10 cursor-pointer items-center gap-3 border-b px-3 text-[13px] outline-none hover:bg-muted focus:bg-muted"
    >
      <td className="flex min-w-0 items-center gap-1.5"><span className="shrink-0 font-medium">#{issue.number}</span><span className="min-w-0 truncate">{issue.title}</span></td>
      <td className="flex min-w-0 gap-1 overflow-hidden">{issue.labels.map((label) => <span key={label} className={CHIP}>{label}</span>)}</td>
      <td><AssigneeCell logins={issue.assignees} /></td>
      <td className="min-w-0 truncate">{task ? <span className="text-foreground">{task.stage}</span> : <span className="text-muted-foreground">{t('repos.outOfFlow')}</span>}</td>
      <td className="min-w-0"><PrCell prs={taskPrs(issue.pullRequests, task, state)} /></td>
      <td className="truncate text-muted-foreground text-xs">{relativeTime(issue.updatedAt)}</td>
    </tr>
  );
}
