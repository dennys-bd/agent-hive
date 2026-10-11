import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { type ConventionRowDraft, conventionRows, conventionsFrom, conventionsProblem, rowFor, unusedKeys } from '../src/ui/lib/settings-conventions.js';
import { emptyWorkspace, type WorkspaceDraft } from '../src/ui/lib/settings-form.js';
import type { Conventions } from '../src/types.js';

const withoutId = ({ id: _id, ...row }: ConventionRowDraft) => row;
const workspace = (conventions: ConventionRowDraft[]): WorkspaceDraft => ({ ...emptyWorkspace(), name: 'hive', path: '/repo', conventions });

test('conventionRows / conventionsFrom round-trip saved conventions in key order, trimmed; blank rows are dropped and none sends no key (#692)', () => {
  const saved: Conventions = { testCommand: 'pnpm test', delivery: 'stacked', sliceSize: { min: 300, max: 550 }, specsDir: 'docs/specs' };
  const rows = conventionRows(saved);
  assert.deepEqual(rows.map(withoutId), [
    { key: 'specsDir', value: 'docs/specs', min: '', max: '' }, { key: 'delivery', value: 'stacked', min: '', max: '' },
    { key: 'sliceSize', value: '', min: '300', max: '550' }, { key: 'testCommand', value: 'pnpm test', min: '', max: '' },
  ]);
  assert.deepEqual(conventionsFrom(rows), { conventions: saved });
  assert.deepEqual(conventionsFrom([...rows, rowFor('docsRepo'), { ...rowFor('uiCheck'), value: '  ' }]), { conventions: saved }, 'a blank row is a + never filled');
  assert.deepEqual(conventionsFrom([{ ...rowFor('specsDir'), value: ' docs/s ' }]), { conventions: { specsDir: 'docs/s' } });
  assert.deepEqual(conventionsFrom([]), {});
  assert.deepEqual(conventionRows(undefined), []);
});

test('rowFor starts an enumeration on its first option and anything else empty; unusedKeys keeps the row\'s own key (#692)', () => {
  assert.deepEqual([rowFor('delivery').value, rowFor('featureFlags').value, rowFor('specsDir').value], ['single', 'none', '']);
  assert.equal(rowFor('docsRepo', 'r1').id, 'r1');
  const rows = [rowFor('docsRepo'), rowFor('specsDir')];
  assert.deepEqual(unusedKeys(rows).slice(0, 2), ['plansDir', 'walkthroughsDir']);
  assert.deepEqual(unusedKeys(rows, 'specsDir').slice(0, 2), ['specsDir', 'plansDir']);
});

test('conventionsProblem names the first row the parser would refuse as its message does, on workspaces; blank rows pass (#692)', () => {
  setLanguage('en');
  const problem = (rows: ConventionRowDraft[]) => conventionsProblem([workspace(rows)]);
  assert.equal(problem([rowFor('docsRepo'), rowFor('sliceSize')]), undefined);
  assert.deepEqual(problem([{ ...rowFor('sliceSize'), min: '600', max: '550' }]), { section: 'workspaces', message: 'workspace hive: conventions.sliceSize must be { min, max } with 50 ≤ min ≤ max ≤ 5000' });
  assert.equal(problem([{ ...rowFor('sliceSize'), min: '300' }])?.message, t('settings.error.conventions.sliceSize', { workspace: 'hive' }));
  assert.equal(problem([{ ...rowFor('plansDir'), value: '../plans' }])?.message, 'workspace hive: conventions.plansDir must be a relative path inside the docs repository');
  assert.equal(problem([{ ...rowFor('chatLanguage'), value: 'x'.repeat(41) }])?.message, 'workspace hive: conventions.chatLanguage must be a language name of 1 to 40 characters');
  assert.equal(problem([{ ...rowFor('testCommand'), value: 'x'.repeat(501) }])?.message, 'workspace hive: conventions.testCommand must be 1 to 500 characters');
  assert.equal(problem([{ ...rowFor('decompositionLabel'), value: 'x'.repeat(51) }])?.message, 'workspace hive: conventions.decompositionLabel must be 1 to 50 characters');
});
