import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CenterTabRef, parseMovedTab, parseTabRef } from '../src/tab-carry.js';
import type { Panes } from '../src/ui/lib/pane-split.js';

// A tab crossing between windows (#551): main checks every payload with parseMovedTab, so what it refuses never reaches a page

const ACTIVITY = 'a-I1';
const CARRY = { text: '﻿mine\n', base: 'v1', viewState: { cursorState: [], viewState: { scrollTop: 40 } } };
const PANES: Panes = {
  root: { kind: 'split', axis: 'row', children: [{ kind: 'pane', ptyId: 'p1' }, { kind: 'pane', ptyId: 'p2' }], sizes: [50, 50] },
  focused: 'p2',
};
const REFS: readonly CenterTabRef[] = [
  { kind: 'run', ptyId: 'p1' },
  { kind: 'run', ptyId: 'p1', panes: PANES, sessionId: 's1' },
  { kind: 'diff', scope: 'checkpoint', checkpoint: 2 },
  { kind: 'console', channel: 'stage:build', locked: true, run: 'r1' },
  { kind: 'file', path: 'src/a.ts' },
  { kind: 'preview', path: 'README.md' },
  { kind: 'design', path: 'docs/a.hv.html' },
  { kind: 'changes', path: 'src/a.ts' },
  { kind: 'untitled', n: 3 },
];
const CARRIED: readonly CenterTabRef[] = REFS.filter((ref) => ref.kind === 'file' || ref.kind === 'changes' || ref.kind === 'untitled');
const UNCARRIED = REFS.filter((ref) => !CARRIED.includes(ref));

test('parseMovedTab reads back every kind of tab with no carry (#551)', () => {
  for (const ref of REFS) assert.deepEqual(parseMovedTab({ activity: ACTIVITY, ref }), { activity: ACTIVITY, ref });
});

test('parseMovedTab keeps a carry on a file, changes or untitled tab, its view state as it came, and drops unknown keys (#551)', () => {
  for (const ref of CARRIED) {
    assert.deepEqual(parseMovedTab({ activity: ACTIVITY, ref, carry: { ...CARRY, extra: 1 }, extra: 2 }), { activity: ACTIVITY, ref, carry: CARRY });
    assert.deepEqual(parseMovedTab({ activity: ACTIVITY, ref, carry: { text: '', base: '' } }), { activity: ACTIVITY, ref, carry: { text: '', base: '' } });
  }
});

test('parseMovedTab refuses a missing or empty activity, an unknown ref, a carry on a tab that holds none, a malformed carry and a bare string (#551)', () => {
  const file = { kind: 'file', path: 'src/a.ts' };
  const refused: unknown[] = [
    { ref: file }, { activity: '', ref: file }, { activity: 7, ref: file }, { activity: ACTIVITY },
    { activity: ACTIVITY, ref: { kind: 'pr', number: 1 } },
    { activity: ACTIVITY, ref: { kind: 'untitled', n: 0 } }, { activity: ACTIVITY, ref: { kind: 'untitled', n: 1.5 } },
    ...UNCARRIED.map((ref) => ({ activity: ACTIVITY, ref, carry: CARRY })),
    { activity: ACTIVITY, ref: file, carry: { ...CARRY, text: 1 } },
    { activity: ACTIVITY, ref: file, carry: { ...CARRY, base: null } },
    { activity: ACTIVITY, ref: file, carry: { ...CARRY, viewState: 'scrolled' } },
    { activity: ACTIVITY, ref: file, carry: { ...CARRY, viewState: [] } },
    { activity: ACTIVITY, ref: file, carry: { ...CARRY, viewState: null } },
    { activity: ACTIVITY, ref: file, carry: 'mine' },
    'a-I1', null,
  ];
  for (const value of refused) assert.equal(parseMovedTab(value), undefined, JSON.stringify(value));
});

test('parseTabRef reads a stored ref as center-layout did and refuses an untitled one without the option (#551)', () => {
  assert.equal(parseTabRef({ kind: 'untitled', n: 1 }), undefined);
  assert.deepEqual(parseTabRef({ kind: 'untitled', n: 1 }, { untitled: true }), { kind: 'untitled', n: 1 });
  assert.deepEqual(parseTabRef({ kind: 'file', path: 'src/a.ts', extra: 1 }), { kind: 'file', path: 'src/a.ts' });
  assert.equal(parseTabRef({ kind: 'file', path: '../a.ts' }), undefined);
  assert.deepEqual(parseTabRef({ kind: 'console', channel: '' }), { kind: 'console' });
});
