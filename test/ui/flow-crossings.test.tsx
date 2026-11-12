import { expect, test } from 'vitest';
import { placeCrossings } from '@/lib/flow-crossings';

// #691: the arrows into and out of another flow, under their stage's node, as settings.hv.html draws them
const NODE = { id: 'a', x: 24, y: 24, width: 150, height: 64 }; // centre 99, bottom 88

test('one crossing runs straight down from its node\'s bottom centre to its pill, 100px under, its trigger pill 36px under; an incoming one runs up into the node (#691)', () => {
  const out = placeCrossings([NODE], [{ id: 'o', stage: 'a', kind: 'out' }]);
  expect(out.crossings).toEqual([{ id: 'o', stage: 'a', kind: 'out', path: 'M 99 88 L 99 178', label: { x: 99, y: 124 }, pill: { x: 99, y: 188 } }]);
  expect(out.bottom).toBe(198);
  expect(placeCrossings([NODE], [{ id: 'i', stage: 'a', kind: 'in' }]).crossings[0]?.path).toBe('M 99 178 L 99 88');
});

test('two crossings at one stage sit SPREAD apart, the second one lane lower; a stage the chart lacks is left out (#691)', () => {
  const { crossings, bottom } = placeCrossings([NODE], [{ id: 'o', stage: 'a', kind: 'out' }, { id: 'i', stage: 'a', kind: 'in' }, { id: 'z', stage: 'gone', kind: 'in' }]);
  expect(crossings.map((c) => [c.id, c.path, c.pill])).toEqual([['o', 'M 89 88 L 89 178', { x: 89, y: 188 }], ['i', 'M 109 278 L 109 88', { x: 109, y: 288 }]]);
  expect(bottom).toBe(298);
  expect(placeCrossings([NODE], []).bottom).toBe(0);
});
