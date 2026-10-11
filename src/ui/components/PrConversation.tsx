import { prRepo } from '../../pull-requests';
import type { PrData, State, Task } from '../../types';
import { IssueCommentBox } from '@/components/IssueCommentBox';
import { PrChecks } from '@/components/PrChecks';
import { PrDescription } from '@/components/PrDescription';
import { PrMergeBox } from '@/components/PrMergeBox';
import { PrStack } from '@/components/PrStack';
import { PrTimeline } from '@/components/PrTimeline';
import { useNavScroll } from '@/hooks/use-back-stack';
import { prPath } from '@/hooks/use-pr';
import { t, tPlural } from '@/i18n';

const BADGE: Record<'open' | 'draft' | 'merged' | 'closed', string> = {
  open: 'border-review text-review', draft: 'text-muted-foreground', merged: 'text-muted-foreground', closed: 'text-muted-foreground',
};

// The PR line (handoff 03): its state as a badge, head → base in mono, the commit count, and the lines it adds and removes
function PrLine({ pr }: { pr: PrData }) {
  const badge = pr.state === 'open' && pr.isDraft ? 'draft' : pr.state;
  const across = pr.headOwner !== pr.baseOwner; // #854: a fork's PR names both owners
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
      <span className={`rounded-[4px] border px-1.5 ${BADGE[badge]}`}>{t(`prs.state.${badge}`)}</span>
      <span className="font-mono">{across ? `${pr.headOwner}:${pr.headRef}` : pr.headRef}</span>
      <span aria-hidden="true">→</span>
      <span className="font-mono">{across ? `${pr.baseOwner}:${pr.baseRef}` : pr.baseRef}</span>
      <span>{`· ${tPlural('pr.commits', pr.commits, { n: pr.commits })} ·`}</span>
      <span className="text-working">+{pr.additions}</span>
      <span className="text-destructive">−{pr.deletions}</span>
    </p>
  );
}

export interface PrConversationProps { pr: PrData; task?: Task; state: State; onChanged(): Promise<void>; onOpenPr(url: string): void; onOpenInDiff(path: string): void }

/** conversation (#758, handoff 03): 16px 24px, gap 16, beside the properties; a merged or closed PR says first that it is read only. Then the
 * PR line, the description, the stack, the checks, the timeline and, on an open PR, the comment box and the merge box. */
export function PrConversation({ pr, task, state, onChanged, onOpenPr, onOpenInDiff }: PrConversationProps) {
  const scroller = useNavScroll(); // #911: the PR page's conversation; files keeps its own (out of scope)
  return (
    <div ref={scroller} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
      {pr.state !== 'open' && <p className="text-muted-foreground text-xs">{t('pr.readOnly', { state: t(`prs.state.${pr.state}`) })}</p>}
      <PrLine pr={pr} />
      <PrDescription pr={pr} onChanged={onChanged} />
      {task && <PrStack pr={pr} task={task} state={state} onOpenPr={onOpenPr} />}
      <PrChecks checks={pr.checks} pr={pr} onChanged={() => void onChanged()} />
      <PrTimeline pr={pr} onOpenInDiff={onOpenInDiff} />
      {pr.state === 'open' && (
        <div className="max-w-[680px]">
          <IssueCommentBox path={prPath(pr.url, '/comments')} repository={prRepo(pr.url)} label={t('pr.comment.placeholder')} onPosted={onChanged} />
        </div>
      )}
      <PrMergeBox pr={pr} task={task} state={state} onMerged={() => void onChanged()} />
    </div>
  );
}
