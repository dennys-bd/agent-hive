import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

/** How long a notice stays (#614, #672), and so how long its bar takes to empty. */
export const NOTICE_MS = 8000;
/** Wide enough for the image's action row on one line; sonner's other toasts keep its 356px. */
export const NOTICE_WIDTH = 440;

/** Who a notice speaks of (#614): the agent and the session as its run's tab names it, and a stage's session with its stage after it. */
export function whoOf(session: string | undefined, stage: string | undefined): string {
  const who = session === undefined ? t('session.claude') : `${t('session.claude')} ${session}`;
  return stage === undefined ? who : t('closeTabNotice.stage', { who, stage });
}

// A save that failed already toasted its error; the box goes back so it never shows a choice that was not saved
function untickOnFailure(box: HTMLInputElement, save: (checked: boolean) => Promise<boolean>): void {
  const { checked } = box;
  void save(checked).then((isSaved) => { if (!isSaved) box.checked = !checked; });
}

interface NoticeShellProps {
  title: string; body: string; actions?: ReactNode;
  onSettings?(): void; onDontWarn?(checked: boolean): Promise<boolean>; onClose(): void;
}

/** A notice's card (#614, #672), the close-tab notice's and the sleep notice's: a muted dot, the title and an X; the body under the title; the
 * actions and the settings' link; não avisar de novo; a bar counting the time down. */
export function NoticeShell({ title, body, actions, onSettings, onDontWarn, onClose }: NoticeShellProps) {
  return (
    <div className="relative flex w-full flex-col gap-3 overflow-hidden rounded-lg border bg-popover p-4 text-popover-foreground text-sm shadow-md">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
          <p className="flex-1 font-semibold">{title}</p>
          <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={t('center.close')} onClick={onClose}><XIcon /></Button>
        </div>
        <p className="pl-4.5 text-muted-foreground leading-relaxed">{body}</p>
      </div>
      <div className="flex items-center gap-2">
        {actions}
        {onSettings && <button type="button" className="ml-auto cursor-pointer text-review hover:underline" onClick={onSettings}>{t('closeTabNotice.settings')}</button>}
      </div>
      {onDontWarn && (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-muted-foreground">
          <input type="checkbox" className="size-3.5 accent-primary" onChange={(e) => untickOnFailure(e.currentTarget, onDontWarn)} />
          {t('closeTabNotice.dismiss')}
        </label>
      )}
      <div aria-hidden="true" className="close-tab-countdown absolute inset-x-0 bottom-0 h-0.5 bg-muted-foreground/40" style={{ animationDuration: `${NOTICE_MS}ms` }} />
    </div>
  );
}
