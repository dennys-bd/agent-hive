import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CenterMode } from '@/hooks/use-activity';
import { type MessageKey, t } from '@/i18n';
import { type PanelId, VIEW_SHORTCUTS } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';
import { WINDOW_CHROME } from '@/lib/window-chrome';
import { displayBinding } from '../../shortcuts';
import type { Signal } from '../../types';

interface HeaderProps { signal: Signal; center: CenterMode; onView(panel: PanelId): void }

// The hexagon reads the effective signal at a glance, as the tray icon does
const SIGNAL_TEXT: Record<Signal, string> = { green: 'text-signal-green', yellow: 'text-signal-yellow', red: 'text-signal-red' };
const VIEW_LABEL: Record<CenterMode, MessageKey> = { automation: 'header.flow', activities: 'header.activities' };
// The mark in the header is one filled hexagon, the honeycomb's centre cell (the handoff's ⬢), in the signal's colour
function HiveMark({ signal }: { signal: Signal }) {
  return (
    <svg viewBox="-88 -88 176 176" aria-hidden="true" className={`size-3 ${SIGNAL_TEXT[signal]}`} data-signal={signal} fill="currentColor">
      <polygon points="0,-88 76,-44 76,44 0,88 -76,44 -76,-44" />
    </svg>
  );
}

function ViewSwitch({ center, onView }: Pick<HeaderProps, 'center' | 'onView'>) {
  return (
    <ToggleGroup type="single" value={center} onValueChange={(value) => value && onView(value as PanelId)} spacing={0.5} className="rounded-md bg-muted p-0.5 [-webkit-app-region:no-drag]">
      {VIEW_SHORTCUTS.map(([panel, id]) => {
        const keys = binding(id);
        return (
          <ToggleGroupItem
            key={panel} value={panel}
            className="h-auto gap-1.5 rounded-sm px-2.5 py-[3px] text-[13px] font-medium data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            {t(VIEW_LABEL[panel as CenterMode])}
            {keys !== null && <span className="text-[11px] font-normal tracking-[.1em] text-muted-foreground">{displayBinding(keys, isMac())}</span>}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

/** The window's top bar (#533): the mark and the view switcher; the agents' plan usage lives in the footer (#223). The native title bar is
 * hidden (main.ts), so the left padding clears the traffic lights and the bar drags the window; its controls opt out of the drag to keep
 * their clicks. */
export function Header({ signal, center, onView }: HeaderProps) {
  return (
    <header className={`flex shrink-0 items-center gap-4 border-b pr-3 ${WINDOW_CHROME}`}>
      <div className="flex items-center gap-1.5">
        <HiveMark signal={signal} />
        <span className="text-[13px] font-semibold">{t('header.brand')}</span>
      </div>
      <ViewSwitch center={center} onView={onView} />
    </header>
  );
}
