import { type KeyboardEvent, useState } from 'react';
import { displayBinding, matches } from '../../shortcuts';
import { NEW_SESSION } from '../../types';
import { fieldText, storedText } from '@/components/MentionField';
import { BOX, lineLabel } from '@/components/review-context';
import { type CommentTarget, useReviewSurface } from '@/components/review-surface';
import { ReviewField } from '@/components/ReviewField';
import { SessionPicker } from '@/components/SessionPicker';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { chipText } from '@/lib/mentions';
import { isMac } from '@/lib/shortcut-bindings';

/** The box's fixed send key (#591), read only in its field. */
export const SEND_KEY = 'CmdOrCtrl+Enter';
/** adicionar à revisão's fixed key (#591), read only in the box's field. */
export const ADD_KEY = 'Alt+Enter';

// A send's key beside its text, as the footer's enviar revisão shows its own; aria-hidden keeps it out of the button's name
const Keys = ({ binding }: { binding: string }) => <span aria-hidden="true" className="opacity-70">{displayBinding(binding, isMac())}</span>;

// A draft's chip: only its own session's, the one a draft goes to (the server's draftMentions); a GitHub draft has none
const draftChips = ({ draft }: CommentTarget): string[] => (draft?.session !== undefined && draft.text.includes(chipText(draft.session)) ? [draft.session] : []);

/** A comment box under its last line (#591, #592): `linhas X–Y`, the field, enviar (⌘↵) and adicionar à revisão (⌥↵), the session they go to
 * on the diff pane, cancelar (Esc). */
export function CommentBox({ target, onClose }: { target: CommentTarget; onClose(): void }) {
  const surface = useReviewSurface();
  const [chips, setChips] = useState<string[]>(() => draftChips(target));
  const [text, setText] = useState(() => fieldText(target.draft?.text ?? '', chips));
  const [session, setSession] = useState(target.draft?.session ?? surface.sessions?.defaultSession ?? NEW_SESSION);
  const isOneSession = chips.length <= 1; // a draft holds one session (#591)
  const body = storedText(text, chips);
  const send = (): void => {
    if (body === '') return;
    onClose();
    const recipients = chips.length > 0 ? { mentions: chips } : surface.sessions === undefined ? {} : { to: [session] };
    void surface.comment(target.anchor, body, { ...recipients, ...(target.draft === undefined ? {} : { replaces: target.draft.id }) });
  };
  const add = (): void => {
    if (body === '' || !isOneSession) return;
    onClose();
    const to = surface.sessions === undefined ? undefined : (chips[0] ?? session); // one chip: the draft goes to that chip's session
    void (target.draft === undefined ? surface.addDraft(target.anchor, body, to) : surface.editDraft(target.draft.id, body, to));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    const action = matches(event, ADD_KEY, isMac()) ? add : matches(event, SEND_KEY, isMac()) ? send : undefined;
    if (action === undefined) return;
    event.preventDefault();
    action();
  };
  return (
    // fieldset carries role="group" natively, the repo's pattern over a plain div (#512)
    <fieldset aria-label={lineLabel(target.anchor)} className={`${BOX} min-w-0`}>
      <div className="text-muted-foreground text-xs">{lineLabel(target.anchor)}</div>
      <ReviewField autoFocus label={t('review.box')} value={text} chips={chips} onChange={(next, picked) => { setText(next); setChips(picked); }} onKeyDown={onKeyDown} />
      <div className="mt-2 flex items-center gap-2">
        <Button type="button" size="xs" disabled={body === ''} onClick={send}>{t('review.send')}<Keys binding={SEND_KEY} /></Button>
        <Button type="button" size="xs" variant="outline" disabled={body === '' || !isOneSession} onClick={add}>{t('review.addToReview')}<Keys binding={ADD_KEY} /></Button>
        {surface.sessions !== undefined && <SessionPicker value={session} onChange={setSession} />}
        <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={onClose}>{t('review.cancel')}</Button>
      </div>
    </fieldset>
  );
}
