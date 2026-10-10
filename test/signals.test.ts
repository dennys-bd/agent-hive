import { test } from 'node:test';
import assert from 'node:assert/strict';
import { behaviourOf, clampedRed, effectOf, GREEN_BEHAVIOUR, isOrdered, mayContinue, mayResume, openingSignal } from '../src/signals.js';
import { SIGNALS_DEFAULTS, type SignalBehaviour, type SignalSettings } from '../src/types.js';

const STRICT: SignalBehaviour = { newTasks: false, started: 'stay', workerless: false };

test('behaviourOf: green turns every behaviour on whatever the settings; yellow and red read their own row (#727)', () => {
  const loose: SignalSettings = { ...SIGNALS_DEFAULTS, yellow: { newTasks: true, started: 'continueOnly', workerless: false } };
  assert.deepEqual(behaviourOf('green', loose), GREEN_BEHAVIOUR);
  assert.deepEqual(GREEN_BEHAVIOUR, { newTasks: true, started: 'resumeAndContinue', workerless: true });
  assert.deepEqual(behaviourOf('yellow', loose), loose.yellow);
  assert.deepEqual(behaviourOf('red', loose), loose.red);
});

test('the defaults reproduce today: yellow starts no new task and resumes and continues, red stays; both run workerless stages (#727)', () => {
  assert.deepEqual(SIGNALS_DEFAULTS, {
    yellow: { newTasks: false, started: 'resumeAndContinue', workerless: true },
    red: { newTasks: false, started: 'stay', workerless: true },
    onOpen: 'yellow',
  });
});

test('isOrdered accepts the defaults and a red equal to yellow, and refuses a red looser than yellow in each field (#727)', () => {
  assert.equal(isOrdered(SIGNALS_DEFAULTS), true);
  assert.equal(isOrdered({ yellow: STRICT, red: STRICT }), true);
  for (const red of [{ ...STRICT, newTasks: true }, { ...STRICT, started: 'continueOnly' as const }, { ...STRICT, workerless: true }]) {
    assert.equal(isOrdered({ yellow: STRICT, red }), false, JSON.stringify(red));
  }
  assert.equal(isOrdered({ yellow: { ...STRICT, started: 'continueOnly' }, red: { ...STRICT, started: 'resumeAndContinue' } }), false, 'resumeAndContinue is looser than continueOnly');
});

test('clampedRed brings red down to yellow wherever it allows more, and leaves a stricter field alone (#727)', () => {
  const red: SignalBehaviour = { newTasks: true, started: 'resumeAndContinue', workerless: true };
  assert.deepEqual(clampedRed(STRICT, red), STRICT);
  assert.deepEqual(clampedRed({ ...STRICT, started: 'continueOnly' }, { ...STRICT, started: 'stay' }), { ...STRICT, started: 'stay' });
  assert.equal(isOrdered({ yellow: STRICT, red: clampedRed(STRICT, red) }), true);
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

test('effectOf names what a row holds back, in the footer\'s order; a row that holds nothing back names nothing (#727)', () => {
  assert.deepEqual(effectOf(SIGNALS_DEFAULTS.yellow), ['noNewTasks']);
  assert.deepEqual(effectOf(SIGNALS_DEFAULTS.red), ['noNewTasks', 'noMoveOn']);
  assert.deepEqual(effectOf({ newTasks: true, started: 'continueOnly', workerless: false }), ['noResume', 'noWorkerless']);
  assert.deepEqual(effectOf(GREEN_BEHAVIOUR), []);
});
