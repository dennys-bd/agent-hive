import { afterEach, expect, test } from 'vitest';
import { FLOW_VIEW_DEFAULTS, readFlowView, writeFlowView } from '@/lib/flow-view';
import { readView, resetViewState } from '@/lib/view-state';

// The flow view's own state (#909), as the view state holds it under flowView, read back through readFlowView
const readStored = (value: unknown) => {
  resetViewState({ flowView: value });
  return readFlowView();
};
const GOOD = { loops: false, zoom: 1.2, pan: { x: 30, y: 5 } };
afterEach(() => resetViewState()); // also drops writeFlowView's pending post

test('writeFlowView puts the whole value under flowView and readFlowView round-trips it (#909)', () => {
  resetViewState();
  const view = { loops: false, zoom: 1.25, pan: { x: -40, y: 12 } };
  writeFlowView(view);
  expect(readView('flowView')).toEqual(view);
  expect(readFlowView()).toEqual(view);
});

test('nothing stored, or a value that is no plain object, reads as the defaults: loops on, zoom 1, pan 0, 0 (#909)', () => {
  resetViewState();
  expect(readFlowView()).toEqual({ loops: true, zoom: 1, pan: { x: 0, y: 0 } });
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
