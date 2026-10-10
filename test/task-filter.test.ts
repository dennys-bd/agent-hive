import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facetOptions, isRuleComplete, matchesRules, NO_VALUE, valuesOf } from '../src/task-filter.js';
import type { FilterOp, FilterRule, Item, ItemFacets } from '../src/types.js';

type PlainField = Exclude<FilterRule['field'], 'projectField' | 'blocked'>;
const PLAIN: PlainField[] = ['assignee', 'label', 'milestone', 'repository'];
/** A task's facets as the GitHub adapter fills them (#374); an absent value comes as an empty list or no key. */
const facets = (extra: Partial<ItemFacets> = {}): ItemFacets => ({ assignees: [], labels: [], fields: {}, ...extra });
/** What the matcher reads of a task (#441): its facets and, here, no blockers. */
const withFacets = (extra: Partial<ItemFacets> = {}): Pick<Item, 'facets'> => ({ facets: facets(extra) });
const rule = (field: PlainField, op: FilterOp, values: string[]): FilterRule => ({ field, op, values });
const priority = (op: FilterOp, values: string[], name = 'Priority'): FilterRule => ({ field: 'projectField', name, op, values });
const BLOCKED: FilterRule = { field: 'blocked', op: 'any' };
const FREE: FilterRule = { field: 'blocked', op: 'none' };

test('valuesOf reads each criterion off the facets: the lists as they are, milestone and repository as one value or none, a projectField rule its named field only; no facets read nothing (#374)', () => {
  const item = withFacets({ assignees: ['ana'], labels: ['bug', 'hive'], milestone: 'v1', repository: 'acme/app', fields: { Priority: 'P1', Size: 'S' } });
  assert.deepEqual(valuesOf(item, rule('assignee', 'any', [])), ['ana']);
  assert.deepEqual(valuesOf(item, rule('label', 'any', [])), ['bug', 'hive']);
  assert.deepEqual(valuesOf(item, rule('milestone', 'any', [])), ['v1']);
  assert.deepEqual(valuesOf(item, rule('repository', 'any', [])), ['acme/app']);
  assert.deepEqual(valuesOf(item, priority('any', [], ' priority ')), ['P1'], 'the field name matches like a value');
  assert.deepEqual(valuesOf(withFacets(), rule('milestone', 'any', [])), []);
  assert.deepEqual(valuesOf(undefined, rule('label', 'any', [])), [], 'no task');
  assert.deepEqual(valuesOf({ blockedBy: ['T-1'] }, rule('label', 'any', [])), [], 'a local task has no facets');
  assert.deepEqual(valuesOf({ ...item, blockedBy: ['7'] }, BLOCKED), [], 'a blocked rule has no values to read (#441)');
});

test('matchesRules: any needs one of its values on the task and none needs none of them, on each plain criterion, case-insensitive and trimmed (#245, #374)', () => {
  const item = withFacets({ assignees: ['Ana'], labels: ['hive', 'bug'], milestone: 'v1', repository: 'acme/app' });
  const cases: [PlainField, string[], string[]][] = [
    ['assignee', ['bia', ' ANA '], ['bia']],
    ['label', ['docs', 'Bug'], ['docs']],
    ['milestone', ['V1'], ['v2']],
    ['repository', ['ACME/app'], ['acme/site']],
  ];
  for (const [field, hit, miss] of cases) {
    assert.equal(matchesRules([rule(field, 'any', hit)], item), true, `${field}: any, one value on the task`);
    assert.equal(matchesRules([rule(field, 'any', miss)], item), false, `${field}: any, none on the task`);
    assert.equal(matchesRules([rule(field, 'none', hit)], item), false, `${field}: none, one value on the task`);
    assert.equal(matchesRules([rule(field, 'none', miss)], item), true, `${field}: none, none on the task`);
  }
});

test('matchesRules: [] passes every task; no facets at all, or no value for a criterion, fails any and passes none (#374)', () => {
  assert.equal(matchesRules([], undefined), true);
  for (const field of PLAIN) {
    for (const item of [undefined, {}, withFacets()]) {
      assert.equal(matchesRules([rule(field, 'any', ['x'])], item), false, `${field} any`);
      assert.equal(matchesRules([rule(field, 'none', ['x'])], item), true, `${field} none`);
    }
  }
  assert.equal(matchesRules([priority('any', ['P0'])], undefined), false);
  assert.equal(matchesRules([priority('none', ['P0'])], undefined), true);
});

test('matchesRules: the rules AND together, the same criterion twice included (#245)', () => {
  const hiveOnly = [rule('label', 'any', ['hive']), rule('label', 'none', ['blocked'])];
  assert.equal(matchesRules(hiveOnly, withFacets({ labels: ['hive'] })), true);
  assert.equal(matchesRules(hiveOnly, withFacets({ labels: ['hive', 'blocked'] })), false);
  assert.equal(matchesRules([rule('assignee', 'any', ['ana']), rule('label', 'any', ['docs'])], withFacets({ assignees: ['ana'], labels: ['hive'] })), false);
});

test('matchesRules: a projectField rule reads the named field\'s option and no other field\'s (#245)', () => {
  const item = withFacets({ fields: { Priority: 'P1', Size: 'P0' } });
  assert.equal(matchesRules([priority('any', ['P0', 'p1'])], item), true);
  assert.equal(matchesRules([priority('any', ['P0'])], item), false, 'Size carries P0: another field is never read');
  assert.equal(matchesRules([priority('none', ['P0'])], item), true);
  assert.equal(matchesRules([priority('any', ['P1'], ' priority ')], item), true);
});

test('matchesRules: @me in an assignee rule is `me`; left unresolved an any rule fails and a none rule excludes nobody (#245, #374)', () => {
  const item = withFacets({ assignees: ['Ana'] });
  assert.equal(matchesRules([rule('assignee', 'any', ['@ME'])], item, 'ana'), true, 'any case');
  assert.equal(matchesRules([rule('assignee', 'any', ['@me'])], item, 'bia'), false);
  assert.equal(matchesRules([rule('assignee', 'any', ['@me'])], item), false, 'a stage\'s view filter knows no login: it never widens');
  assert.equal(matchesRules([rule('assignee', 'none', ['@me'])], item), true, '"@me" equals no login');
  assert.equal(matchesRules([rule('label', 'any', ['@me'])], withFacets({ labels: ['@me'] }), 'ana'), true, 'on another criterion it is just a value');
});

test('matchesRules: the no-value entry matches a task with no value for the criterion, alone or ORed with others (#524)', () => {
  const unassigned = withFacets();
  const mine = withFacets({ assignees: ['ana'] });
  const other = withFacets({ assignees: ['bia'] });
  const anyOf = [rule('assignee', 'any', ['@me', NO_VALUE])];
  assert.equal(matchesRules(anyOf, unassigned, 'ana'), true, 'nobody assigned');
  assert.equal(matchesRules(anyOf, mine, 'ana'), true, 'assigned to me');
  assert.equal(matchesRules(anyOf, other, 'ana'), false, 'someone else');
  assert.equal(matchesRules([rule('assignee', 'none', [NO_VALUE])], unassigned), false, 'none of "no value" wants a value');
  assert.equal(matchesRules([rule('milestone', 'any', [NO_VALUE])], withFacets({ milestone: 'v1' })), false);
  assert.equal(matchesRules([priority('any', [NO_VALUE])], withFacets({ fields: { Status: 'Todo' } })), true, 'another field is not this one');
  assert.equal(matchesRules([rule('label', 'any', [NO_VALUE])], withFacets({ labels: [NO_VALUE] })), false, 'a label spelled like it is still a value');
});

test('matchesRules: a blocked rule reads the task\'s open blockers, facets or not: any takes a blocked task, none a free one; [] or no blockedBy is free (#441)', () => {
  const items: [string, Pick<Item, 'facets' | 'blockedBy'> | undefined, boolean][] = [
    ['open blockers, no facets', { blockedBy: ['T-1'] }, true],
    ['open blockers, with facets (GitHub)', { ...withFacets(), blockedBy: ['7'] }, true],
    ['blockedBy: []', { ...withFacets(), blockedBy: [] }, false],
    ['no blockedBy', withFacets(), false],
    ['no task at all', undefined, false],
  ];
  for (const [what, item, blocked] of items) {
    assert.equal(matchesRules([BLOCKED], item), blocked, `${what}: any`);
    assert.equal(matchesRules([FREE], item), !blocked, `${what}: none`);
  }
});

test('matchesRules: a blocked rule ANDs with the other rules (#441)', () => {
  const rules = [rule('label', 'any', ['hive']), FREE];
  assert.equal(matchesRules(rules, withFacets({ labels: ['hive'] })), true);
  assert.equal(matchesRules(rules, { ...withFacets({ labels: ['hive'] }), blockedBy: ['7'] }), false, 'the label passes, but the task is blocked');
  assert.equal(matchesRules(rules, withFacets({ labels: ['docs'] })), false, 'free, but the label rule fails');
});

test('facetOptions lists each criterion\'s distinct values, first spelling kept, sorted case-insensitively, and each field found with its options; no @me (#374)', () => {
  const found = facetOptions([
    facets({ assignees: ['bia', 'Ana'], labels: ['hive'], milestone: 'v2', repository: 'acme/site', fields: { Priority: 'P1' } }),
    facets({ assignees: ['ana'], labels: ['Bug', 'hive'], milestone: 'v1', repository: 'acme/app', fields: { priority: 'P0', Size: 'S' } }),
    facets(),
  ]);
  assert.deepEqual(found, {
    assignees: ['Ana', 'bia'], labels: ['Bug', 'hive'], milestones: ['v1', 'v2'], repositories: ['acme/app', 'acme/site'],
    projectFields: [{ name: 'Priority', options: ['P0', 'P1'] }, { name: 'Size', options: ['S'] }],
  });
  assert.deepEqual(facetOptions([]), { assignees: [], labels: [], milestones: [], repositories: [], projectFields: [] });
});

test('isRuleComplete: a rule needs at least one value, and a projectField rule a field name; a blocked rule needs neither (#245, #441)', () => {
  assert.equal(isRuleComplete(rule('label', 'any', ['hive'])), true);
  assert.equal(isRuleComplete(rule('label', 'any', [])), false);
  assert.equal(isRuleComplete(priority('none', ['P0'])), true);
  assert.equal(isRuleComplete(priority('none', ['P0'], '  ')), false);
  assert.equal(isRuleComplete(FREE), true);
  assert.equal(isRuleComplete(BLOCKED), true);
});
