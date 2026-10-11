import { prsOf } from '../../activities';
import { nextPr } from '../../pull-requests';
import type { IssuePage, State, Task } from '../../types';
import { Editable, fieldSaver } from '@/components/Editable';
import { IssueCommentBox } from '@/components/IssueCommentBox';
import { IssueMarkdown } from '@/components/IssueMarkdown';
import { AssigneeCell, PrCell, taskPrs } from '@/components/ProjectRow';
import { useOpenPr } from '@/components/terminal-tabs';
import { useNavScroll } from '@/hooks/use-back-stack';
import { issuePath } from '@/hooks/use-issue';
import { t } from '@/i18n';
import { relativeTime } from '@/lib/home';

const MUTED = 'text-muted-foreground';

export interface IssueBodyProps { issue: IssuePage; task?: Task; state: State; meta: string; onChanged(): Promise<void> }

// The PR line (handoff 01): a task's own PRs (#698), abrir PR › to its next open one; an issue out of the flow, the PRs that close it, abrir
// PR › to the first open one. Its page through the dock's opener (#758), GitHub outside a Dashboard. No PR: no line
function PrLine({ issue, task, state }: { issue: IssuePage; task?: Task; state: State }) {
  const openPr = useOpenPr();
  const prs = taskPrs(issue.pullRequests, task, state);
  if (prs.length === 0) return null;
  const target = task ? nextPr(prsOf(state, task.item.itemId), task.item.facets?.repository) : prs.find((pr) => pr.state === 'open')?.url;
  const open = (): void => {
    if (target === undefined) return;
    if (openPr) openPr(target);
    else window.open(target, '_blank', 'noreferrer');
  };
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${MUTED}`}>
      <PrCell prs={prs} />
      <span className="flex-1" />
      {target !== undefined && <button type="button" className="text-foreground hover:underline" onClick={open}>{t('issue.openPr')}</button>}
    </div>
  );
}

// comentários · N (handoff 01): the first 100, oldest first; past them, a link to the rest on GitHub
function Comments({ issue }: { issue: IssuePage }) {
  const more = issue.commentCount - issue.comments.length;
  const heading = t('issue.comments', { n: issue.commentCount });
  return (
    <section aria-label={heading} className="flex flex-col gap-4">
      <h2 className="font-medium text-xs">{heading}</h2>
      {issue.comments.map((comment) => (
        <article key={comment.url} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs">
            <AssigneeCell logins={[comment.author]} />
            <span className="font-medium">{comment.author}</span>
            <span className={MUTED}>{relativeTime(comment.createdAt)}</span>
          </div>
          <div className="text-[13px] leading-5"><IssueMarkdown text={comment.body} /></div>
        </article>
      ))}
      {more > 0 && <a href={issue.url} target="_blank" rel="noreferrer" className={`text-xs hover:text-foreground ${MUTED}`}>{t('issue.moreComments', { n: more })}</a>}
    </section>
  );
}

/** The issue page's center (#757, handoff 01): the title and the meta line, then the PR line, the description and the comments. The title
 * and the description edit in place; the box under the comments posts one. */
export function IssueBody({ issue, task, state, meta, onChanged }: IssueBodyProps) {
  const save = fieldSaver(issuePath(issue.repository, issue.number), t('issue.changed'), onChanged);
  const scroller = useNavScroll(); // #911: mounts once the issue is read, when its pending scroll applies
  return (
    <div ref={scroller} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-3 px-6 pt-4">
        <Editable label={t('issue.title')} value={issue.title} updatedAt={issue.updatedAt} isMultiline={false} changed={t('issue.changed')} onSave={save('title')}>
          <h1 className="font-semibold text-[20px] leading-[26px] [text-wrap:pretty]">{issue.title}</h1>
        </Editable>
        <p className={`border-b pb-3 text-xs ${MUTED}`}>{meta}</p>
      </div>
      <div className="flex max-w-[640px] flex-col gap-5 px-6 py-5">
        <PrLine issue={issue} task={task} state={state} />
        <section aria-label={t('issue.description')} className="flex flex-col gap-2">
          <p className="flex gap-2 text-xs">
            <span className="font-medium text-foreground">{t('issue.description')}</span>
            <span className={MUTED}>{`${issue.author} · ${relativeTime(issue.createdAt)}`}</span>
          </p>
          <Editable label={t('issue.description')} value={issue.body} updatedAt={issue.updatedAt} isMultiline changed={t('issue.changed')} onSave={save('body')}>
            <div className="text-[13px] leading-[21px]"><IssueMarkdown text={issue.body} /></div>
          </Editable>
        </section>
        <hr />
        <Comments issue={issue} />
        <IssueCommentBox path={`${issuePath(issue.repository, issue.number)}/comments`} repository={issue.repository} onPosted={onChanged} />
      </div>
    </div>
  );
}
