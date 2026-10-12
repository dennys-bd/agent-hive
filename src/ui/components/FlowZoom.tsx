import { useEffect, useRef, useState } from 'react';
import { fixedKeyTitle, keyTitle } from '@/components/KeyHint';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { stepZoom } from '@/lib/flow-zoom';

// The dark twin beats the outline variant's dark:bg-input/30, which would paint over the card (as #909's toggle does)
const FACE = 'bg-card text-foreground dark:bg-card';

/** How long the zoom controls stay at full opacity after a zoom change (#81): enough to read the new percentage. */
export const ZOOM_WAKE_MS = 1500;

// Full opacity for ZOOM_WAKE_MS after each change of `zoom`, whatever made it (buttons, keys, fit, wheel); not on mount, so the controls open
// faded. The cleanup clears the timer on the next change, which starts the count again, and on unmount
function useIsAwake(zoom: number): boolean {
  const [isAwake, setIsAwake] = useState(false);
  const shown = useRef(zoom);
  useEffect(() => {
    if (shown.current === zoom) return undefined;
    shown.current = zoom;
    setIsAwake(true);
    const timer = setTimeout(() => setIsAwake(false), ZOOM_WAKE_MS);
    return () => clearTimeout(timer);
  }, [zoom]);
  return isAwake;
}

interface FlowZoomProps { zoom: number; onZoom(zoom: number): void; onFit(): void }

/** The flow canvas's zoom (#910, handoff §4): − 100% + and ajustar, floating 10px from the canvas's bottom left, outside the pane that scrolls
 * and scales, so they never move. The number goes back to 100%. Each title names its key. Faded to 30% when idle, full on hover, keyboard
 * focus and for ZOOM_WAKE_MS after a zoom change (#81). */
export function FlowZoom({ zoom, onZoom, onFit }: FlowZoomProps) {
  const isAwake = useIsAwake(zoom);
  return (
    // 30% idle, as the flow's faded items; focus-visible, not focus-within, so Tab never lands on a faded control and a click does not keep them lit
    <div className={`absolute bottom-2.5 left-2.5 flex gap-1.5 transition-opacity hover:opacity-100 has-[:focus-visible]:opacity-100${isAwake ? '' : ' opacity-30'}`}>
      <div className="flex">
        <Button type="button" variant="outline" size="xs" className={FACE} aria-label={t('flow.zoom.out')} title={keyTitle(t('flow.zoom.out'), 'zoomOut')} onClick={() => onZoom(stepZoom(zoom, -1))}>
          −
        </Button>
        <Button type="button" variant="outline" size="xs" className={`${FACE} tabular-nums`} title={keyTitle(t('flow.zoom.reset'), 'zoomReset')} onClick={() => onZoom(1)}>
          {`${Math.round(zoom * 100)}%`}
        </Button>
        <Button type="button" variant="outline" size="xs" className={FACE} aria-label={t('flow.zoom.in')} title={keyTitle(t('flow.zoom.in'), 'zoomIn')} onClick={() => onZoom(stepZoom(zoom, 1))}>
          +
        </Button>
      </div>
      <Button type="button" variant="outline" size="xs" className={FACE} title={fixedKeyTitle(t('flow.zoom.fit'), 'zoomFit')} onClick={onFit}>
        {t('flow.zoom.fit')}
      </Button>
    </div>
  );
}
