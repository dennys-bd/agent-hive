import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { emptyRule, type RuleDraft } from '../src/ui/lib/settings-rules.js';
import { ruleSteps, signalZones } from '../src/ui/lib/signal-rules.js';

setLanguage('pt');

const row = (percent: number, kind: 'maxWorkers' | 'signal', value: string, stage = ''): RuleDraft =>
  ({ ...emptyRule('session'), percent: String(percent), kind, value, stage });

// 40→4 workers, 50→3, 60→yellow, 75→2, 90→red: the x-dc sample data of 01-limites.tpl.html.
const MOCK: RuleDraft[] = [row(40, 'maxWorkers', '4'), row(50, 'maxWorkers', '3'), row(60, 'signal', 'yellow'), row(75, 'maxWorkers', '2'), row(90, 'signal', 'red')];

test('signalZones: the worst fired signal wins; an incomplete signal row is ignored; no rows is one green zone (#512)', () => {
  assert.deepEqual(signalZones([]), [{ signal: 'green', from: 0, to: 100 }]);
  assert.deepEqual(signalZones(MOCK), [{ signal: 'green', from: 0, to: 60 }, { signal: 'yellow', from: 60, to: 90 }, { signal: 'red', from: 90, to: 100 }]);
  assert.deepEqual(signalZones([row(50, 'signal', 'red'), row(70, 'signal', 'yellow')]), [{ signal: 'green', from: 0, to: 50 }, { signal: 'red', from: 50, to: 100 }]);
  assert.deepEqual(signalZones([row(60, 'signal', '' as never)]), [{ signal: 'green', from: 0, to: 100 }], 'no value: ignored');
  assert.deepEqual(signalZones([{ ...row(60, 'signal', 'yellow'), percent: '' }]), [{ signal: 'green', from: 0, to: 100 }], 'no percent: ignored');
});

test('ruleSteps: one step per percent of a complete row, ascending, labels in draft order (#512)', () => {
  const steps = ruleSteps(MOCK);
  assert.deepEqual(steps.map((s) => s.percent), [40, 50, 60, 75, 90]);
  assert.deepEqual(steps.map((s) => s.labels), [['4 workers'], ['3 workers'], [t('settings.rules.signal', { signal: 'yellow' })], ['2 workers'], [t('settings.rules.signal', { signal: 'red' })]]);
  const mixed = [row(60, 'signal', 'yellow'), row(60, 'maxWorkers', '2', 'build'), row(10, 'maxWorkers', '1')];
  assert.deepEqual(ruleSteps(mixed), [
    { percent: 10, labels: ['1 worker'] },
    { percent: 60, labels: [t('settings.rules.signal', { signal: 'yellow' }), t('settings.rules.stage', { stage: 'build', workers: '2 workers' })] },
  ]);
  assert.deepEqual(ruleSteps([{ ...row(20, 'maxWorkers', '1'), kind: '' }]), [], 'a row with no kind is ignored');
});
