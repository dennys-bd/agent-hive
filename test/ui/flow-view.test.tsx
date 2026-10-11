import { afterEach, expect, test } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFlowView } from '@/hooks/use-flow-view';
import { FLOW_VIEW_DEFAULTS, readFlowView, toggleOutline, writeFlowView } from '@/lib/flow-view';
import { readView, resetViewState } from '@/lib/view-state';

// The flow view's own state (#909), as the view state holds it under flowView, read back through readFlowView
const readStored = (value: unknown) => {
  resetViewState({ flowView: value });
  return readFlowView();
};
const GOOD = { loops: false, zoom: 1.2, pan: { x: 30, y: 5 }, collapsed: [], outline: [] };
afterEach(() => resetViewState()); // also drops writeFlowView's pending post

test('writeFlowView puts the whole value under flowView and readFlowView round-trips it (#909)', () => {
  resetViewState();
  const view = { loops: false, zoom: 1.25, pan: { x: -40, y: 12 }, tree: true, collapsed: ['dev\u0000I1'], outline: ['I1'] };
  writeFlowView(view);
  expect(readView('flowView')).toEqual(view);
  expect(readFlowView()).toEqual(view);
});

test('nothing stored, or a value that is no plain object, reads as the defaults: loops on, zoom 1, pan 0, 0 (#909)', () => {
  resetViewState();
  expect(readFlowView()).toEqual({ loops: true, zoom: 1, pan: { x: 0, y: 0 }, collapsed: [], outline: [] });
  for (const value of [null, 3, 'loops', [GOOD]]) expect(readStored(value)).toEqual(FLOW_VIEW_DEFAULTS);
});

test('each unreadable field falls back to its default alone, the others kept; zoom holds from 0.5 to 1.5 inclusive (#909)', () => {
  expect(readStored(GOOD)).toEqual(GOOD);
  expect(readStored({ ...GOOD, loops: 'x' })).toEqual({ ...GOOD, loops: true });
  expect(readStored({ ...GOOD, zoom: 3 })).toEqual({ ...GOOD, zoom: 1 });
  expect(readStored({ ...GOOD, zoom: 0.4 })).toEqual({ ...GOOD, zoom: 1 });
  expect(readStored({ ...GOOD, zoom: Number.NaN })).toEqual({ ...GOOD, zoom: 1 });
  expect(readStored({ ...GOOD, zoom: '1.2' })).toEqual({ ...GOOD, zoom: 1 });
  expect([readStored({ ...GOOD, zoom: 0.5 }).zoom, readStored({ ...GOOD, zoom: 1.5 }).zoom]).toEqual([0.5, 1.5]);
  expect(readStored({ ...GOOD, pan: { x: 'a', y: 5 } })).toEqual({ ...GOOD, pan: { x: 0, y: 5 } });
  expect(readStored({ ...GOOD, pan: { x: 30, y: Number.POSITIVE_INFINITY } })).toEqual({ ...GOOD, pan: { x: 30, y: 0 } });
  expect(readStored({ ...GOOD, pan: 'here' })).toEqual({ ...GOOD, pan: { x: 0, y: 0 } });
  expect(readStored({ zoom: 1.2 })).toEqual({ ...FLOW_VIEW_DEFAULTS, zoom: 1.2 });
});

test('a stored tree and collapsed are read back; a non-boolean tree reads as unset, a non-array collapsed as [], and non-string entries are dropped (#34)', () => {
  const key = 'dev\u0000I1';
  expect(readStored({ ...GOOD, tree: false, collapsed: [key] })).toEqual({ ...GOOD, tree: false, collapsed: [key] });
  expect(readStored({ ...GOOD, tree: 'yes' })).not.toHaveProperty('tree');
  expect(readStored({ ...GOOD, collapsed: 'dev' }).collapsed).toEqual([]);
  expect(readStored({ ...GOOD, collapsed: [key, 3, null, 'review\u0000none'] }).collapsed).toEqual([key, 'review\u0000none']);
});

test('two collapses before a re-render both stay: toggleGroup reads what was last written, not the render\'s view (#34)', () => {
  const { result } = renderHook(() => useFlowView(false));
  const controls = result.current; // one render's controls, as two clicks in the same tick hold
  act(() => {
    controls.toggleGroup('dev\u0000I1');
    controls.toggleGroup('review\u0000I1');
  });
  expect(result.current.view.collapsed).toEqual(['dev\u0000I1', 'review\u0000I1']);
  expect(readFlowView().collapsed).toEqual(['dev\u0000I1', 'review\u0000I1']);
});

test('a stored outline is read back, a non-array reads as [] and non-string entries are dropped; toggleOutline adds then removes an id and leaves the other fields as stored (#36)', () => {
  expect(readStored({ ...GOOD, outline: ['I1'] }).outline).toEqual(['I1']);
  expect(readStored({ ...GOOD, outline: 'I1' }).outline).toEqual([]);
  expect(readStored({ ...GOOD, outline: ['I1', 2, null] }).outline).toEqual(['I1']);
  const stored = { ...GOOD, tree: true, collapsed: ['dev\u0000I1'] };
  resetViewState({ flowView: stored });
  expect(toggleOutline('I2')).toEqual(['I2']);
  expect(readView('flowView')).toEqual({ ...stored, outline: ['I2'] });
  expect(toggleOutline('I3')).toEqual(['I2', 'I3']);
  expect(toggleOutline('I2')).toEqual(['I3']);
  expect(readFlowView()).toEqual({ ...stored, outline: ['I3'] });
});

test('the flow\'s own writes keep an outline the details wrote after the hook mounted: a toggle through save and a scroll through onPan (#36)', () => {
  resetViewState();
  const { result } = renderHook(() => useFlowView(false));
  toggleOutline('I1');
  act(() => result.current.toggleLoops());
  expect(readFlowView()).toEqual({ ...FLOW_VIEW_DEFAULTS, loops: false, outline: ['I1'] });
  toggleOutline('I2');
  act(() => result.current.onPan({ x: 5, y: 6 }));
  expect(readFlowView()).toEqual({ ...FLOW_VIEW_DEFAULTS, loops: false, pan: { x: 5, y: 6 }, outline: ['I1', 'I2'] });
});
