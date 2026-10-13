import { FolderTreeIcon, ListIcon, type LucideIcon, PanelLeftIcon, PanelRightIcon } from 'lucide-react';
import type { EffectiveLimits, State } from '../../types.js';
import { HeaderBrand } from '@/components/HeaderBrand';
import { Button } from '@/components/ui/button';
import { keyTitle } from '@/components/ViewRail';
import type { HeaderShell, RightPane } from '@/hooks/use-header-shell';
import { t } from '@/i18n';
import { runShortcut } from '@/lib/dock-layout';
import { headerColumns } from '@/lib/header-columns';
import { binding } from '@/lib/shortcut-bindings';
import { WINDOW_DRAG, WINDOW_INSET } from '@/lib/window-chrome';

interface HeaderProps { shell: HeaderShell; state: State; effective: EffectiveLimits }

// The header drags the window: each of its own controls opts out to keep its clicks; the empty space and the bar's text keep dragging
const NO_DRAG = '[-webkit-app-region:no-drag]';
const ICON_BUTTON = `size-7 ${NO_DRAG}`; // the handoff's ghost 28×28 around a 16px icon
// Always both, in order: a pane the side cannot show is disabled, never removed, so the row does not jump (more panes are coming)
const PANES: ReadonlyArray<[RightPane, LucideIcon]> = [['files', FolderTreeIcon], ['details', ListIcon]];

interface SideButtonProps { Icon: LucideIcon; label: string; keys: string | null; disabled?: boolean; className?: string; onClick(): void }

// panel-left and panel-right: the name for a screen reader, the name and the key in the title, as the rail's buttons; the click runs the
// key's own operation, so a rebound or turned-off key behaves the same
function SideButton({ Icon, label, keys, disabled, className = '', onClick }: SideButtonProps) {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} title={keyTitle(label, keys)} disabled={disabled} onClick={onClick} className={`${ICON_BUTTON} text-muted-foreground ${className}`}>
      <Icon aria-hidden="true" className="size-4" />
    </Button>
  );
}

// The right column: one icon per pane, the shown one on --accent, then the shown pane's name at the column's end
function RightColumn({ width, panes }: { width?: string; panes: HeaderShell['panes'] }) {
  return (
    <div data-header-column="right" style={{ width }} className="flex shrink-0 items-center gap-1 overflow-hidden border-l px-2">
      {PANES.map(([pane, Icon]) => {
        const isActive = panes.active === pane;
        return (
          <Button
            key={pane} type="button" variant="ghost" size="icon" aria-label={t(`files.tab.${pane}`)} title={t(`files.tab.${pane}`)} aria-pressed={isActive}
            disabled={!panes.enabled[pane]} onClick={() => panes.pick(pane)} className={`${ICON_BUTTON} ${isActive ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
          >
            <Icon aria-hidden="true" className="size-4" />
          </Button>
        );
      })}
      {panes.active && <span className="ml-auto truncate text-muted-foreground text-xs">{t(`files.tab.${panes.active}`)}</span>}
    </div>
  );
}

/** The window's top bar (#533, #221): three columns whose borders fall on the panes' borders below, from the shown view's layout. Left, the
 * brand and panel-left; center, the activity's bar, empty without one; right, the right panes' icons while the right group holds Detalhes,
 * else panel-right. The view switch moved to the rail (#220), the agents' usage to the footer (#223). */
export function Header({ shell, state, effective }: HeaderProps) {
  const widths = headerColumns(shell.layout, shell.rightShown);
  const leftLabel = t(shell.layout.open.left ? 'header.collapseLeft' : 'header.expandLeft');
  return (
    <header className={`flex shrink-0 items-stretch border-b ${WINDOW_DRAG}`}>
      <div data-header-column="left" style={{ width: widths.left }} className={`flex shrink-0 items-center gap-2 overflow-hidden border-r pr-2 ${WINDOW_INSET}`}>
        <HeaderBrand state={state} effective={effective} />
        <SideButton Icon={PanelLeftIcon} label={leftLabel} keys={binding('toggleLeft')} className="ml-auto" onClick={() => runShortcut('toggleLeft')} />
      </div>
      <div data-header-column="center" className="flex min-w-0 flex-1 items-center">{shell.bar}</div>
      {shell.rightShown ? <RightColumn width={widths.right} panes={shell.panes} /> : (
        <div className="flex shrink-0 items-center pr-2">
          <SideButton Icon={PanelRightIcon} label={t('header.openRight')} keys={binding('toggleRight')} disabled={!shell.canOpenRight} onClick={() => runShortcut('toggleRight')} />
        </div>
      )}
    </header>
  );
}
