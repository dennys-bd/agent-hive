import { useState } from 'react';
import { activityOf, prsOf } from '../../activities';
import { mergeOrderBlocker, prRepo } from '../../pull-requests';
import { answerable } from '../../transitions';
import type { PrData, State, Task } from '../../types';
import { act } from '@/components/actions';
import { awaitsReview, MergeButton, mergeOffReason } from '@/components/MergeButton';
import { ResolveDialog } from '@/components/ResolveDialog';
import { Button } from '@/components/ui/button';
import { t, tPlural } from '@/i18n';
import { viewerRequestOf } from '@/lib/pr-reviewers';

const MUTED = 'text-muted-foreground';

// What holds of the PR, each only when true (handoff 03): its approvals, its checks passing, then the box's own facts
function factsOf(pr: PrData, extra: string[]): string {
  return [
    ...(pr.approvals > 0 ? [tPlural('pr.merge.facts.approvals', pr.approvals, { n: pr.approvals })] : []),
    ...(pr.checks?.state === 'success' ? [t('pr.merge.facts.checks')] : []),
    ...extra,
  ].join(' · ');
}

function Head({ tone, title, facts }: { tone: string; title: string; facts: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-2 text-[13px]">
      <span aria-hidden="true" className={tone}>●</span>
      <span className="font-medium">{title}</span>
      {facts !== '' && <span className={`${MUTED} text-xs`}>{facts}</span>}
    </p>
  );
}

// resolve in the activity (handoff 03, #379): on a task awaiting approval whose stage takes feedback, the merge-from-base prompt goes out as
// started feedback by the feedback route's own rule (answerable), even while a session of the task is live, so the flow redoes its checks;
// on any other task the dialog picks the session it goes to
function ResolveButton({ task, base, state }: { task: Task; base: string; state: State }) {
  const [isSending, setSending] = useState(false);
  const [isPicking, setPicking] = useState(false);
  const resolve = (): void => {
    const activity = activityOf(state, task.item.itemId);
    if (activity?.approval === undefined || !answerable(state, task, 'feedback')) {
      setPicking(true);
      return;
    }
    setSending(true);
    void act(`/activities/${encodeURIComponent(activity.id)}/feedback`, { prompt: 'mergeBase', promptBase: base, start: true }).then(() => setSending(false));
  };
  return (
    <>
      <Button type="button" size="xs" disabled={isSending} onClick={resolve}>{t('pr.merge.resolve')}</Button>
      {isPicking && <ResolveDialog task={task} base={base} state={state} onClose={() => setPicking(false)} />}
    </>
  );
}

// A conflicted file (handoff 03): ⚠ in destructive, the path in mono with its directory muted
function ConflictFile({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <li className="flex items-center gap-1.5 font-mono text-xs">
      <span aria-hidden="true" className="text-destructive">⚠</span>
      <span><span className={MUTED}>{path.slice(0, cut)}</span>{path.slice(cut)}</span>
    </li>
  );
}

interface BoxProps { pr: PrData; task?: Task; state: State; orderBlocker?: string; onSettled(): void; onMerged?(): void }

// conflict (handoff 03): conflicts in N files and how far the base moved; resolve in the activity on a task's PR and the merge off in outline;
// the conflicted files and the note
function ConflictBox({ pr, task, state, orderBlocker, onSettled, onMerged }: BoxProps) {
  const files = pr.conflicts ?? [];
  const title = files.length === 0 ? t('pr.merge.conflicts') : tPlural('pr.merge.conflictsN', files.length, { n: files.length });
  const behind = pr.behindBy !== undefined && pr.behindBy > 0 ? [t('pr.merge.behind', { base: pr.baseRef, n: pr.behindBy })] : [];
  return (
    <>
      <Head tone="text-destructive" title={title} facts={factsOf(pr, behind)} />
      <div className="flex items-center gap-2">
        {task && <ResolveButton task={task} base={pr.baseRef} state={state} />}
        <MergeButton pr={pr} orderBlocker={orderBlocker} variant="outline" onSettled={onSettled} onMerged={onMerged} />
      </div>
      {files.length > 0 && <ul className="flex flex-col gap-0.5">{files.map((path) => <ConflictFile key={path} path={path} />)}</ul>}
      {task && <p className={`${MUTED} text-xs`}>{t('pr.merge.resolveNote', { base: pr.baseRef })}</p>}
    </>
  );
}

// ready, or held by another blocker, GitHub's or the stack's order (#592, #698): the reason in words with the button off; ready, the facts,
// the note on a task awaiting approval (the server's #592 rule), and the button
function ReadyBox({ pr, task, state, orderBlocker, onSettled, onMerged }: BoxProps) {
  const reason = mergeOffReason(pr, orderBlocker);
  const isAwaiting = task !== undefined && activityOf(state, task.item.itemId)?.approval !== undefined;
  return (
    <>
      <Head tone={reason === undefined ? 'text-working' : 'text-waiting'} title={reason ?? t('pr.merge.ready')} facts={factsOf(pr, reason === undefined ? [t('pr.merge.facts.clean')] : [])} />
      {reason === undefined && isAwaiting && <p className={`${MUTED} text-xs`}>{t('pr.merge.nextStage')}</p>}
      <div className="flex"><MergeButton pr={pr} orderBlocker={orderBlocker} onSettled={onSettled} onMerged={onMerged} /></div>
    </>
  );
}

// What holds besides the approvals and checks ok (handoff item 9): the workflows awaiting approval or the failed checks, then no conflicts
function permissionFacts(pr: PrData): string[] {
  const failed = pr.checks?.items.filter((c) => c.state === 'failure').length ?? 0;
  if ((pr.checks?.awaiting?.length ?? 0) > 0) return [t('pr.merge.facts.awaiting'), t('pr.merge.facts.clean')];
  return failed > 0 ? [t('pr.merge.facts.failed', { n: failed }), t('pr.merge.facts.clean')] : [t('pr.merge.facts.clean')];
}

// no push rights (#854, handoff item 9): in muted, as nothing is the user's to do; abrir no github and the merge off, its reason as the tooltip
function NoPermissionBox({ pr, orderBlocker, onSettled, onMerged }: BoxProps) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Head tone={MUTED} title={t('pr.merge.noPermission')} facts={factsOf(pr, permissionFacts(pr))} />
        <span className="flex-1" />
        <Button type="button" size="xs" variant="outline" onClick={() => window.open(pr.url, '_blank', 'noreferrer')}>{t('repos.menu.open')}</Button>
        <MergeButton pr={pr} orderBlocker={orderBlocker} variant="outline" onSettled={onSettled} onMerged={onMerged} />
      </div>
      <p className={`${MUTED} text-xs`}>{t('pr.merge.noPermissionNote', { repo: prRepo(pr.url) })}</p>
    </>
  );
}

// awaits review (#68, handoff 7): a PR no task holds that GitHub holds for a review; in muted, as the review is someone else's to give. The
// facts that hold and the merge off with the same words as its tooltip; no note, since no task moves
function NeutralBox({ pr, onSettled, onMerged }: BoxProps) {
  const title = t('pr.merge.awaitsReview');
  const facts = [
    ...(viewerRequestOf(pr) === undefined ? [] : [t('pr.merge.facts.requested')]),
    ...(pr.checks?.state === 'success' ? [t('pr.merge.facts.checks')] : []),
    t('pr.merge.facts.clean'),
  ];
  return (
    <>
      <Head tone={MUTED} title={title} facts={facts.join(' · ')} />
      <div className="flex"><MergeButton pr={pr} variant="outline" offReason={title} onSettled={onSettled} onMerged={onMerged} /></div>
    </>
  );
}

// Which box (#758, #854, #68): conflicts first; then a PR no task holds awaiting a review, before the push rights it does not depend on
function Box(props: BoxProps) {
  if (props.pr.mergeState === 'conflicts') return <ConflictBox {...props} />;
  if (awaitsReview(props.pr, props.task)) return <NeutralBox {...props} />;
  return props.pr.canPush ? <ReadyBox {...props} /> : <NoPermissionBox {...props} />;
}

export interface PrMergeBoxProps { pr: PrData; task?: Task; state: State; onSettled(): void; onMerged?(): void }

/** The merge box (#758, handoff 03): ready, in conflict, awaiting a review on a PR no task holds (#68), or held by another blocker. The merge keeps #592's rule, which the server applies; a
 * merged or closed PR has no box. */
export function PrMergeBox({ pr, task, state, onSettled, onMerged }: PrMergeBoxProps) {
  if (pr.state !== 'open') return null;
  const orderBlocker = task === undefined ? undefined : mergeOrderBlocker(prsOf(state, task.item.itemId), pr.url);
  const props: BoxProps = { pr, task, state, orderBlocker, onSettled, onMerged };
  return (
    <section aria-label={t('pr.merge')} className="flex max-w-[680px] flex-col gap-2.5 rounded-lg border p-3">
      <Box {...props} />
    </section>
  );
}
