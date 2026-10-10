import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import {
  consequenceLabel, consequences, emptyRule, isRuleValid, MEASURES, measuresInUse, type RuleDraft, ruleDrafts, rulesFrom, rulesProblem,
} from '../src/ui/lib/settings-rules.js';
import type { UsageRule } from '../src/types.js';

setLanguage('pt');

const withoutId = (r: RuleDraft): Omit<RuleDraft, 'id'> => {
  const { id: _id, ...rest } = r;
  return rest;
};
const row = (patch: Partial<RuleDraft>): RuleDraft => ({ ...emptyRule('session'), ...patch });

test('ruleDrafts splits a rule into one row per consequence, cap first; rulesFrom folds rows of the same source/percent/stage and different kinds back (#512)', () => {
  const rule: UsageRule = { source: 'session', percent: 90, maxWorkers: 1, signal: 'red' };
  assert.deepEqual(ruleDrafts(rule).map(withoutId), [
    { source: 'session', percent: '90', stage: '', kind: 'maxWorkers', value: '1' },
    { source: 'session', percent: '90', stage: '', kind: 'signal', value: 'red' },
  ]);
  assert.deepEqual(rulesFrom(ruleDrafts(rule)), [rule]);

  const folded = rulesFrom([row({ percent: '60', kind: 'signal', value: 'yellow' }), row({ percent: '60', kind: 'maxWorkers', value: '2' })]);
  assert.deepEqual(folded, [{ source: 'session', percent: 60, signal: 'yellow', maxWorkers: 2 }]);

  const twoCaps = rulesFrom([row({ percent: '60', kind: 'maxWorkers', value: '2' }), row({ percent: '60', kind: 'maxWorkers', value: '3' })]);
  assert.deepEqual(twoCaps, [{ source: 'session', percent: 60, maxWorkers: 2 }, { source: 'session', percent: 60, maxWorkers: 3 }], 'same kind: two rules, not folded');

  const stageAndSignal = rulesFrom([row({ percent: '75', stage: 'build', kind: 'maxWorkers', value: '2' }), row({ percent: '75', kind: 'signal', value: 'red' })]);
  assert.deepEqual(stageAndSignal, [{ source: 'session', percent: 75, maxWorkers: 2, stage: 'build' }, { source: 'session', percent: 75, signal: 'red' }]);
  assert.equal('stage' in stageAndSignal[1], false, 'a global row sends no stage key');
});

test('isRuleValid and rulesProblem: a row must have a percent 0-100, a kind and a valid value; rulesProblem numbers a row by its position in the whole list (#526)', () => {
  for (const bad of [
    row({ percent: '', kind: 'maxWorkers', value: '1' }),
    row({ percent: '101', kind: 'maxWorkers', value: '1' }),
    row({ percent: '1.5', kind: 'maxWorkers', value: '1' }),
    row({ percent: '50', kind: '', value: '' }),
    row({ percent: '50', kind: 'maxWorkers', value: '-1' }),
    row({ percent: '50', kind: 'maxWorkers', value: '' }),
    row({ percent: '50', kind: 'signal', value: '' }),
    row({ percent: '50', kind: 'signal', value: 'green' }),
  ]) assert.equal(isRuleValid(bad), false, JSON.stringify(bad));
  assert.equal(isRuleValid(row({ percent: '0', kind: 'maxWorkers', value: '0' })), true);
  assert.equal(isRuleValid(row({ percent: ' 60 ', kind: 'signal', value: 'red' })), true);

  const hour80 = row({ source: 'hour', percent: '80', kind: 'maxWorkers', value: '2' });
  const session50bad = row({ source: 'session', percent: '50', kind: '', value: '' });
  assert.deepEqual(rulesProblem([hour80, session50bad], []), { section: 'rules', message: t('settings.rules.error', { n: 2, source: t('settings.rules.measure.session') }) });

  const week70dev = row({ source: 'week', percent: '70', stage: 'dev', kind: 'maxWorkers', value: '1' });
  const week70deploy = row({ source: 'week', percent: '70', stage: 'deploy', kind: 'maxWorkers', value: '1' });
  assert.deepEqual(rulesProblem([week70dev, week70deploy], ['dev']), { section: 'rules', message: t('settings.rules.stageUnknown', { n: 2, source: t('settings.rules.measure.week'), stage: 'deploy' }) });
});

test('MEASURES lists the four measures in ruler order; measuresInUse keeps those at least one row uses, empty rows included (#526)', () => {
  assert.deepEqual(MEASURES, ['session', 'week', 'hour', 'day']);
  assert.deepEqual(measuresInUse([]), []);
  assert.deepEqual(measuresInUse([row({ source: 'day' }), row({ source: 'session' }), row({ source: 'session' })]), ['session', 'day']);
  assert.deepEqual(measuresInUse([emptyRule('week')]), ['week']);
});

test('consequences lists the total cap, one per stage, then the signal; a row\'s own stage no longer in the form stays listed; consequenceLabel and emptyRule (#512)', () => {
  assert.deepEqual(consequences(['spec', 'build'], emptyRule('session')).map(consequenceLabel), [
    t('settings.rules.effect.maxWorkers'), t('settings.rules.effect.stageWorkers', { stage: 'spec' }), t('settings.rules.effect.stageWorkers', { stage: 'build' }), t('settings.rules.effect.signal'),
  ]);
  const withOldStage = row({ stage: 'old', kind: 'maxWorkers', value: '1' });
  const labels = consequences(['spec'], withOldStage).map(consequenceLabel);
  assert.deepEqual(labels, [t('settings.rules.effect.maxWorkers'), t('settings.rules.effect.stageWorkers', { stage: 'spec' }), t('settings.rules.effect.stageWorkers', { stage: 'old' }), t('settings.rules.effect.signal')]);
  assert.deepEqual(withoutId(emptyRule('week')), { source: 'week', percent: '', stage: '', kind: '', value: '' });
  assert.notEqual(emptyRule('week').id, emptyRule('week').id, 'ids are unique per call');
});
