import { expect, test } from 'vitest';
import type { LayoutEdge } from '@/lib/flow-layout';
import { drawnEdgesOf, type RowEntry, stripsOf } from '@/lib/flow-strips';

// The drawn row of #914, with no DOM: triage and review hold tasks; repro, fix and release are empty
const STAGES = ['triage', 'repro', 'fix', 'review', 'release'];
const EMPTY = new Set(['repro', 'fix', 'release']);
const isEmpty = (stage: string): boolean => EMPTY.has(stage);
// a node as its name, a strip as its stages
const shape = (row: readonly RowEntry[]): (string | readonly string[])[] => row.map((r) => (r.isStrip ? r.stages : r.id));
const edge = (from: string, to: string, feedback = false): LayoutEdge => ({ id: `${from}>${to}`, from, to, automatic: true, feedback });

test('open keeps every stage a node, empty or not (#914)', () => {
  expect(stripsOf(STAGES, isEmpty, 'open').map((r) => [r.id, r.stages, r.isStrip])).toEqual(STAGES.map((s) => [s, [s], false]));
});

test('collapse makes each empty stage its own strip, neighbours included (#914)', () => {
  expect(shape(stripsOf(STAGES, isEmpty, 'collapse'))).toEqual(['triage', ['repro'], ['fix'], 'review', ['release']]);
});

test('merge joins a run of empty neighbours into one strip named by its first stage, and leaves a lone empty stage a strip of its own (#914)', () => {
  const row = stripsOf(STAGES, isEmpty, 'merge');
  expect(shape(row)).toEqual(['triage', ['repro', 'fix'], 'review', ['release']]);
  expect(row[1].id).toBe('repro');
  expect(shape(stripsOf(STAGES, () => true, 'merge'))).toEqual([STAGES]);
  expect(stripsOf([], isEmpty, 'merge')).toEqual([]);
});

test('edges are remapped onto the row\'s ids; END and an unknown stage keep their names; none of them is marked (#914)', () => {
  const row = stripsOf(STAGES, isEmpty, 'merge');
  const drawn = drawnEdgesOf(row, [edge('triage', 'repro'), edge('fix', 'review'), edge('review', 'fix'), edge('release', 'end'), edge('gone', 'triage')]);
  expect(drawn.map((e) => [e.id, e.from, e.to])).toEqual([
    ['triage>repro', 'triage', 'repro'], ['fix>review', 'repro', 'review'], ['review>fix', 'review', 'repro'], ['release>end', 'release', 'end'], ['gone>triage', 'gone', 'triage'],
  ]);
  expect(drawn.every((e) => e.inner === undefined && e.segments === undefined)).toBe(true);
});

test('an edge between two stages of one strip, neighbours or not, either way, feedback too, is inner with its segments; a loop on one stage is not (#914)', () => {
  const row = stripsOf(['a', 'b', 'c', 'd', 'e'], (s) => s !== 'a', 'merge'); // one strip of four: b, c, d, e
  const drawn = drawnEdgesOf(row, [edge('c', 'e'), edge('e', 'c', true), edge('b', 'c'), edge('c', 'c')]);
  expect(drawn.map(({ from, to, inner, segments }) => ({ from, to, inner, segments }))).toEqual([
    { from: 'b', to: 'b', inner: true, segments: { from: 1, to: 3, count: 4 } },
    { from: 'b', to: 'b', inner: true, segments: { from: 3, to: 1, count: 4 } },
    { from: 'b', to: 'b', inner: true, segments: { from: 0, to: 1, count: 4 } },
    { from: 'b', to: 'b', inner: undefined, segments: undefined },
  ]);
});
