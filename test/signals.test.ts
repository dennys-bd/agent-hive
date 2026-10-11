import { test } from 'node:test';
import assert from 'node:assert/strict';
import { behaviourOf, clamped, effectOf, isOrdered, mayContinue, mayResume, openingSignal } from '../src/signals.js';
import { SIGNALS_DEFAULTS, type NewTasks, type SignalBehaviour, type SignalSettings } from '../src/types.js';

const STRICT: SignalBehaviour = { newTasks: 'never', started: 'stay', workerless: false };
const LOOSE: SignalBehaviour = { newTasks: 'always', started: 'resumeAndContinue', workerless: true };
// The defaults with the three newTasks set
const ranked = (green: NewTasks, yellow: NewTasks, red: NewTasks): SignalSettings => ({
  ...SIGNALS_DEFAULTS, green: { newTasks: green }, yellow: { ...SIGNALS_DEFAULTS.yellow, newTasks: yellow }, red: { ...SIGNALS_DEFAULTS.red, newTasks: red },
});

test('behaviourOf: green reads its newTasks from the settings with started and workerless fixed on; yellow and red read their own row (#727, #32)', () => {
  const loose: SignalSettings = { ...SIGNALS_DEFAULTS, green: { newTasks: 'tree' }, yellow: { newTasks: 'tree', started: 'continueOnly', workerless: false } };
  assert.deepEqual(behaviourOf('green', loose), { newTasks: 'tree', started: 'resumeAndContinue', workerless: true });
  assert.deepEqual(behaviourOf('green', SIGNALS_DEFAULTS), LOOSE);
  assert.deepEqual(behaviourOf('yellow', loose), loose.yellow);
  assert.deepEqual(behaviourOf('red', loose), loose.red);
});

test('the defaults: green any new task, yellow only one of a started tree and resumes and continues, red none and stays; all run workerless stages (#727, #32)', () => {
  assert.deepEqual(SIGNALS_DEFAULTS, {
    green: { newTasks: 'always' },
    yellow: { newTasks: 'tree', started: 'resumeAndContinue', workerless: true },
    red: { newTasks: 'never', started: 'stay', workerless: true },
    onOpen: 'yellow',
  });
});

test('isOrdered: green ≥ yellow ≥ red field by field, newTasks by rank never < tree < always (#727, #32)', () => {
  assert.equal(isOrdered(SIGNALS_DEFAULTS), true);
  assert.equal(isOrdered({ ...SIGNALS_DEFAULTS, yellow: STRICT, red: STRICT }), true);
  for (const red of [{ ...STRICT, newTasks: 'tree' as const }, { ...STRICT, started: 'continueOnly' as const }, { ...STRICT, workerless: true }]) {
    assert.equal(isOrdered({ ...SIGNALS_DEFAULTS, yellow: STRICT, red }), false, JSON.stringify(red));
  }
  assert.equal(isOrdered({ ...SIGNALS_DEFAULTS, yellow: { ...STRICT, started: 'continueOnly' }, red: { ...STRICT, started: 'resumeAndContinue' } }), false, 'resumeAndContinue is looser than continueOnly');
  assert.equal(isOrdered(ranked('always', 'always', 'tree')), true, 'tree red under always yellow');
  assert.equal(isOrdered(ranked('always', 'tree', 'always')), false, 'always red over tree yellow');
  assert.equal(isOrdered(ranked('tree', 'always', 'never')), false, 'yellow over green');
  assert.equal(isOrdered(ranked('never', 'never', 'never')), true, 'green may be as strict as red');
});

test('clamped brings the stricter row down to the looser wherever it allows more, and leaves a stricter field alone (#727, #32)', () => {
  assert.deepEqual(clamped(STRICT, LOOSE), STRICT);
  assert.deepEqual(clamped({ ...STRICT, started: 'continueOnly' }, { ...STRICT, started: 'stay' }), { ...STRICT, started: 'stay' });
  assert.equal(clamped({ ...LOOSE, newTasks: 'tree' }, LOOSE).newTasks, 'tree');
  assert.equal(clamped(LOOSE, { ...LOOSE, newTasks: 'tree' }).newTasks, 'tree', 'a stricter value stays');
});

test('a green edit clamps yellow, and yellow then clamps red, the same way (#32)', () => {
  const open = ranked('always', 'always', 'always');
  const green = behaviourOf('green', { ...open, green: { newTasks: 'tree' } });
  const yellow = clamped(green, open.yellow);
  const red = clamped(yellow, open.red);
  assert.deepEqual([yellow.newTasks, red.newTasks], ['tree', 'tree']);
  assert.equal(isOrdered({ ...open, green: { newTasks: 'tree' }, yellow, red }), true);
});

test('resume only under resumeAndContinue; continue under anything but stay (#727)', () => {
  assert.deepEqual(['resumeAndContinue', 'continueOnly', 'stay'].map((started) => mayResume({ ...STRICT, started } as SignalBehaviour)), [true, false, false]);
  assert.deepEqual(['resumeAndContinue', 'continueOnly', 'stay'].map((started) => mayContinue({ ...STRICT, started } as SignalBehaviour)), [true, true, false]);
});

test('openingSignal: a saved red always opens red; last keeps the saved one; yellow and green are what they say (#727)', () => {
  assert.deepEqual((['green', 'yellow', 'red'] as const).map((saved) => openingSignal(saved, 'yellow')), ['yellow', 'yellow', 'red']);
  assert.deepEqual((['green', 'yellow', 'red'] as const).map((saved) => openingSignal(saved, 'green')), ['green', 'green', 'red']);
  assert.deepEqual((['green', 'yellow', 'red'] as const).map((saved) => openingSignal(saved, 'last')), ['green', 'yellow', 'red']);
});

test('effectOf names what a row holds back, in the footer\'s order: tree as newTasksFromTree, never as noNewTasks; always names nothing (#727, #32)', () => {
  assert.deepEqual(effectOf(SIGNALS_DEFAULTS.yellow), ['newTasksFromTree']);
  assert.deepEqual(effectOf(SIGNALS_DEFAULTS.red), ['noNewTasks', 'noMoveOn']);
  assert.deepEqual(effectOf({ newTasks: 'always', started: 'continueOnly', workerless: false }), ['noResume', 'noWorkerless']);
  assert.deepEqual(effectOf(behaviourOf('green', SIGNALS_DEFAULTS)), []);
});
