import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SidebarsPerView } from '../../types';
import {
  type ActiveTabs, type DockLayout, type PanelId, readDockLayout, type Side, type SideChange, SIDES, sideOf, syncSide, type ViewId,
  type ViewLayout, withSide, writeDockLayout,
} from '@/lib/dock-layout';

type PerSide = Record<Side, boolean>;
// view: the one source of truth for the center's view (#821), beside the layout it picks from; perView: the setting as last applied
interface DockState { layout: DockLayout; view: ViewId; perView: PerSide; active: ActiveTabs }

export interface Dock {
  layout: ViewLayout; // the current view's (#821): the shape DockFrame and shownBySide read
  view: ViewId; active: ActiveTabs;
  setView(view: ViewId): void;
  activate(id: PanelId): void; show(id: PanelId): void; resize(side: Side, size: number): void;
  toggle(side: Side): void; close(side: Side): void;
}

// A change to one side of the current view, or of both while the side is shared (#821). The same layout back: the same state, so no render.
function withChange(state: DockState, side: Side, change: SideChange): DockState {
  const layout = withSide(state.layout, state.view, side, change, state.perView[side]);
  return layout === state.layout ? state : { ...state, layout };
}

const withOpen = (state: DockState, side: Side, open: boolean): DockState => withChange(state, side, { open });

// A pick that follows the center (#612): `id` becomes its side's active tab and the side's open flag is left alone, so a closed side stays
// closed and shows `id` once reopened. Already active: the same state, so no render.
function withShown(state: DockState, id: PanelId): DockState {
  const side = state.layout.docks[id];
  return state.active[side] === id ? state : { ...state, active: { ...state.active, [side]: id } };
}

// Activation (#342, #452): a task selected, a panel moved, a dock tab clicked. The side holding `id` opens and `id` becomes its active tab.
// Already both: the same state, so no render.
const withActive = (state: DockState, id: PanelId): DockState => withShown(withOpen(state, state.layout.docks[id], true), id);

// A side's setting turned off (#821): the current view's state for it becomes both views', so they start out equal. Nothing changed: the same state.
function withPerView(state: DockState, perView: PerSide): DockState {
  if (SIDES.every((side) => state.perView[side] === perView[side])) return state;
  const layout = SIDES.filter((side) => state.perView[side] && !perView[side]).reduce((next, side) => syncSide(next, state.view, side), state.layout);
  return { ...state, layout, perView };
}

/** The dock's state (#342, #452, #821): the layout, each view keeping its own sides, written to the view state on every change (#484); the
 * current view, which the center follows; and each side's active tab, never written: it follows what the user last opened. Every update reads
 * the view and the setting from the state, so every callback keeps its identity. Every update returns a new state. */
export function useDock({ left, right }: SidebarsPerView): Dock {
  const [state, setState] = useState<DockState>(() => ({ layout: readDockLayout(), view: 'activities', perView: { left, right }, active: {} }));
  useEffect(() => writeDockLayout(state.layout), [state.layout]);
  useEffect(() => setState((s) => withPerView(s, { left, right })), [left, right]);
  const setView = useCallback((view: ViewId) => setState((s) => (s.view === view ? s : { ...s, view })), []);
  const activate = useCallback((id: PanelId) => setState((s) => withActive(s, id)), []);
  const show = useCallback((id: PanelId) => setState((s) => withShown(s, id)), []);
  const resize = useCallback((side: Side, size: number) => setState((s) => withChange(s, side, { size })), []);
  // The panel's X, or Escape on the shown Detalhes (#452): every tab and stream stays, only the side stops showing
  const close = useCallback((side: Side) => setState((s) => withOpen(s, side, false)), []);
  // A panel key (#452): a side with no tab flips its flag all the same, so a panel that starts docked there obeys it
  const toggle = useCallback((side: Side) => setState((s) => withOpen(s, side, !s.layout.open[s.view][side])), []);
  const layout = useMemo(() => sideOf(state.layout, state.view), [state.layout, state.view]);
  return { layout, view: state.view, active: state.active, setView, activate, show, resize, toggle, close };
}
