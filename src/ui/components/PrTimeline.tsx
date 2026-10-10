import type { ReactNode } from 'react';
import type { FileDiff, LineAnchor, PrData, PrIssueComment, PrReviewEvent, PrThread } from '../../types';
import { Conversation } from '@/components/Conversation';
import { IssueMarkdown } from '@/components/IssueMarkdown';
import { AssigneeCell } from '@/components/ProjectRow';
import { type MessageKey, t } from '@/i18n';
import { relativeTime } from '@/lib/home';
import { timelineItems } from '@/lib/pr-timeline';
import { prConversation } from '@/lib/surface';

const MUTED = 'text-muted-foreground';
const VERDICT: Record<PrReviewEvent['kind'], { key: MessageKey; tone: string }> = {
  approved: { key: 'pr.timeline.approved', tone: 'text-working' }, changes: { key: 'pr.timeline.changes', tone: 'text-waiting' },
  commented: { key: 'pr.timeline.commented', tone: MUTED },
};

/** The text of the line a thread is anchored at (#758), off the PR's diff; undefined when the diff no longer holds it. */
export function codeLine(files: FileDiff[], anchor: LineAnchor): string | undefined {
  const lines = files.find((f) => f.path === anchor.path)?.hunks.flatMap((hunk) => hunk.lines) ?? [];
  return lines.find((line) => (anchor.side === 'new' ? line.new : line.old) === anchor.end)?.text;
}

// Who wrote it, what they did and when
function Byline({ author, at, children }: { author: string; at: string; children?: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs">
      <AssigneeCell logins={[author]} />
      <span className="font-medium">{author}</span>
      {children}
      <span className={MUTED}>{relativeTime(at)}</span>
    </p>
  );
}

// approved, requested changes or commented, with the review's body
function ReviewItem({ review }: { review: PrReviewEvent }) {
  const verdict = VERDICT[review.kind];
  return (
    <article className="flex flex-col gap-1.5">
      <Byline author={review.author} at={review.at}><span className={verdict.tone}>{t(verdict.key)}</span></Byline>
      {review.text !== '' && <div className="text-[13px] leading-5"><IssueMarkdown text={review.text} /></div>}
    </article>
  );
}

function CommentItem({ comment }: { comment: PrIssueComment }) {
  return (
    <article className="flex flex-col gap-1.5">
      <Byline author={comment.author} at={comment.at} />
      <div className="text-[13px] leading-5"><IssueMarkdown text={comment.text} /></div>
    </article>
  );
}

// A review thread (handoff 03): its path and open in diff (the conversation already names line N), the anchored code line, then its comments with reply and resolve as the
// diff draws them
function ThreadItem({ thread, pr, onOpenInDiff }: { thread: PrThread; pr: PrData; onOpenInDiff(path: string): void }) {
  const code = thread.subject === 'line' ? codeLine(pr.files, thread.anchor) : undefined;
  return (
    <article className="flex flex-col rounded-lg border">
      <header className={`flex items-center gap-2 border-b px-3 py-1.5 text-xs ${MUTED}`}>
        <span className="truncate font-mono text-foreground">{thread.anchor.path}</span>
        <span className="flex-1" />
        <button type="button" className="hover:text-foreground" onClick={() => onOpenInDiff(thread.anchor.path)}>{t('pr.timeline.openInDiff')}</button>
      </header>
      {code !== undefined && <pre className="overflow-x-auto border-b bg-muted px-3 py-1 font-mono text-xs">{code}</pre>}
      <div className="p-2"><Conversation conversation={prConversation(thread, pr.viewer)} isOutdated={thread.outdated} /></div>
    </article>
  );
}

/** timeline (#758, handoff 03): 680px wide, oldest first: reviews with their verdict and body, review threads at their line, general comments. */
export function PrTimeline({ pr, onOpenInDiff }: { pr: PrData; onOpenInDiff(path: string): void }) {
  return (
    <section aria-label={t('pr.tab.conversation')} className="flex max-w-[680px] flex-col gap-4">
      {timelineItems(pr).map((item) => {
        if (item.kind === 'review') return <ReviewItem key={item.review.id} review={item.review} />;
        if (item.kind === 'thread') return <ThreadItem key={item.thread.id} thread={item.thread} pr={pr} onOpenInDiff={onOpenInDiff} />;
        return <CommentItem key={item.comment.id} comment={item.comment} />;
      })}
    </section>
  );
}
