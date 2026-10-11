import { fixedKeyTitle, keyTitle } from '@/components/KeyHint';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { stepZoom } from '@/lib/flow-zoom';

// The dark twin beats the outline variant's dark:bg-input/30, which would paint over the card (as #909's toggle does)
const FACE = 'bg-card text-foreground dark:bg-card';

interface FlowZoomProps { zoom: number; onZoom(zoom: number): void; onFit(): void }

/** The flow canvas's zoom (#910, handoff §4): − 100% + and ajustar, floating 10px from the canvas's bottom left, outside the pane that scrolls
 * and scales, so they never move. The number goes back to 100%. Each title names its key. */
export function FlowZoom({ zoom, onZoom, onFit }: FlowZoomProps) {
  return (
    <div className="absolute bottom-2.5 left-2.5 flex gap-1.5">
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
