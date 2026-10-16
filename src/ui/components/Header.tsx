import { BracesIcon, FolderTreeIcon, ListIcon, type LucideIcon, PanelLeftIcon, PanelRightIcon } from 'lucide-react';
import type { EffectiveLimits, State } from '../../types.js';
import { HeaderBrand } from '@/components/HeaderBrand';
import { useHeaderSlotRef } from '@/components/HeaderSlot';
import { Button } from '@/components/ui/button';
import { keyTitle } from '@/components/ViewRail';
import { useIsFullScreen } from '@/hooks/use-full-screen';
import type { CenterMode } from '@/hooks/use-activity';
import { type HeaderShell, paneHint, type RightPane } from '@/hooks/use-header-shell';
import { t } from '@/i18n';
import { runShortcut } from '@/lib/dock-layout';
import { headerColumns } from '@/lib/header-columns';
import { binding } from '@/lib/shortcut-bindings';
import { WINDOW_DRAG, WINDOW_INSET } from '@/lib/window-chrome';

interface BrandProps { state: State; effective: EffectiveLimits }
interface HeaderProps extends BrandProps { shell: HeaderShell }

// The header drags the window: each of its own controls opts out to keep its clicks; the empty space and the bar's text keep dragging
const NO_DRAG = '[-webkit-app-region:no-drag]';
const ICON_BUTTON = `size-7 ${NO_DRAG}`; // the handoff's ghost 28×28 around a 16px icon
// Always all three, in order: a pane the view cannot show is disabled, never removed, so the row does not jump. variáveis is #313's, last so
// the other views' row keeps its place
const PANES: ReadonlyArray<[RightPane, LucideIcon]> = [['files', FolderTreeIcon], ['details', ListIcon], ['variables', BracesIcon]];

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

// panel-left, the toggleLeft key's own operation: the left column's end while the side is open, the center's start while it is closed
function LeftToggle({ isOpen, className }: { isOpen: boolean; className?: string }) {
  const label = t(isOpen ? 'header.collapseLeft' : 'header.expandLeft');
  return <SideButton Icon={PanelLeftIcon} label={label} keys={binding('toggleLeft')} className={className} onClick={() => runShortcut('toggleLeft')} />;
}

// The left side closed in a window (header-estados.md): panel-left, a divider the header's full height, then the ⬢ alone. The center has no
// left border then: the divider is the only line. In full screen panel-left sits in the left column, over the rail, and the ⬢ leads alone
function ClosedLead({ state, effective, isFullScreen }: BrandProps & { isFullScreen: boolean }) {
  return (
    <>
      {!isFullScreen && <LeftToggle isOpen={false} />}
      {!isFullScreen && <span aria-hidden="true" className="mx-1.5 w-px self-stretch bg-border" />}
      <HeaderBrand state={state} effective={effective} isCompact />
    </>
  );
}

// The left column (#221, #295): open, the brand and panel-left behind the window inset (84px, 12px in full screen). Closed in a window, the
// block holding only the window buttons' space; closed in full screen, the rail's width with panel-left over the rail's icons and the rail's
// border as the divider
function LeftColumn({ width, isOpen, isFullScreen, state, effective }: BrandProps & { width: string; isOpen: boolean; isFullScreen: boolean }) {
  if (!isOpen && !isFullScreen) return <div data-header-column="left" style={{ width }} className="shrink-0" />;
  if (!isOpen) return <div data-header-column="left" style={{ width }} className="flex shrink-0 items-center justify-center border-r"><LeftToggle isOpen={false} /></div>;
  return (
    <div data-header-column="left" style={{ width }} className={`flex shrink-0 items-center gap-2 overflow-hidden border-r pr-2 ${WINDOW_INSET}`}>
      <HeaderBrand state={state} effective={effective} />
      <LeftToggle isOpen className="ml-auto" />
    </div>
  );
}

// The right column: one icon per pane, the shown one on --accent, then the shown pane's name at the column's end. A pane the view never has
// says so in its title (#313)
function RightColumn({ width, center, panes }: { width?: string; center: CenterMode; panes: HeaderShell['panes'] }) {
  return (
    <div data-header-column="right" style={{ width }} className="flex shrink-0 items-center gap-1 overflow-hidden border-l px-2">
      {PANES.map(([pane, Icon]) => {
        const isActive = panes.active === pane;
        const label = t(`files.tab.${pane}`);
        const hint = paneHint(center, pane);
        return (
          <Button
            key={pane} type="button" variant="ghost" size="icon" aria-label={label} title={hint === undefined ? label : t(hint, { pane: label })} aria-pressed={isActive}
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

/** The window's top bar (#533, #221, #295): three columns whose borders fall on the panes' borders below, from the shown view's layout. Left,
 * per header-estados.md's four states: the brand and panel-left with the left side open; closed, the window buttons' block then panel-left, a divider and the ⬢
 * at the center's start; closed in full screen, panel-left over the rail, then the ⬢. Center, the activity's bar, empty without one; right, the right panes'
 * icons while the right group holds Detalhes, else panel-right. The view switch moved to the rail (#220), the agents' usage to the footer (#223). */
export function Header({ shell, state, effective }: HeaderProps) {
  const isFullScreen = useIsFullScreen();
  const widths = headerColumns(shell.layout, shell.rightShown, isFullScreen);
  const isLeftOpen = shell.layout.open.left;
  const registerSlot = useHeaderSlotRef();
  return (
    <header className={`flex shrink-0 items-stretch border-b ${WINDOW_DRAG}`}>
      <LeftColumn width={widths.left} isOpen={isLeftOpen} isFullScreen={isFullScreen} state={state} effective={effective} />
      <div data-header-column="center" className={`flex min-w-0 flex-1 items-center ${!isLeftOpen && isFullScreen ? 'pl-3' : ''}`}>
        {!isLeftOpen && <ClosedLead state={state} effective={effective} isFullScreen={isFullScreen} />}
        {/* #295: no activity bar, the slot the flow's bar portals into; an element of its own, so React keeps the closed lead before it */}
        {shell.bar ?? <div ref={registerSlot} data-header-slot className="flex h-full min-w-0 flex-1 items-center" />}
      </div>
      {shell.rightShown ? <RightColumn width={widths.right} center={shell.center} panes={shell.panes} /> : (
        <div className="flex shrink-0 items-center pr-2">
          <SideButton Icon={PanelRightIcon} label={t('header.openRight')} keys={binding('toggleRight')} disabled={!shell.canOpenRight} onClick={() => runShortcut('toggleRight')} />
        </div>
      )}
    </header>
  );
}
