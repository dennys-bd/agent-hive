import { afterEach, expect, test } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFlowView } from '@/hooks/use-flow-view';
import { CANVAS_DEFAULTS, FLOW_VIEW_DEFAULTS, canvasOf, readFlowView, toggleOutline, writeFlowView } from '@/lib/flow-view';
import { readView, resetViewState } from '@/lib/view-state';

const readStored = (value: unknown) => {
  resetViewState({ flowView: value });
  return readFlowView();
};
const GOOD = { zoom: 1.2, pan: { x: 30, y: 5 }, collapsed: ['dev\u0000I1'] };
const SHARED = { loops: false, outline: [] };
afterEach(() => resetViewState()); // also drops writeFlowView's pending post

test('writeFlowView puts the whole value under flowView and readFlowView round-trips the shared fields and a canvas per flow (#909, #571)', () => {
  resetViewState();
  const view = { loops: false, tree: true, outline: ['I1'], canvas: { build: GOOD, ship: { zoom: 0.8, pan: { x: 0, y: 0 }, collapsed: [] } } };
  writeFlowView(view);
  expect(readView('flowView')).toEqual(view);
  expect(readFlowView()).toEqual(view);
});

test('nothing stored or no plain object reads as the defaults; an old flat value keeps loops, tree and outline and starts every flow at the defaults (#909, #571)', () => {
  resetViewState();
  expect(readFlowView()).toEqual({ loops: true, outline: [], canvas: {} });
  for (const value of [null, 3, 'loops', [GOOD]]) expect(readStored(value)).toEqual(FLOW_VIEW_DEFAULTS);
  const flat = { loops: false, zoom: 1.2, pan: { x: 30, y: 5 }, tree: true, collapsed: ['dev\u0000I1'], outline: ['I1'] };
  expect(readStored(flat)).toEqual({ loops: false, tree: true, outline: ['I1'], canvas: {} });
  expect(canvasOf(readStored(flat), 'main')).toEqual(CANVAS_DEFAULTS);
  expect(canvasOf(readStored(flat), 'toString')).toEqual(CANVAS_DEFAULTS); // no prototype key reads as a canvas
});

test('each canvas entry is read on its own: a bad field falls back alone, a non-object entry reads as the defaults, the other flows kept (#909, #571)', () => {
  const read = (entry: unknown) => readStored({ ...SHARED, canvas: { build: GOOD, ship: entry } }).canvas;
  expect(read({ ...GOOD, zoom: 3 })).toEqual({ build: GOOD, ship: { ...GOOD, zoom: 1 } });
  expect([read({ ...GOOD, zoom: 0.4 }).ship.zoom, read({ ...GOOD, zoom: Number.NaN }).ship.zoom, read({ ...GOOD, zoom: '1.2' }).ship.zoom]).toEqual([1, 1, 1]);
  expect([read({ ...GOOD, zoom: 0.5 }).ship.zoom, read({ ...GOOD, zoom: 1.5 }).ship.zoom]).toEqual([0.5, 1.5]);
  expect(read({ ...GOOD, pan: { x: 'a', y: 5 } }).ship.pan).toEqual({ x: 0, y: 5 });
  expect(read({ ...GOOD, pan: 'here' }).ship.pan).toEqual({ x: 0, y: 0 });
  expect(read({ ...GOOD, collapsed: [3, null, 'review\u0000none'] }).ship.collapsed).toEqual(['review\u0000none']);
  expect(read('here')).toEqual({ build: GOOD, ship: CANVAS_DEFAULTS });
  expect(readStored({ ...SHARED, canvas: 'x' }).canvas).toEqual({});
});

test('a stored tree and outline are read back; a non-boolean tree reads as unset; toggleOutline flips an id and leaves every canvas as stored (#34, #36)', () => {
  expect(readStored({ ...SHARED, tree: 'yes' })).not.toHaveProperty('tree');
  expect(readStored({ ...SHARED, outline: ['I1', 2, null] }).outline).toEqual(['I1']);
  const stored = { ...SHARED, tree: true, canvas: { build: GOOD } };
  resetViewState({ flowView: stored });
  expect(toggleOutline('I2')).toEqual(['I2']);
  expect(toggleOutline('I3')).toEqual(['I2', 'I3']);
  expect(toggleOutline('I2')).toEqual(['I3']);
  expect(readFlowView()).toEqual({ ...stored, outline: ['I3'] });
});

test('two flows keep their own zoom, pan and collapsed groups across a switch; loops and tree are shared (#571)', () => {
  resetViewState();
  const { result, rerender } = renderHook(({ flow }) => useFlowView(false, flow), { initialProps: { flow: 'build' } });
  act(() => result.current.zoomTo(1.2));
  act(() => result.current.onPan({ x: 40, y: 0 }));
  act(() => result.current.toggleGroup('dev\u0000I1'));
  act(() => result.current.toggleLoops());
  rerender({ flow: 'ship' });
  expect(result.current.view).toEqual({ loops: false, outline: [], ...CANVAS_DEFAULTS });
  act(() => result.current.zoomTo(0.8));
  act(() => result.current.toggleTree(false));
  rerender({ flow: 'build' });
  expect(result.current.view).toEqual({ loops: false, tree: true, outline: [], zoom: 1.2, pan: { x: 40, y: 0 }, collapsed: ['dev\u0000I1'] });
  expect(readFlowView()).toEqual({
    loops: false, tree: true, outline: [],
    canvas: { build: { zoom: 1.2, pan: { x: 40, y: 0 }, collapsed: ['dev\u0000I1'] }, ship: { ...CANVAS_DEFAULTS, zoom: 0.8 } },
  });
});

test('two collapses before a re-render both stay: toggleGroup reads what was last written, not the render\'s view (#34)', () => {
  resetViewState();
  const { result } = renderHook(() => useFlowView(false, 'main'));
  const controls = result.current;
  act(() => {
    controls.toggleGroup('dev\u0000I1');
    controls.toggleGroup('review\u0000I1');
  });
  expect(result.current.view.collapsed).toEqual(['dev\u0000I1', 'review\u0000I1']);
  expect(readFlowView().canvas.main.collapsed).toEqual(['dev\u0000I1', 'review\u0000I1']);
});

test('the flow\'s own writes keep an outline the details wrote after the hook mounted: a toggle through save and a scroll through onPan (#36)', () => {
  resetViewState();
  const { result } = renderHook(() => useFlowView(false, 'main'));
  toggleOutline('I1');
  act(() => result.current.toggleLoops());
  expect(readFlowView()).toEqual({ loops: false, outline: ['I1'], canvas: { main: CANVAS_DEFAULTS } });
  toggleOutline('I2');
  act(() => result.current.onPan({ x: 5, y: 6 }));
  expect(readFlowView()).toEqual({ loops: false, outline: ['I1', 'I2'], canvas: { main: { ...CANVAS_DEFAULTS, pan: { x: 5, y: 6 } } } });
});
