import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangesBase, DesignViewport } from '../../types';
import { TOGGLE_ITEM, TOGGLE_TRACK } from '@/components/DesignComments';
import { ViewportSwitch, ZoomControl } from '@/components/DesignBar';
import {
  DesignCanvas, designFrameRoute, FRAME_ASPECT, type FrameSize, frameWidthOf, type Mint, pageTheme, postTheme, switchOf, useFrameMessages, useFrameZoom, useMint,
  useReloads,
} from '@/components/design-frame';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useFrameParts } from '@/hooks/use-design-parts';
import { useDesignTweaks } from '@/hooks/use-design-tweaks';
import { type DesignZoom, useDesignZoom } from '@/hooks/use-design-zoom';
import { t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import * as fileBase from '@/lib/file-base';

// The changes pane's rendered view of a Hive design (#675): the base's screen beside the disk's, each in the design pane's canvas, sharing one
// viewport and one zoom, their scrolling kept on the same pixels. No comments, pins or tweaks: the design pane keeps them.

export type ChangesMode = 'rendered' | 'text';

const MODES: readonly ChangesMode[] = ['rendered', 'text'];

/** The before frame's mint route (#675). */
export const designFrameBaseRoute = (activityId: string, path: string, against: ChangesBase): string =>
  `/activities/${encodeURIComponent(activityId)}/design-frame-base?${new URLSearchParams({ path, against })}`;

/** Two canvases kept on the same pixels (#675): a scroll of either sets the other's scrollTop and scrollLeft. The scroll event that write fires
 *  is the echo, skipped once, so the first is never set back to where the second was. Same pixels is the same spot while the layouts match
 *  above it, the common case of a small edit. */
export function useSyncedScroll(left: RefObject<HTMLElement | null>, right: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const [a, b] = [left.current, right.current];
    if (a === null || b === null) return undefined;
    let echo: HTMLElement | undefined;
    const follow = (from: HTMLElement, to: HTMLElement) => (): void => {
      if (echo === from) {
        echo = undefined;
        return;
      }
      const [top, side] = [to.scrollTop, to.scrollLeft];
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
      // a write the other canvas clamped to where it already was fires no scroll: there is no echo to wait for
      echo = to.scrollTop !== top || to.scrollLeft !== side ? to : undefined;
    };
    const [onA, onB] = [follow(a, b), follow(b, a)];
    a.addEventListener('scroll', onA, { passive: true });
    b.addEventListener('scroll', onB, { passive: true });
    return () => {
      a.removeEventListener('scroll', onA);
      b.removeEventListener('scroll', onB);
    };
  }, [left, right]);
}

export interface CompareHalf {
  canvas: RefObject<HTMLDivElement | null>; box: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLIFrameElement | null>;
  mint: Mint; size: FrameSize; forgetWidth(): void;
}

export interface CompareView {
  root: RefObject<HTMLDivElement | null>; before: CompareHalf; after: CompareHalf; label: string; reloads: number;
  viewport: DesignViewport; viewports: DesignViewport[]; width: number; zoom: DesignZoom; pickViewport(next: DesignViewport): void;
}

interface CompareProps { activity: Activity; path: string; isDesign: boolean; isShown: boolean }

// One half: its refs, its mint, and its frame's size; the frame gets the Hive's theme on every load, as the design pane posts it
function useHalf(route: string | undefined, key: string): CompareHalf {
  const canvas = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const mint = useMint(route, key);
  const [size, forgetWidth] = useFrameMessages(frame, () => postTheme(frame.current, pageTheme()));
  return { canvas, box, frame, mint, size, forgetWidth };
}

/** Both halves (#675): the before frame minted for the pane's base and again when its blob changes, the after frame reloaded on a new version
 *  of the file or a part. One viewport, the screen's own list, and one zoom over the right half's canvas, so the fit is one half's width.
 *  Nothing is asked while the path is no design. */
export function useDesignCompare({ activity, path, isDesign, isShown }: CompareProps): CompareView {
  const activityId = activity.activity.id;
  const against = useSyncExternalStore(fileBase.subscribe, () => fileBase.chosenBase(activityId, path));
  const base = useSyncExternalStore(fileBase.subscribe, () => fileBase.baseOf(activityId, path));
  const root = useRef<HTMLDivElement>(null);
  const before = useHalf(isDesign ? designFrameBaseRoute(activityId, path, against) : undefined, base?.oid ?? '');
  const after = useHalf(isDesign ? designFrameRoute(activityId, path) : undefined, '');
  const reloads = useReloads(activityId, path, useFrameParts(after.frame), isDesign && isShown);
  const declared = useDesignTweaks(after.frame).viewports; // the screen's viewports only: the comparison sets no tweak
  const [viewport, setViewport] = useState<DesignViewport>('natural');
  const width = frameWidthOf(viewport, after.size);
  const zoom = useDesignZoom(after.canvas, after.box, width, isDesign && isShown);
  useFrameZoom(after.frame, zoom);
  useSyncedScroll(before.canvas, after.canvas);
  const pickViewport = (next: DesignViewport): void => {
    setViewport(next);
    before.forgetWidth();
    after.forgetWidth();
  };
  const label = base?.label ?? t(against === 'task' ? 'changes.base.task' : 'changes.base.head');
  return { root, before, after, label, reloads: reloads.count, viewport, viewports: switchOf(declared, viewport), width, zoom, pickViewport };
}

interface HalfProps { caption: string; half: CompareHalf; name: string; width: number; zoom: DesignZoom; reloads?: number }

// The canvas always renders, so its scroll stays synced and the layout stays side by side; an error or the base's absence shows inside it
function Half({ caption, half, name, width, zoom, reloads = 0 }: HalfProps) {
  const { mint } = half;
  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-background">
      <span title={caption} className="shrink-0 truncate border-b px-2.5 py-1 font-mono text-muted-foreground text-xs">{caption}</span>
      <DesignCanvas
        canvas={half.canvas} box={half.box} frame={half.frame} url={mint.status === 'ready' ? mint.url : undefined} name={`${caption} · ${name}`}
        width={width} height={half.size.height ?? width * FRAME_ASPECT} zoom={zoom} reloads={reloads} isCommenting={false}
      >
        {mint.status === 'missing' && <p className="absolute inset-0 grid place-items-center text-muted-foreground text-xs">{t('changes.notInBase')}</p>}
        {mint.status === 'error' && <p role="alert" className="absolute inset-0 p-3 text-destructive text-xs">{mint.message}</p>}
      </DesignCanvas>
    </div>
  );
}

/** The two halves (#675), base left, disk right. Its root takes ⌘0 and Space as the design pane's section does. */
export function DesignCompare({ view, name, hidden = false }: { view: CompareView; name: string; hidden?: boolean }) {
  const { zoom, width } = view;
  return (
    <section ref={view.root} aria-label={name} tabIndex={-1} hidden={hidden} onKeyDown={zoom.onKeyDown} onKeyUp={zoom.onKeyUp} onBlur={zoom.onBlur} className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-border outline-none">
      <Half caption={view.label} half={view.before} name={name} width={width} zoom={zoom} />
      <Half caption={t('changes.workingTree')} half={view.after} name={name} width={width} zoom={zoom} reloads={view.reloads} />
    </section>
  );
}

/** The bar's part of it (#675): Rendered / Text, then, while rendered, the design pane's viewport switch and zoom. */
export function CompareControls({ mode, onMode, view }: { mode: ChangesMode; onMode(next: ChangesMode): void; view: CompareView }) {
  const pick = (next: string): void => {
    const picked = MODES.find((item) => item === next);
    if (picked !== undefined) onMode(picked); // a click on the pressed item answers '', which matches none
  };
  return (
    <>
      <ToggleGroup type="single" size="xs" value={mode} onValueChange={pick} className={TOGGLE_TRACK}>
        {MODES.map((item) => <ToggleGroupItem key={item} value={item} className={TOGGLE_ITEM}>{t(`changes.view.${item}`)}</ToggleGroupItem>)}
      </ToggleGroup>
      {mode === 'rendered' && (
        <>
          <ViewportSwitch viewport={view.viewport} viewports={view.viewports} onViewport={view.pickViewport} />
          <ZoomControl zoom={view.zoom} />
        </>
      )}
    </>
  );
}
