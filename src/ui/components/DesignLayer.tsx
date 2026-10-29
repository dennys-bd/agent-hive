import { createContext, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { DesignPane } from '@/components/DesignPane';
import { t } from '@/i18n';
import { type Activity, activityKey, activityTitle } from '@/lib/activities';
import { type CenterLayout, groupsOf } from '@/lib/center-layout';

// The design layer (#533): every open design tab's pane lives here, outside ActivityCenter's tree, so a view or activity switch never
// unmounts its frame (an iframe reloads whenever it leaves the DOM). The tab renders an empty slot and the pane is laid over it by CSS anchor
// positioning while the slot is rendered; with no slot it stays loaded, hidden at its last size.

/** A rendered slot (#533): its CSS anchor, its group, and the group's focus that a pointer down in the pane asks for. */
export interface DesignSlotEntry { anchor: string; groupId: string; focus(): void }
interface Size { width: number; height: number }
interface Registry { slots: Readonly<Record<string, DesignSlotEntry>>; sizes: Readonly<Record<string, Size>> }

const EMPTY: Registry = { slots: {}, sizes: {} };
const RegistryContext = createContext<Registry>(EMPTY);
// Apart from the registry: a slot only writes, so a registration re-renders the layer and never the slots
const SetRegistryContext = createContext<Dispatch<SetStateAction<Registry>> | undefined>(undefined);

/** A design pane's key (#533): its activity's and its path's; a layout holds one design tab per path. */
export const designKey = (activity: Activity, path: string): string => `${activityKey(activity)}:${path}`;

const baseName = (path: string): string => path.split('/').at(-1) ?? path;
// useId's characters are not all valid in a CSS dashed ident; the path never enters it
const anchorOf = (id: string): string => `--design-${id.replace(/[^\w-]/g, '')}`;
const without = <T,>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([other]) => other !== key));

// The slot's size as it leaves, which the hidden pane keeps, so the design never gets a 0×0 viewport nor a resize on its way back. A slot
// already out of layout measures 0: no size then
function sizeOf(element: HTMLElement): Size | undefined {
  const { width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { width, height } : undefined;
}

// A slot leaving takes only its own entry: a tab moved to another group registers its new slot in the same commit
function parked(registry: Registry, key: string, anchor: string, size: Size | undefined): Registry {
  if (registry.slots[key]?.anchor !== anchor) return registry;
  return { slots: without(registry.slots, key), sizes: size === undefined ? registry.sizes : { ...registry.sizes, [key]: size } };
}

/** The registry of rendered design slots (#533), around the center's views and its design layer. */
export function DesignLayerProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Registry>(EMPTY);
  return (
    <SetRegistryContext.Provider value={setRegistry}>
      <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
    </SetRegistryContext.Provider>
  );
}

export interface DesignSlotProps { slotKey: string; groupId: string; onFocus(): void }

/** Where a shown design tab's pane goes (#533): an empty element its group's body sizes, registered while it is rendered. */
export function DesignSlot({ slotKey, groupId, onFocus }: DesignSlotProps) {
  const setRegistry = useContext(SetRegistryContext);
  const anchor = anchorOf(useId());
  const element = useRef<HTMLDivElement>(null);
  const focus = useRef(onFocus);
  useLayoutEffect(() => { focus.current = onFocus; });
  // A layout effect: the pane shows in the same frame as its slot, never one frame late
  useLayoutEffect(() => {
    const slot = element.current;
    if (setRegistry === undefined || slot === null) return undefined;
    setRegistry((registry) => ({ ...registry, slots: { ...registry.slots, [slotKey]: { anchor, groupId, focus: () => focus.current() } } }));
    return () => {
      const size = sizeOf(slot); // now: React runs a deleted subtree's layout cleanups before it removes its host node
      setRegistry((registry) => parked(registry, slotKey, anchor, size));
    };
  }, [setRegistry, slotKey, anchor, groupId]);
  return <div ref={element} data-design-slot={slotKey} style={{ anchorName: anchor }} className="min-h-0 min-w-0 flex-1" />;
}

interface OpenDesign { key: string; activity: Activity; path: string }

// Every design tab of every listed activity's stored layout: a pane lives as long as its tab, and goes with its activity (#533 decision 4).
// Sorted by key, never in the tabs' order: React moves a keyed node whose place changes, and a moved iframe reloads. In key order a pane
// that comes or goes never moves the others
function openDesigns(activities: readonly Activity[], layouts: Readonly<Record<string, CenterLayout>>): OpenDesign[] {
  return activities.flatMap((activity) => {
    const layout = layouts[activityKey(activity)];
    const tabs = layout === undefined ? [] : groupsOf(layout.root).flatMap((group) => group.tabs);
    return tabs.flatMap((tab) => (tab.kind === 'design' ? [{ key: designKey(activity, tab.path), activity, path: tab.path }] : []));
  }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // a total order (localeCompare may tie distinct keys); flatMap's own new array
}

const anchored = (anchor: string): CSSProperties =>
  ({ positionAnchor: anchor, top: 'anchor(top)', left: 'anchor(left)', width: 'anchor-size(width)', height: 'anchor-size(height)' });
// Hidden, not display: none (decision 6): at its last size, or the center column's until it was first shown
const parkedStyle = (size: Size | undefined): CSSProperties => ({ visibility: 'hidden', pointerEvents: 'none', top: 0, left: 0, ...(size ?? { right: 0, bottom: 0 }) });

export interface DesignLayerProps { activities: readonly Activity[]; layouts: Readonly<Record<string, CenterLayout>> }

/** One design pane per open design tab (#533), over the center's groups and under the console drawer (z-10 < the drawer's z-20). A pane whose
 * slot is rendered is laid over it and active; any other is hidden, inert and inactive, so its version poll and zoom keys stop. */
export function DesignLayer({ activities, layouts }: DesignLayerProps) {
  const { slots, sizes } = useContext(RegistryContext);
  return (
    <>
      {openDesigns(activities, layouts).map(({ key, activity, path }) => {
        const slot = slots[key];
        // #533 decision 8: closeKeyGroup (⌘W) reads [data-center-group] from the focus, and a pointer down focuses the group, as CenterGroup's
        // own capture handler does; the pane no longer sits inside its group's section. The drag ignores it: it measures under [data-center-root]
        return (
          <div
            key={key} data-design-layer={key} data-center-group={slot?.groupId} onPointerDownCapture={slot?.focus} inert={slot === undefined} style={slot === undefined ? parkedStyle(sizes[key]) : anchored(slot.anchor)} className="absolute z-10 flex"
          >
            <DesignPane activity={activity} path={path} label={t('design.tab', { label: activityTitle(activity), name: baseName(path) })} active={slot !== undefined} />
          </div>
        );
      })}
    </>
  );
}
