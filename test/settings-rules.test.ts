import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import {
  agentOptions, consequenceLabel, consequences, emptyRule, isRuleValid, MEASURES, measuresInUse, type RuleDraft, ruleDrafts, rulerRows, rulersInUse, rulesFrom, rulesProblem,
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

test('MEASURES lists the five measures in ruler order; measuresInUse keeps those at least one row uses, empty rows included (#526)', () => {
  assert.deepEqual(MEASURES, ['session', 'week', 'month', 'hour', 'day']);
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

test('a plan row keeps its agent; rulesFrom writes it only when it is not the default, never on a budget row, and folds only rows of one agent (#929)', () => {
  const rule: UsageRule = { source: 'month', percent: 40, signal: 'yellow', agent: 'codex' };
  assert.deepEqual(ruleDrafts(rule).map(withoutId), [{ source: 'month', percent: '40', stage: '', kind: 'signal', value: 'yellow', agent: 'codex' }]);
  assert.deepEqual(rulesFrom(ruleDrafts(rule), 'claude'), [rule]);
  assert.deepEqual(rulesFrom(ruleDrafts(rule), 'codex'), [{ source: 'month', percent: 40, signal: 'yellow' }], 'the default agent: no key');
  assert.deepEqual(rulesFrom([row({ source: 'hour', percent: '50', kind: 'maxWorkers', value: '1', agent: 'codex' })], 'claude'), [{ source: 'hour', percent: 50, maxWorkers: 1 }], 'a budget row has no agent');
  const two = rulesFrom([row({ percent: '60', kind: 'signal', value: 'red', agent: 'codex' }), row({ percent: '60', kind: 'maxWorkers', value: '2' })], 'claude');
  assert.deepEqual(two, [{ source: 'session', percent: 60, signal: 'red', agent: 'codex' }, { source: 'session', percent: 60, maxWorkers: 2 }], 'two agents: two rules, not folded');
});

test('agentOptions puts the default agent first; rulersInUse gives a plan measure one ruler per agent its rows read, naming only a non-default one (#929)', () => {
  assert.deepEqual([agentOptions('claude'), agentOptions('codex')], [['claude', 'codex'], ['codex', 'claude']]);
  const rows = [row({ source: 'week' }), row({ source: 'week', agent: 'codex' }), row({ source: 'week', agent: 'claude' }), row({ source: 'day', agent: 'codex' })];
  assert.deepEqual(rulersInUse(rows, 'claude'), [{ source: 'week' }, { source: 'week', agent: 'codex' }, { source: 'day' }]);
  assert.deepEqual(rulerRows(rows, { source: 'week' }, 'claude'), [rows[0], rows[2]]);
  assert.deepEqual(rulerRows(rows, { source: 'week', agent: 'codex' }, 'claude'), [rows[1]]);
  assert.deepEqual(rulerRows(rows, { source: 'day' }, 'claude'), [rows[3]], 'a budget ruler takes every row of its measure');
});

test('the ruler helpers take saved rules too: measuresInUse, rulersInUse and rulerRows group UsageRule[] as they group rows, and rulerRows returns the type it got (#224)', () => {
  const rules: UsageRule[] = [
    { source: 'day', percent: 80, maxWorkers: 1 },
    { source: 'week', percent: 50, signal: 'red', agent: 'codex' },
    { source: 'week', percent: 90, maxWorkers: 2 },
  ];
  assert.deepEqual(measuresInUse(rules), ['week', 'day']);
  assert.deepEqual(rulersInUse(rules, 'claude'), [{ source: 'week' }, { source: 'week', agent: 'codex' }, { source: 'day' }]);
  const week: UsageRule[] = rulerRows(rules, { source: 'week' }, 'claude');
  assert.deepEqual(week, [rules[2]]);
  assert.deepEqual(rulerRows(rules, { source: 'week', agent: 'codex' }, 'claude'), [rules[1]]);
});
