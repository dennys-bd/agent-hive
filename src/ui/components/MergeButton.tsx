import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { type MergeBlocker, mergeBlocker } from '../../pr-github';
import { prNumber, prRepo } from '../../pull-requests';
import type { MergeMethod, PrData, Task } from '../../types';
import { prMerge } from '@/components/pr-actions';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { type MessageKey, t } from '@/i18n';
import { pickMethod, rememberMethod } from '@/lib/merge-method';

const BLOCKER_KEY: Record<MergeBlocker, MessageKey> = {
  merged: 'pr.blocker.merged', closed: 'pr.blocker.closed', draft: 'pr.blocker.draft', conflicts: 'pr.blocker.conflicts', blocked: 'pr.blocker.blocked',
  behind: 'pr.blocker.behind', unknown: 'pr.blocker.unknown',
};
const METHOD_KEY: Record<MergeMethod, MessageKey> = { squash: 'pr.method.squash', merge: 'pr.method.merge', rebase: 'pr.method.rebase' };

/** Why the merge is off (#592, #698): an earlier slice of the stack still open comes first, merging past it breaks the stack; then GitHub's
 * reason; undefined while it may merge. The merge box says it in words, the button as its tooltip. */
export function mergeOffReason(pr: PrData, orderBlocker: string | undefined): string | undefined {
  if (orderBlocker !== undefined) return t('pr.blocker.order', { n: prNumber(orderBlocker) });
  if (!pr.canPush) return t('pr.merge.noPermissionTitle', { repo: prRepo(pr.url) }); // #854: the merge is a maintainer's
  const blocker = mergeBlocker(pr);
  return blocker === undefined ? undefined : t(BLOCKER_KEY[blocker]);
}

/** A PR no task holds that GitHub holds for a review (#68): open, no conflicts, reviewDecision REVIEW_REQUIRED. The merge box, the this PR
 * block and the merge button say "awaits review" rather than offer a merge GitHub would refuse; a task's PR keeps #592's rule. */
export const awaitsReview = (pr: PrData, task: Task | undefined): boolean =>
  task === undefined && pr.state === 'open' && pr.mergeState !== 'conflicts' && pr.decision === 'pending';

interface MergeButtonProps {
  pr: PrData; orderBlocker?: string; variant?: 'default' | 'outline'; onSettled(): void; onMerged?(): void;
  offReason?: string; // #68: a reason of the caller's (awaits review) that turns the button off with it as the tooltip
}

/** {method} and merge ⌄ (#592, #758): a split button over the methods the repository allows, the last pick remembered per repository. Off
 * with mergeOffReason as the tooltip, on the wrapper since a disabled button shows none; outline at .6 in the conflict box. No confirmation:
 * the click is the user's gesture. Pending while the call runs; GitHub's message beside it on a refusal. The PR is read again (onSettled)
 * either way, except when a success leaves the page (onMerged, #69): the back unmounts it, so a re-read would race the unmount. */
export function MergeButton({ pr, orderBlocker, variant = 'default', offReason, onSettled, onMerged }: MergeButtonProps) {
  const [method, setMethod] = useState(() => pickMethod(pr.url, pr.methods));
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const reason = offReason ?? mergeOffReason(pr, orderBlocker);
  const merge = (): void => {
    if (method === undefined) return;
    setPending(true);
    void prMerge(pr.url, { method, head: pr.head })
      .then(() => {
        setError(undefined);
        if (onMerged === undefined) onSettled();
        else onMerged();
      }, (err: Error) => {
        setError(err.message);
        onSettled();
      })
      .finally(() => setPending(false));
  };
  const pick = (value: string): void => {
    const picked = pr.methods.find((m) => m === value);
    if (picked === undefined) return;
    rememberMethod(pr.url, picked);
    setMethod(picked);
  };
  const label = method === undefined ? t('pr.merge') : t('pr.merge.button', { method: t(METHOD_KEY[method]) });
  const dim = variant === 'outline' ? 'disabled:opacity-60' : '';
  return (
    <span className="flex items-center gap-2">
      <span title={reason} className="flex">
        <Button type="button" size="xs" variant={variant} className={`rounded-r-none ${dim}`} disabled={reason !== undefined || method === undefined || isPending} onClick={merge}>
          {isPending ? t('pr.merging') : label}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="xs" variant={variant} className={`rounded-l-none border-l ${dim}`} aria-label={t('pr.mergeMethod')} disabled={isPending}>
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={method} onValueChange={pick}>
              {pr.methods.map((m) => <DropdownMenuRadioItem key={m} value={m}>{t(METHOD_KEY[m])}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {error !== undefined && <span role="alert" className="text-destructive">{error}</span>}
    </span>
  );
}
