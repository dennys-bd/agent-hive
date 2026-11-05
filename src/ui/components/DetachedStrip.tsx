import { CornerUpLeftIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { WINDOW_DRAG, WINDOW_INSET, windowOverlay } from '@/lib/window-chrome';

export interface DetachedStripProps { title: string; canGoBack: boolean; onBack(): void }

/** A detached window's title strip (#553): the main header's 44px (WINDOW_DRAG), which the traffic lights are placed for, dragging the window as it does (#535), the left inset clearing the traffic
 *  lights (none in full screen, index.css's --window-inset), the activity's title as its bar shows it, and the back button, which docks the
 *  focused group's shown tab. On Windows (#648) its right padding clears the caption buttons (data-window-overlay). */
export function DetachedStrip({ title, canGoBack, onBack }: DetachedStripProps) {
  return (
    <header {...windowOverlay('strip')} className={`flex shrink-0 items-center gap-2 border-b pr-1.5 ${WINDOW_DRAG} ${WINDOW_INSET}`}>
      <span className="min-w-0 flex-1 truncate font-semibold text-[13px] leading-4">{title}</span>
      <Button
        type="button" variant="ghost" size="icon" aria-label={t('window.back')} title={t('window.back')} disabled={!canGoBack} onClick={onBack}
        className="size-7 text-muted-foreground [-webkit-app-region:no-drag]"
      >
        <CornerUpLeftIcon />
      </Button>
    </header>
  );
}
