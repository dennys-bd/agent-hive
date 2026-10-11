import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import type { PrData, PrReviewEventInput } from '../../types';
import { prSubmit } from '@/components/pr-actions';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { type MessageKey, t, tPlural } from '@/i18n';

interface EventChoice { id: PrReviewEventInput; label: MessageKey; hint: MessageKey }
const EVENTS: EventChoice[] = [
  { id: 'comment', label: 'pr.review.comment', hint: 'pr.review.commentHint' },
  { id: 'approve', label: 'pr.review.approve', hint: 'pr.review.approveHint' },
  { id: 'request_changes', label: 'pr.review.changes', hint: 'pr.review.changesHint' },
];

/** Whether send review may go (#758): an approval or a change request always, a comment only with a summary or a draft, since GitHub needs a
 * body for one. */
export const canSendReview = (event: PrReviewEventInput, summary: string, drafts: number): boolean => event !== 'comment' || summary.trim() !== '' || drafts > 0;

// One choice of the event (handoff 03): its name and what it does, the chosen one on muted; off on one's own PR, with GitHub's reason
function EventOption({ choice, isChecked, isOff, onPick }: { choice: EventChoice; isChecked: boolean; isOff: boolean; onPick(event: PrReviewEventInput): void }) {
  return (
    <label title={isOff ? t('pr.review.own') : undefined} className={`flex items-start gap-2 rounded-md px-2 py-1 text-xs ${isChecked ? 'bg-muted' : ''} ${isOff ? 'opacity-50' : ''}`}>
      <input type="radio" name="pr-review-event" className="mt-0.5" checked={isChecked} disabled={isOff} onChange={() => onPick(choice.id)} />
      <span><span className="font-medium">{t(choice.label)}</span> <span className="text-muted-foreground">{t(choice.hint)}</span></span>
    </label>
  );
}

export interface ReviewPopoverProps {
  pr: PrData; drafts: number; onSent(): void;
  trigger?: 'bar' | 'primary'; // #68: primary, the PR without activity's "review": a default button with no chevron
}

/** review (#758, handoff 03): an outline button with the pending drafts and ⌄ that opens a 380px popover on both tabs, Esc closing it: the
 * summary, comment / approve / request changes, how many drafts go along, send review. One review with that event, the summary and every
 * draft; GitHub's refusal stays in the popover; the page reads again either way. In the details panel's PR without activity (#68) the trigger
 * is a primary button instead. */
export function ReviewPopover({ pr, drafts, onSent, trigger = 'bar' }: ReviewPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [event, setEvent] = useState<PrReviewEventInput>('comment');
  const [error, setError] = useState<string>();
  const [isSending, setIsSending] = useState(false);
  const isOwn = pr.author === pr.viewer; // GitHub refuses an approval or a change request on one's own PR
  const canSend = !isSending && canSendReview(event, summary, drafts);
  const send = (): void => {
    if (!canSend) return;
    setIsSending(true);
    void prSubmit(pr.url, { head: pr.head, event, body: summary })
      .then(() => { setSummary(''); setEvent('comment'); setError(undefined); setIsOpen(false); }, (err: Error) => setError(err.message))
      .finally(() => { setIsSending(false); onSent(); });
  };
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant={trigger === 'bar' ? 'outline' : 'default'}>
          {t('pr.review')}
          {drafts > 0 && <span className={trigger === 'bar' ? 'text-muted-foreground' : 'opacity-70'}>{t('pr.review.pending', { n: drafts })}</span>}
          {trigger === 'bar' && <ChevronDownIcon />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={trigger === 'bar' ? 'end' : 'start'} className="flex w-[380px] flex-col gap-2.5 p-3">
        <h3 className="font-semibold text-[13px]">{t('pr.review.title')}</h3>
        <Textarea aria-label={t('pr.review.summary')} placeholder={t('pr.review.summary')} value={summary} className="h-[72px]" onChange={(e) => setSummary(e.target.value)} />
        <fieldset aria-label={t('pr.review.title')} className="flex flex-col gap-1">
          {EVENTS.map((choice) => (
            <EventOption key={choice.id} choice={choice} isChecked={event === choice.id} isOff={isOwn && choice.id !== 'comment'} onPick={setEvent} />
          ))}
        </fieldset>
        {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
        <div className="flex items-center gap-2">
          <span className="flex-1 text-muted-foreground text-xs">{tPlural('pr.review.along', drafts, { n: drafts })}</span>
          <Button type="button" size="xs" disabled={!canSend} onClick={send}>{t('pr.review.send')}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
