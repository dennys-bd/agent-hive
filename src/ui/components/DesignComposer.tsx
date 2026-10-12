import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { displayBinding, matches } from '../../shortcuts';
import type { DesignTarget, UnpinnedDesignAnchor } from '../../types';
import { pinColours } from '@/components/DesignPins';
import { saveDraft, sendComment } from '@/components/review-actions';
import { Button } from '@/components/ui/button';
import type { DesignCommentsModel } from '@/hooks/use-design-comments';
import { t } from '@/i18n';
import { type DesignTheme, targetOf } from '@/lib/design-comments';
import { isMac } from '@/lib/shortcut-bindings';

// The canvas's composer (#114): a comment on the target the bridge answered, added as a draft or sent at once. No Radix popover: an
// absolutely placed box scrolls with the canvas.

const ADD_KEY = 'Enter';
const SEND_KEY = 'CmdOrCtrl+Enter';

/** adicionar and enviar agora (#114), through the panel's one request at a time: a draft for the footer's recipient, or this one comment
 *  sent to it. True once the server took it; a refusal is act's toast. */
export async function saveComment(model: DesignCommentsModel, anchor: UnpinnedDesignAnchor, text: string, isSend: boolean): Promise<boolean> {
  const { taskId, recipient } = model;
  const done = await model.run(() => (isSend
    ? sendComment(taskId, { anchor, text, to: [recipient.session] })
    : saveDraft(taskId, { anchor, text, session: recipient.session })));
  return done !== undefined;
}

export interface DesignComposerProps {
  target: DesignTarget; pin: number; theme: DesignTheme; isBusy: boolean; style: CSSProperties;
  onAdd(text: string): void; onSend(text: string): void; onCancel(): void;
}

const KeyHint = ({ binding }: { binding: string }) => <span aria-hidden="true" className="opacity-70">{displayBinding(binding, isMac())}</span>;

/** The handoff's composer (#114): the pin and the target, a textarea, esc cancela and the two buttons that name their keys. */
export function DesignComposer({ target, pin, theme, isBusy, style, onAdd, onSend, onCancel }: DesignComposerProps) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // Focused on open (a ref, as InlineBox's); closing hands the focus back to the pane, so a second esc and C still reach it
  useEffect(() => {
    const box = field.current;
    box?.focus();
    const pane = box?.closest<HTMLElement>('[data-design-pane]');
    return () => pane?.focus({ preventScroll: true });
  }, []);
  const canSubmit = !isBusy && text.trim() !== '';
  const submit = (done: (text: string) => void): void => { if (canSubmit) done(text.trim()); };
  // ↵ adds, ⇧↵ breaks the line, ⌘↵ (Ctrl↵ off macOS) sends; an input method's ↵ only ends its composition
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const key = event.nativeEvent;
    if (event.key === 'Escape') onCancel();
    else if (matches(key, SEND_KEY, isMac())) submit(onSend);
    else if (matches(key, ADD_KEY, isMac()) && !key.isComposing) submit(onAdd);
    else return;
    event.preventDefault();
  };
  const edit = pinColours('edit', theme);
  return (
    <fieldset aria-label={t('design.comment')} style={style} className="pointer-events-auto absolute z-10 min-w-0 rounded-lg border bg-popover p-2.5 text-xs shadow-md">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span aria-hidden="true" style={edit.style} className={`flex size-4 shrink-0 items-center justify-center rounded-full font-semibold text-[10px] ${edit.className}`}>{pin}</span>
        <span title={targetOf(target)} className="min-w-0 truncate font-mono">{targetOf(target)}</span>
      </div>
      <textarea
        ref={field} aria-label={t('design.comment')} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown}
        className="mt-2 min-h-14 w-full resize-y rounded-md border bg-background px-2 py-1 text-[13px] leading-[19px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="mr-auto text-muted-foreground">{t('design.composer.cancel')}</span>
        <Button type="button" size="xs" variant="outline" disabled={!canSubmit} onClick={() => submit(onAdd)}>{t('design.composer.add')}<KeyHint binding={ADD_KEY} /></Button>
        <Button type="button" size="xs" disabled={!canSubmit} onClick={() => submit(onSend)}>{t('design.composer.send')}<KeyHint binding={SEND_KEY} /></Button>
      </div>
    </fieldset>
  );
}
