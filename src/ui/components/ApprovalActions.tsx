import { type KeyboardEvent, type Ref, useEffect, useRef, useState } from 'react';
import { type Activity, type Task, FEEDBACK_MAX, type OperationId } from '../../types';

/** What the approval's controls read of the task's live activity (#629): its approval and its id, the routes' :id. */
type ApprovalOf = Pick<Activity, 'id' | 'approval'>;
import { displayBinding } from '../../shortcuts';
import { act } from '@/components/actions';
import { DecompositionDialog } from '@/components/DecompositionDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { binding, isMac, pressed } from '@/lib/shortcut-bindings';
import { countdown } from '@/lib/usage';

// The detail's buttons (redesign 06): 28px tall at 13px, the outline one a bare border with no fill and no shadow, as the handoff draws them
export const DETAIL_BUTTON = 'h-7 px-3 text-[13px]';
export const DETAIL_OUTLINE = `${DETAIL_BUTTON} bg-transparent shadow-none dark:bg-transparent`;
const SEND = 'gap-1 whitespace-nowrap px-2'; // the send buttons are narrower, so both fit beside each other with their shortcuts

// A send button's hint (#446): its shortcut as the user reads it (⌘↵) beside the text, none while the shortcut is off. aria-hidden keeps
// it out of the button's name. Read at every render, so a Settings save shows on the next one.
function KeyHint({ id }: { id: OperationId }) {
  const current = binding(id);
  if (current === null) return null;
  return <span aria-hidden className="font-normal text-[11px] opacity-60">{displayBinding(current, isMac())}</span>;
}

/** The textarea and send button(s) of the feedback box (#268, #379, redesign 06): enviar on a held session, which goes on at once; começar
 * agora or na ordem without one, disabled while the text is blank, with the hint that tells them apart. Shared by the detail's status box
 * and the task menu's dialog so they cannot drift; they differ only in what a send does next: the box (no `onError`) posts through `act`,
 * whose own toast covers a failure; the dialog passes both, so a failure keeps it open with the text kept and the error shown inline, and a
 * success closes it. The textarea presses them by key too (#446): confirm is começar agora, or enviar on a held session, and
 * feedbackQueue is na ordem. It never takes the focus by itself (#685): the status box shows it always, and opening the details must not
 * steal the cursor; `inputRef` lets the F key's request put it there. Escape leaves the field with its text, so the next one closes the
 * panel; in the dialog the same press also closes it.
 * `openSession`: the user's own session is open on the session feedback resumes (#483), so the text is typed there at once, like on a held
 * session. `activity` is the task's live one (#629), read by the caller: its approval, and the route the text posts to. */
export function FeedbackBox({ activity, openSession = false, onSuccess, onError, inputRef }: {
  activity?: ApprovalOf; openSession?: boolean; onSuccess?(): void; onError?(message: string): void; inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const [text, setText] = useState('');
  const approval = activity?.approval;
  if (!activity || !approval) return null;
  const url = `/activities/${encodeURIComponent(activity.id)}/feedback`;
  const blank = text.trim() === '';
  const sendsNow = approval.until !== undefined || openSession; // a held Stop, or the user's own session on it (#483): nothing to queue
  const send = (start: boolean) => (): void => {
    const body = { text, start };
    const result = onError ? postJson<void>(url, body) : act<void>(url, body).then(() => undefined);
    void result.then(() => onSuccess?.(), (err: Error) => onError?.(err.message));
  };
  // #446. pressed reads the saved binding at each key, so a rebind reaches an open box and an off shortcut never fires. A held session has no
  // queue: its queue key stays the textarea's. A blank text sends nothing, like the disabled buttons, but its key is still taken.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.currentTarget.blur(); // #685: nothing to cancel into, but a keyboard user must get out
      return;
    }
    const start = pressed(event.nativeEvent, 'confirm');
    if (!start && (sendsNow || !pressed(event.nativeEvent, 'feedbackQueue'))) return;
    event.preventDefault();
    if (!blank) send(start)();
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={inputRef} aria-label={t('approval.feedback')} maxLength={FEEDBACK_MAX} value={text}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
        className="field-sizing-fixed h-22 resize-none bg-background text-[13px] leading-[18px] md:text-[13px] dark:bg-background"
      />
      {!sendsNow && <p className="text-muted-foreground text-xs">{t('approval.hint')}</p>}
      <div className="flex flex-wrap gap-2">
        {sendsNow
          ? <Button type="button" size="sm" className={`${DETAIL_BUTTON} ${SEND}`} disabled={blank} onClick={send(true)}>{t('approval.send')}<KeyHint id="confirm" /></Button>
          : (
            <>
              <Button type="button" size="sm" className={`${DETAIL_BUTTON} ${SEND}`} disabled={blank} onClick={send(true)}>{t('approval.startNow')}<KeyHint id="confirm" /></Button>
              <Button type="button" size="sm" variant="outline" className={`${DETAIL_OUTLINE} ${SEND}`} disabled={blank} onClick={send(false)}>{t('approval.queue')}<KeyHint id="feedbackQueue" /></Button>
            </>
          )}
      </div>
    </div>
  );
}

// F on a focused task (#585): the details open on the task with the cursor in its band's feedback box. The band mounts a render after the
// pick, so the request waits here, one slot; a band already showing that task hears it through the event
const FEEDBACK_EVENT = 'hive:write-feedback';
let pendingFeedback: string | undefined;

/** Ask the details' band of task `itemId` to put the cursor in its feedback box (#585, #685). */
export function requestFeedback(itemId: string): void {
  pendingFeedback = itemId;
  window.dispatchEvent(new Event(FEEDBACK_EVENT));
}

/** Whether a feedback request waits for task `itemId`; taking it clears it. */
export function takeFeedbackRequest(itemId: string): boolean {
  if (pendingFeedback !== itemId) return false;
  pendingFeedback = undefined;
  return true;
}

/** The detail's status box while the task awaits approval (#268, #685, redesign 06): with a held session the time it has left; aprovar, and
 * estender on a held session; under them the feedback box, always open, on every awaiting task, manual gates included. Keyed by `since` in
 * the panel, so a new stage end mounts an empty box. `activity` is the task's live one (#629). `createsIssues` (#865): the stage's
 * decomposition is not on GitHub yet, so criar issues takes aprovar's place and opens the confirm that writes it and ends the stage. */
export function ApprovalActions({ task, activity, openSession = false, createsIssues = false }: { task: Task; activity?: ApprovalOf; openSession?: boolean; createsIssues?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [isCreating, setIsCreating] = useState(false);
  // A request from the F key (#585), taken on mount and whenever one arrives: the cursor goes into the box. In an effect, which runs once the
  // textarea is in the document; StrictMode's second run finds the request already taken
  const { itemId } = task.item;
  useEffect(() => {
    const take = (): void => { if (takeFeedbackRequest(itemId)) input.current?.focus(); };
    take();
    window.addEventListener(FEEDBACK_EVENT, take);
    return () => window.removeEventListener(FEEDBACK_EVENT, take);
  }, [itemId]);
  const approval = activity?.approval;
  if (!activity || !approval) return null;
  const url = (path: string): string => `/activities/${encodeURIComponent(activity.id)}/${path}`;
  const { until } = approval;
  return (
    <>
      {until !== undefined && <p className="text-muted-foreground text-xs">{t('worker.approvalLeft', { time: countdown(until, Date.now()) })}</p>}
      <div className="flex flex-wrap gap-2">
        {createsIssues
          ? <Button type="button" size="sm" className={DETAIL_BUTTON} onClick={() => setIsCreating(true)}>{t('decomposition.create')}</Button>
          : <Button type="button" size="sm" className={DETAIL_BUTTON} onClick={() => act(url('approve'))}>{t('approval.approve')}</Button>}
        {until !== undefined && <Button type="button" size="sm" variant="outline" className={DETAIL_OUTLINE} onClick={() => act(url('approval/extend'))}>{t('approval.extend')}</Button>}
      </div>
      <FeedbackBox activity={activity} openSession={openSession} inputRef={input} />
      {isCreating && <DecompositionDialog activityId={activity.id} onClose={() => setIsCreating(false)} />}
    </>
  );
}

/** Right-click › Enviar feedback… (#268, #379): the same box as the band, beside the task menu so a click inside it never reaches the task
 * (like OpenSessionDialog). Closes on a successful send; a failure keeps it open with the text kept and the error shown inline. Renders
 * nothing once the task leaves approval (approved from elsewhere while the dialog was open). */
export function FeedbackDialog({ activity, openSession = false, onClose }: { activity?: ApprovalOf; openSession?: boolean; onClose(): void }) {
  const [error, setError] = useState<string>();
  if (!activity?.approval) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t('task.sendFeedback')}</DialogTitle></DialogHeader>
        <FeedbackBox activity={activity} openSession={openSession} onSuccess={onClose} onError={setError} />
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
