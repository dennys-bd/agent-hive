import { BoxesIcon, KeyboardIcon, LayersIcon, type LucideIcon, SettingsIcon, WaypointsIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CenterMode } from '@/hooks/use-activity';
import { type MessageKey, t } from '@/i18n';
import { type PanelId, VIEW_SHORTCUTS } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';
import { fixedShortcut } from '../../shortcut-registry.js';
import { displayBinding, fixedKeys } from '../../shortcuts.js';

/** What the window's view rail (#220) shows and calls: the shown view, how to switch it, whether a session needs the user, and the openers
 * of the shortcut map and Settings, whose buttons render only when given. */
export interface ViewRailProps {
  center: CenterMode;
  onView(panel: PanelId): void;
  hasWaiting: boolean;
  onOpenShortcuts?(): void;
  onOpenSettings?(): void;
}

// Keyed by VIEW_SHORTCUTS' tabs, so the rail and ⌘1 / ⌘2 read one list
const VIEW: Record<CenterMode, { Icon: LucideIcon; label: MessageKey }> = {
  activities: { Icon: LayersIcon, label: 'rail.activities' },
  automation: { Icon: WaypointsIcon, label: 'rail.flow' },
};
const CELL = 'relative flex h-9 w-11 shrink-0 items-center justify-center';
const ACTIVE = 'text-foreground shadow-[inset_2px_0_0_var(--foreground)]';
const IDLE = 'text-muted-foreground enabled:hover:text-foreground disabled:opacity-50';

// Settings' ⌘, is a fixed key, not a rebindable shortcut, so binding() has no row for it: the title reads this platform's key
const settingsKey = (): string | null => fixedKeys(fixedShortcut('settings'), isMac()).at(0) ?? null;

interface RailButtonProps { Icon: LucideIcon; label: string; keys: string | null; isActive?: boolean; disabled?: boolean; onClick?(): void; children?: ReactNode }

// The handoff puts the name and the key in the title, the key as the header's view switch shows it; a screen reader gets the name alone
function RailButton({ Icon, label, keys, isActive = false, disabled, onClick, children }: RailButtonProps) {
  const title = keys === null ? label : `${label} ${displayBinding(keys, isMac())}`;
  return (
    <button
      type="button" aria-label={label} title={title} aria-current={isActive ? 'page' : undefined} disabled={disabled} onClick={onClick}
      className={`${CELL} ${isActive ? ACTIVE : IDLE}`}
    >
      <Icon aria-hidden="true" className="size-[18px]" />
      {children}
    </button>
  );
}

/** The window's view rail (#220): the views, the monitor to come, then the shortcut map and Settings at the bottom. One dot on activities
 * while any session needs the user, whatever its status: the home lists which. */
export function ViewRail({ center, onView, hasWaiting, onOpenShortcuts, onOpenSettings }: ViewRailProps) {
  return (
    <nav aria-label={t('rail.label')} className="flex w-11 shrink-0 flex-col gap-1 border-r border-border py-1.5">
      {VIEW_SHORTCUTS.map(([panel, id]) => {
        const { Icon, label } = VIEW[panel as CenterMode];
        return (
          <RailButton key={panel} Icon={Icon} label={t(label)} keys={binding(id)} isActive={center === panel} onClick={() => onView(panel)}>
            {panel === 'activities' && hasWaiting && <span data-waiting-dot="" aria-hidden="true" className="absolute top-2 right-2.5 size-1.5 rounded-full bg-waiting ring-2 ring-background" />}
          </RailButton>
        );
      })}
      <RailButton Icon={BoxesIcon} label={t('rail.monitor')} keys={null} disabled />
      <div aria-hidden="true" className="flex-1" />
      {onOpenShortcuts && <RailButton Icon={KeyboardIcon} label={t('rail.shortcutMap')} keys={binding('shortcutMap')} onClick={onOpenShortcuts} />}
      {onOpenSettings && <RailButton Icon={SettingsIcon} label={t('rail.settings')} keys={settingsKey()} onClick={onOpenSettings} />}
    </nav>
  );
}

/** The window's body (#220): the rail, then the dock. The rail sits outside DockFrame, so the dock's percent sizes keep their meaning. With no
 * rail (the terminal's harness) the dock is rendered as before, with no wrapper. */
export function DockBody({ rail, children }: { rail?: ViewRailProps; children: ReactNode }) {
  if (rail === undefined) return <>{children}</>;
  return (
    <div className="flex min-h-0 flex-1">
      <ViewRail {...rail} />
      {children}
    </div>
  );
}
