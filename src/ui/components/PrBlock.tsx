import type { ReactNode } from 'react';
import { prsOf } from '../../activities';
import { mergeOrderBlocker, type PrLine, prGroups, prNumber, prRepo } from '../../pull-requests';
import type { PrCheck, PrChecks as Checks, PrClosingIssue, PrData, State, Task, TaskPr } from '../../types';
import { awaitsReview, mergeOffReason } from '@/components/MergeButton';
import { MARK, worstOf } from '@/components/PrChecks';
import { AssigneeCell } from '@/components/ProjectRow';
import { t, tPlural } from '@/i18n';
import { relativeTime } from '@/lib/home';
import { pickMethod } from '@/lib/merge-method';
import { type ReviewerState, reviewersOf } from '@/lib/pr-reviewers';

const MUTED = 'text-muted-foreground';
const REVIEWER_TONE: Record<ReviewerState, string> = {
  approved: 'text-working', changes: 'text-destructive', resolved: MUTED, commented: MUTED, requested: 'text-waiting',
};

// This PR's slice position in its stack group (#698) and the lines before it, which merge first; a PR with no slice has neither
function stackOf(prs: TaskPr[], url: string): { position?: PrLine['position']; before: PrLine[] } {
  const lines = prGroups(prs).find((group) => group.lines.some((line) => line.pr.url === url))?.lines ?? [];
  const at = lines.findIndex((line) => line.pr.url === url);
  const position = lines[at]?.position;
  return position === undefined ? { before: [] } : { position, before: lines.slice(0, at) };
}

// "#512, #514 and #515"
const listOf = (items: string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${t('pr.block.and')} ${items.at(-1)}`);

// No check run and no workflow awaiting approval: nothing to say, the row is left out
const shownChecks = (checks?: Checks): Checks | undefined =>
  (checks !== undefined && (checks.items.length > 0 || (checks.awaiting?.length ?? 0) > 0) ? checks : undefined);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={MUTED}>{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

// One row per person (reviewersOf): an avatar for a user, the login, "team" for a team, the state in its colour. #68: on a PR no task holds
// the viewer's own row reads "you", as the handoff's variant draws it; a task's PR keeps the login
function ReviewValue({ pr, shouldSayYou }: { pr: PrData; shouldSayYou: boolean }) {
  const reviewers = reviewersOf(pr);
  if (reviewers.length === 0) return <span className={MUTED}>{t('pr.block.none')}</span>;
  return (
    <ul className="flex flex-col gap-1.5">
      {reviewers.map((r) => (
        <li key={`${r.team ? 'team' : 'user'}:${r.login}`} className="flex min-w-0 items-center gap-1.5">
          {!r.team && <AssigneeCell logins={[r.login]} />}
          <span className="truncate">{shouldSayYou && !r.team && r.login === pr.viewer ? t('pr.block.you') : r.login}</span>
          {r.team && <span className={MUTED}>{t('pr.block.team')}</span>}
          <span className={`shrink-0 ${REVIEWER_TONE[r.state]}`}>{t(`pr.block.reviewer.${r.state}`)}</span>
        </li>
      ))}
    </ul>
  );
}

// The conversation's checks box in one line (#758): its worst mark, how many passed of all, and when they completed
function ChecksValue({ checks }: { checks: Checks }) {
  if (checks.items.length === 0) return <span className={MUTED}>{`◷ ${t('pr.block.checks.awaiting')}`}</span>;
  const count = (state: PrCheck['state']): number => checks.items.filter((c) => c.state === state).length;
  const mark = MARK[worstOf(count('failure'), count('pending'))];
  const at = checks.at === undefined ? '' : ` · ${relativeTime(checks.at)}`;
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={mark.tone}>{mark.mark}</span>
      <span>{`${t('pr.block.checks.count', { n: count('success'), m: checks.items.length })}${at}`}</span>
    </span>
  );
}

// The merge box's own branches (PrMergeBox), so the panel and the box never disagree: conflicts, then a PR no task holds awaiting a review
// (#68), then no push rights, then the stack's order
// or GitHub's blocker, else ready with the merge button's method. ponytail: the method is read at render, so a new pick in the button's menu
// shows on the next read of the PR; lift the pick into shared state if that lag ever matters
function mergeLine(pr: PrData, task: Task | undefined, orderBlocker: string | undefined): { tone: string; text: string } {
  if (pr.mergeState === 'conflicts') return { tone: 'text-destructive', text: t('pr.block.merge.conflicts') };
  if (awaitsReview(pr, task)) return { tone: MUTED, text: t('pr.merge.awaitsReview') };
  if (!pr.canPush) return { tone: MUTED, text: t('pr.block.merge.noPermission') };
  const reason = mergeOffReason(pr, orderBlocker);
  if (reason !== undefined) return { tone: 'text-waiting', text: reason };
  const method = pickMethod(pr.url, pr.methods);
  return { tone: 'text-working', text: method === undefined ? t('pr.merge.ready') : t('pr.block.merge.ready', { method: t(`pr.method.${method}`) }) };
}

function MergeValue({ pr, task, orderBlocker }: { pr: PrData; task?: Task; orderBlocker?: string }) {
  if (pr.state !== 'open') return <span className={pr.state === 'merged' ? 'text-review' : MUTED}>{t(`detail.pr.${pr.state}`)}</span>;
  const { tone, text } = mergeLine(pr, task, orderBlocker);
  return <span className={tone}>{`● ${text}`}</span>;
}

// The base branch, the slices before this one that merged, and the open one the merge waits for
function BaseValue({ baseRef, merged, waits }: { baseRef: string; merged: string[]; waits?: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="font-mono">{baseRef}</span>
      {merged.length > 0 && <span className={MUTED}>{`· ${tPlural('pr.block.base.merged', merged.length, { list: listOf(merged) })}`}</span>}
      {waits !== undefined && <span className="text-waiting">{`· ${t('pr.block.base.waits', { n: prNumber(waits) })}`}</span>}
    </span>
  );
}

// A PR no task holds (#68): the author's branch → the base, owner:ref on both sides for a fork's PR, as the conversation's PR line writes it
function BranchValue({ pr }: { pr: PrData }) {
  const across = pr.headOwner !== pr.baseOwner;
  return (
    <span className="block truncate font-mono">
      {across ? `${pr.headOwner}:${pr.headRef}` : pr.headRef}
      <span className={`font-sans ${MUTED}`}>{` → ${across ? `${pr.baseOwner}:${pr.baseRef}` : pr.baseRef}`}</span>
    </span>
  );
}

/** A closing issue as #N in the PR's own repository, owner/repo#N in another (#66): this PR's closes row and the PR page's tab bar (#68). */
export const closingLabel = (issue: PrClosingIssue, prUrl: string): string =>
  (issue.repository.toLowerCase() === prRepo(prUrl).toLowerCase() ? `#${issue.number}` : `${issue.repository}#${issue.number}`);

// Each issue the PR closes: #N in the PR's own repository, owner/repo#N in another; "on merge" while it can still merge
function ClosesValue({ pr, onOpenIssue }: { pr: PrData; onOpenIssue(url: string): void }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      {pr.closes.map((issue) => (
        <button key={issue.url} type="button" className="text-review hover:underline" onClick={() => onOpenIssue(issue.url)}>
          {closingLabel(issue, pr.url)}
        </button>
      ))}
      {pr.state === 'open' && <span className={MUTED}>{t('pr.block.closes.onMerge')}</span>}
    </span>
  );
}

export interface PrBlockProps { pr: PrData; task?: Task; state: State; onOpenIssue(url: string): void }

/** this PR (#66, handoff section 7): a PR's box in the details panel's slot, its header with the stack position, then review, checks, merge,
 * base and closes. A PR no task holds (#68) has no stack: #N alone, the author's branch in base's place, "you" on the viewer's row. Drawn from
 * the page's PrData, so the header's refresh, the checks' poll and every write update it. */
export function PrBlock({ pr, task, state, onOpenIssue }: PrBlockProps) {
  const prs = task === undefined ? [] : prsOf(state, task.item.itemId);
  const { position, before } = stackOf(prs, pr.url);
  const orderBlocker = pr.state === 'open' ? mergeOrderBlocker(prs, pr.url) : undefined;
  const merged = before.filter((line) => line.pr.state === 'merged').map((line) => `#${prNumber(line.pr.url)}`);
  const checks = shownChecks(pr.checks);
  return (
    <section aria-label={t('pr.block.title')} className="flex flex-col gap-3 rounded-lg border p-3 text-xs">
      <header className="flex items-baseline gap-1.5">
        <span className="font-medium text-foreground">{t('pr.block.title')}</span>
        <span className={MUTED}>{position === undefined ? `#${pr.number}` : t('pr.block.position', { n: pr.number, k: position.k, total: position.total })}</span>
      </header>
      <dl className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-2 gap-y-2.5">
        <Row label={t('pr.block.review')}><ReviewValue pr={pr} shouldSayYou={task === undefined} /></Row>
        {checks !== undefined && <Row label={t('pr.block.checks')}><ChecksValue checks={checks} /></Row>}
        <Row label={t('pr.block.merge')}><MergeValue pr={pr} task={task} orderBlocker={orderBlocker} /></Row>
        {task === undefined
          ? <Row label={t('pr.block.branch')}><BranchValue pr={pr} /></Row>
          : <Row label={t('pr.block.base')}><BaseValue baseRef={pr.baseRef} merged={merged} waits={orderBlocker} /></Row>}
        {pr.closes.length > 0 && <Row label={t('pr.block.closes')}><ClosesValue pr={pr} onOpenIssue={onOpenIssue} /></Row>}
      </dl>
    </section>
  );
}
