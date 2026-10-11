import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { OperationId } from '../../types';
import { onShortcutKey } from '@/lib/dock-layout';
import { type FlowView, readFlowView, writeFlowView } from '@/lib/flow-view';
import { stepZoom } from '@/lib/flow-zoom';
import { isInDialog, isRecording, isTextField } from '@/lib/shortcut-bindings';

type ZoomKey = 'out' | 'in' | 'reset' | 'fit';
// #910: −, + and the number. ajustar's ⇧1 is the fixed row zoomFit, matched below
const ZOOM_KEYS: ReadonlyArray<[ZoomKey, OperationId]> = [['out', 'zoomOut'], ['in', 'zoomIn'], ['reset', 'zoomReset']];

/** Whether a keydown is the flow's fit key, the handoff's ⇧1 (#910). Matched by hand, as use-task-keys matches the flow's letters: Shift+digit
 * is no binding (#585), so matches and pressedFixed never see it. The 1 by its position; a synthetic event without a code falls back to `key`. */
export function isFitKey(event: KeyboardEvent): boolean {
  if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.code === '' ? event.key === '!' : event.code === 'Digit1';
}

// ⇧1 on window's capture phase, as onShortcutKey binds the others. A bare Shift+digit types: ignored in a text field, behind a dialog and while
// a Settings key field records
function onFitKey(requestFit: () => void): () => void {
  const listener = (event: KeyboardEvent): void => {
    const { target } = event;
    if (!isFitKey(event) || isRecording(target) || isTextField(target) || isInDialog(target)) return;
    event.preventDefault();
    event.stopPropagation();
    requestFit();
  };
  window.addEventListener('keydown', listener, true);
  return () => window.removeEventListener('keydown', listener, true);
}

/** The flowchart's view and what changes it (#909, #910, #34): the loops toggle, the zoom, a fit request the canvas answers with onFit, the
 * scroll's pan, the tree toggle and the collapsed groups, with the three zoom keys and ⇧1 while `isShown` (#910). */
export interface FlowViewControls {
  view: FlowView; fitRequest: number;
  toggleLoops(): void; zoomTo(zoom: number): void; fit(): void;
  toggleTree(current: boolean): void; toggleGroup(key: string): void; // #34: `current` is the resolved value the header shows
  onPan(pan: FlowView['pan']): void; onFit(zoom: number): void;
}

/** `flowView` as Flow keeps it: every change writes the whole value, so the toggles, the zoom, the pan and the collapsed groups never overwrite one another. */
export function useFlowView(isShown: boolean): FlowViewControls {
  const [view, setView] = useState(readFlowView);
  const [fitRequest, setFitRequest] = useState(0);
  // The scroll's latest pan, out of state: a scroll writes flowView and never renders the flow again; `view.pan` is what the canvas restores
  const pan = useRef(view.pan);
  const latest = useRef(view); // what was last written: a scroll's handler may be a render older than a zoom or a toggle
  const save = (next: FlowView): void => {
    const saved = { ...next, pan: pan.current };
    latest.current = saved;
    writeFlowView(saved);
    setView(saved);
  };
  const zoomTo = (zoom: number): void => save({ ...view, zoom });
  const requestFit = (): void => setFitRequest((n) => n + 1);
  // Bound only while the flow shows (it stays mounted under Atividades, #596), as searchTasks; the listener reads the latest render's zoom
  const onKey = useEffectEvent((key: ZoomKey): void => {
    if (key === 'fit') requestFit();
    else zoomTo(key === 'reset' ? 1 : stepZoom(view.zoom, key === 'in' ? 1 : -1));
  });
  useEffect(() => {
    if (!isShown) return undefined;
    const offZoom = onShortcutKey(ZOOM_KEYS, (key) => onKey(key));
    const offFit = onFitKey(() => onKey('fit'));
    return () => {
      offZoom();
      offFit();
    };
  }, [isShown]);
  return {
    view, fitRequest, zoomTo, fit: requestFit,
    toggleLoops: () => save({ ...view, loops: !view.loops }),
    // #34: the first click stores the opposite of what the header showed, the "a tree exists" default included
    toggleTree: (current) => save({ ...view, tree: !current }),
    // From what was last written, not this render's view: two collapses before a re-render must both stay
    toggleGroup: (key) => {
      const { collapsed } = latest.current;
      save({ ...latest.current, collapsed: collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key] });
    },
    onPan: (next) => {
      pan.current = next;
      latest.current = { ...latest.current, pan: next };
      writeFlowView(latest.current);
    },
    onFit: (zoom) => {
      pan.current = { x: 0, y: 0 };
      save({ ...view, zoom });
    },
  };
}
