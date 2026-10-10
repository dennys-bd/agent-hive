import { displayBinding } from '../../shortcuts';
import { useReviewSurface } from '@/components/review-surface';
import { SessionPicker } from '@/components/SessionPicker';
import { Button } from '@/components/ui/button';
import { t, tPlural } from '@/i18n';
import { isMac } from '@/lib/shortcut-bindings';

/** enviar revisão's fixed key (#591): the pane's, the field's too. */
export const SUBMIT_KEY = 'CmdOrCtrl+Shift+Enter';

/** A review's footer (#591, #592, #758): 48px, its name and counts, the key hint, sessão padrão on the diff pane, and with a submit its errors
 * and enviar revisão. A named fieldset, the repo's pattern for a group (a footer inside a section has no landmark role). */
export function DiffFooter() {
  const surface = useReviewSurface();
  const { counts, sessions, submit } = surface;
  return (
    <fieldset aria-label={surface.footer} className="flex h-12 min-w-0 shrink-0 items-center gap-3 border-t px-3 text-muted-foreground text-xs">
      <span><span className="font-medium text-foreground">{surface.footer}</span>{` · ${tPlural('review.comments', counts.drafts, { n: counts.drafts })} · ${tPlural('review.openThreads', counts.open, { n: counts.open })}`}</span>
      <span>{t('review.hint')}</span>
      {submit?.errors.map((error) => <span key={error} role="alert" className="text-destructive">{error}</span>)}
      <span className="ml-auto flex items-center gap-2">
        {sessions !== undefined && <span className="flex items-center gap-1">{t('review.defaultSession')}<SessionPicker value={sessions.defaultSession} onChange={sessions.chooseDefault} /></span>}
        {submit && (
          <Button type="button" size="xs" disabled={!submit.canSubmit} onClick={submit.submit}>
            {t('review.submit')}<span aria-hidden="true" className="opacity-70">{displayBinding(SUBMIT_KEY, isMac())}</span>
          </Button>
        )}
      </span>
    </fieldset>
  );
}
