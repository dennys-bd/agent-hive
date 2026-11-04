import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { OperationId } from '../../types';
import { onShortcutKey } from '@/lib/dock-layout';
import { type FlowCanvas, type ShownFlowView, readFlowView, shownOf, withShown, writeFlowView } from '@/lib/flow-view';
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
  view: ShownFlowView; fitRequest: number;
  toggleLoops(): void; zoomTo(zoom: number): void; fit(): void;
  toggleTree(current: boolean): void; toggleGroup(key: string): void; // #34: `current` is the resolved value the header shows
  onPan(pan: FlowCanvas['pan']): void; onFit(zoom: number): void;
}

const toggled = (keys: string[], key: string): string[] => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);

/** `flowView` as Flow keeps it for the flow named `flow` (#571): every change writes the whole value back with only that flow's canvas
 * changed, so the toggles, the zoom, the pan, the collapsed groups and the other flows' canvases never overwrite one another. */
export function useFlowView(isShown: boolean, flow: string): FlowViewControls {
  const [shown, setShown] = useState(() => ({ flow, view: shownOf(readFlowView(), flow) }));
  // #571: another flow's canvas is read when the name changes, while rendering (as useTreeFocus adjusts its scope), so no frame shows the old flow's zoom
  if (shown.flow !== flow) setShown({ flow, view: shownOf(readFlowView(), flow) });
  const view = shown.flow === flow ? shown.view : shownOf(readFlowView(), flow);
  const [fitRequest, setFitRequest] = useState(0);
  // What was last written, and for which flow: a scroll writes flowView and never renders the flow again, and a handler may be a render older than a zoom or a toggle
  const latest = useRef(shown);
  const last = (): ShownFlowView => (latest.current.flow === flow ? latest.current.view : view);
  // #36: `outline` is the details' field; the stored one wins over this hook's copy, or a zoom or a toggle would undo a collapse made there
  const write = (next: ShownFlowView): ShownFlowView => {
    const stored = readFlowView();
    const saved = { ...next, outline: stored.outline };
    writeFlowView(withShown(stored, flow, saved));
    latest.current = { flow, view: saved };
    return saved;
  };
  const save = (next: ShownFlowView, pan: FlowCanvas['pan'] = last().pan): void => setShown({ flow, view: write({ ...next, pan }) });
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
    toggleGroup: (key) => {
      const current = last(); // two collapses before a re-render must both stay
      save({ ...current, collapsed: toggled(current.collapsed, key) });
    },
    onPan: (next) => { write({ ...last(), pan: next }); },
    onFit: (zoom) => save({ ...view, zoom }, { x: 0, y: 0 }),
  };
}
