import { XIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, type ReactNode, type Ref, useRef, useState } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { isMac } from '@/lib/shortcut-bindings';

/** One confirming action of a dialog (#75): its button's text and what it runs. A returned promise holds the dialog open until it settles.
 * danger (#461): the primary of an action that destroys, red, the one place colour marks a status in a dialog. */
export interface DialogAction { label: string; onConfirm(): void | Promise<void>; disabled?: boolean; pending?: boolean; danger?: boolean }

export interface DialogBaseProps {
  title: string; children: ReactNode; primary: DialogAction;
  context?: ReactNode; secondary?: DialogAction; tertiary?: DialogAction; error?: string;
  cancelLabel?: string; closeButton?: boolean; initialFocus?: 'close' | 'primary' | 'none'; size?: 'default' | 'sm';
  trigger?: ReactElement; open?: boolean; onOpenChange?(open: boolean): void;
}

type Slot = 'primary' | 'secondary' | 'tertiary';

// The handoff's footer buttons: 13px medium, 6px by 12px, radius 6
const FOOTER_BUTTON = 'h-auto px-3 py-1.5 text-[13px]';

// The one keyboard rule (#75): Enter alone runs the primary, ⌘+Enter (Ctrl+Enter off macOS) the secondary, ⌥+Enter the tertiary; any other mix none
function slotOf(event: KeyboardEvent): Slot | undefined {
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  const otherMod = isMac() ? event.ctrlKey : event.metaKey;
  if (event.shiftKey || otherMod || (mod && event.altKey)) return undefined;
  if (mod) return 'secondary';
  return event.altKey ? 'tertiary' : 'primary';
}

// A textarea or an editable region keeps Enter as its newline
const isMultiLine = (target: EventTarget): boolean =>
  target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);

// The dialog's own open state with a trigger, the caller's with `open`. A rejected action leaves it open, the caller saying why through
// `error`; while a promise is pending nothing runs again, so a second Enter never posts twice
function useDialogState(open: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined) {
  const [own, setOwn] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const setOpen = (next: boolean): void => {
    if (open === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  const run = (action: DialogAction | undefined): void => {
    if (action === undefined || action.disabled || action.pending || isBusy) return;
    const result = action.onConfirm();
    if (!(result instanceof Promise)) {
      setOpen(false);
      return;
    }
    setIsBusy(true);
    void result.then(() => setOpen(false), () => undefined).finally(() => setIsBusy(false));
  };
  return { isOpen: open ?? own, setOpen, run, isBusy };
}

interface HeaderProps { title: string; context?: ReactNode; closeLabel?: string; closeRef: Ref<HTMLButtonElement> }

// The handoff's header: the title with the muted × at its right, the context line under them
function DialogHeader({ title, context, closeLabel, closeRef }: HeaderProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-start justify-between gap-4">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {closeLabel !== undefined && (
          <AlertDialogCancel ref={closeRef} variant="ghost" size="icon-xs" aria-label={closeLabel} className="text-muted-foreground">
            <XIcon />
          </AlertDialogCancel>
        )}
      </div>
      {context !== undefined && <div className="text-[13px] text-muted-foreground">{context}</div>}
    </div>
  );
}

interface FooterProps { cancelLabel: string; actions: Record<Slot, DialogAction | undefined>; isBusy: boolean; primaryRef: Ref<HTMLButtonElement>; run(action: DialogAction): void }

// cancel, then the tertiary, the secondary and the primary at the right edge; the primary is red only when it destroys (#461)
function DialogFooter({ cancelLabel, actions, isBusy, primaryRef, run }: FooterProps) {
  const button = (slot: Slot): ReactNode => {
    const action = actions[slot];
    if (action === undefined) return null;
    const variant = slot !== 'primary' ? 'outline' : action.danger === true ? 'destructive' : 'default';
    return (
      <Button
        key={slot} ref={slot === 'primary' ? primaryRef : undefined} type="button" size="sm" variant={variant}
        className={FOOTER_BUTTON} disabled={action.disabled === true || action.pending === true || isBusy} onClick={() => run(action)}
      >
        {action.label}
      </Button>
    );
  };
  return (
    <AlertDialogFooter>
      <AlertDialogCancel size="sm" className={FOOTER_BUTTON}>{cancelLabel}</AlertDialogCancel>
      {button('tertiary')}{button('secondary')}{button('primary')}
    </AlertDialogFooter>
  );
}

/** Every confirmation's dialog (#75), and where every new dialog starts: a sentence-case title with a × that takes the focus on open, an
 * optional context line, the body, and lowercase buttons. Enter runs the primary wherever the focus is, Esc cancels, ⌘/Ctrl+Enter the
 * secondary, ⌥+Enter the tertiary. */
export function DialogBase({
  title, children, primary, context, secondary, tertiary, error, cancelLabel = t('settings.cancel'), closeButton = true, initialFocus = 'close',
  size = 'default', trigger, open, onOpenChange,
}: DialogBaseProps) {
  const state = useDialogState(open, onOpenChange);
  const closeRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const actions = { primary, secondary, tertiary };
  const onOpenAutoFocus = (event: Event): void => {
    event.preventDefault(); // Radix would focus the cancel, whose ring reads as the chosen answer
    if (initialFocus !== 'none') (initialFocus === 'close' ? closeRef : primaryRef).current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A held key's repeats, an IME's commit (229 when isComposing is already false), and an Enter a portaled child (a select's menu) took
    if (event.key !== 'Enter' || event.repeat || event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    const slot = slotOf(event);
    if ((slot === undefined || slot === 'primary') && isMultiLine(event.target)) return;
    event.preventDefault(); // ahead of the focused button's own Enter: on the × it confirms, never cancels
    if (slot !== undefined) state.run(actions[slot]);
  };
  return (
    <AlertDialog open={state.isOpen} onOpenChange={state.setOpen}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent size={size} onOpenAutoFocus={onOpenAutoFocus} onKeyDown={onKeyDown}>
        <DialogHeader title={title} context={context} closeLabel={closeButton ? cancelLabel : undefined} closeRef={closeRef} />
        {children}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter cancelLabel={cancelLabel} actions={actions} isBusy={state.isBusy} primaryRef={primaryRef} run={state.run} />
      </AlertDialogContent>
    </AlertDialog>
  );
}
