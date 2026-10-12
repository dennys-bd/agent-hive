import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facetsOf, matchesFilter, projectQuery, splitBlocked, usesMe } from '../../src/sources/github-filter.js';
import { ITEMS, type GhItemNode } from '../../src/sources/github-queries.js';
import type { FilterOp, FilterRule } from '../../src/types.js';

type PlainField = Exclude<FilterRule['field'], 'projectField' | 'blocked'>;
const PLAIN: PlainField[] = ['assignee', 'label', 'milestone', 'repository'];
interface Attrs { assignees?: string[]; labels?: string[]; milestone?: string; repository?: string; fields?: Record<string, string> }

/** An issue item as ITEMS answers it; an absent attribute comes back the way GitHub sends it (empty nodes, null). The trailing {} is a
 * field value of another kind (text, number), which the single-select fragment answers empty. */
const issue = (attrs: Attrs = {}): GhItemNode => ({
  id: 'I1',
  fieldValues: { nodes: [...Object.entries(attrs.fields ?? {}).map(([field, name]) => ({ name, field: { name: field } })), {}] },
  content: {
    __typename: 'Issue', number: 1, url: 'https://github.com/acme/app/issues/1',
    assignees: { nodes: (attrs.assignees ?? []).map((login) => ({ login })) },
    labels: { nodes: (attrs.labels ?? []).map((name) => ({ name })) },
    milestone: attrs.milestone === undefined ? null : { title: attrs.milestone },
    repository: attrs.repository === undefined ? null : { nameWithOwner: attrs.repository },
  },
});
const rule = (field: PlainField, op: FilterOp, values: string[]): FilterRule => ({ field, op, values });
const priority = (op: FilterOp, values: string[], name = 'Priority'): FilterRule => ({ field: 'projectField', name, op, values });

test('matchesFilter: [] takes every item, even one GitHub sent no content for (#245)', () => {
  assert.equal(matchesFilter([], undefined, issue()), true);
  assert.equal(matchesFilter([], undefined, { id: 'I2', content: null }), true);
});

test('matchesFilter: any needs one of its values on the task and none needs none of them, on each plain criterion, case-insensitive and trimmed (#245)', () => {
  const task = issue({ assignees: ['Ana'], labels: ['hive', 'bug'], milestone: 'v1', repository: 'acme/app' });
  const cases: [PlainField, string[], string[]][] = [
    ['assignee', ['bia', ' ANA '], ['bia']],
    ['label', ['docs', 'Bug'], ['docs']],
    ['milestone', ['V1'], ['v2']],
    ['repository', ['ACME/app'], ['acme/site']],
  ];
  for (const [field, hit, miss] of cases) {
    assert.equal(matchesFilter([rule(field, 'any', hit)], undefined, task), true, `${field}: any, one value on the task`);
    assert.equal(matchesFilter([rule(field, 'any', miss)], undefined, task), false, `${field}: any, none on the task`);
    assert.equal(matchesFilter([rule(field, 'none', hit)], undefined, task), false, `${field}: none, one value on the task`);
    assert.equal(matchesFilter([rule(field, 'none', miss)], undefined, task), true, `${field}: none, none on the task`);
  }
});

test('matchesFilter: a task with no value for a criterion fails any and passes none (#245)', () => {
  const bare = issue();
  for (const field of PLAIN) {
    assert.equal(matchesFilter([rule(field, 'any', ['x'])], undefined, bare), false, `${field} any`);
    assert.equal(matchesFilter([rule(field, 'none', ['x'])], undefined, bare), true, `${field} none: no milestone passes "milestone is none of v1"`);
  }
  assert.equal(matchesFilter([priority('any', ['P0'])], undefined, bare), false);
  assert.equal(matchesFilter([priority('none', ['P0'])], undefined, bare), true);
});

test('matchesFilter: the rules AND together, the same criterion twice included (#245)', () => {
  const hiveOnly = [rule('label', 'any', ['hive']), rule('label', 'none', ['blocked'])];
  assert.equal(matchesFilter(hiveOnly, undefined, issue({ labels: ['hive'] })), true);
  assert.equal(matchesFilter(hiveOnly, undefined, issue({ labels: ['hive', 'blocked'] })), false);
  assert.equal(matchesFilter([rule('assignee', 'any', ['ana']), rule('label', 'any', ['docs'])], undefined, issue({ assignees: ['ana'], labels: ['hive'] })), false);
});

test('matchesFilter: @me in an assignee rule is the polling login; unresolved, an any rule does not pass and a none rule excludes nobody (#245)', () => {
  const task = issue({ assignees: ['Ana'] });
  assert.equal(matchesFilter([rule('assignee', 'any', ['@ME'])], 'ana', task), true, 'any case');
  assert.equal(matchesFilter([rule('assignee', 'any', ['@me'])], 'bia', task), false);
  assert.equal(matchesFilter([rule('assignee', 'none', ['@me'])], 'ana', task), false);
  assert.equal(matchesFilter([rule('assignee', 'any', ['@me'])], undefined, task), false, 'fail closed: never widens the filter');
  assert.equal(matchesFilter([rule('assignee', 'none', ['@me'])], undefined, task), true, '"@me" equals no login');
  assert.equal(matchesFilter([rule('label', 'any', ['@me'])], 'ana', issue({ labels: ['@me'] })), true, 'on another criterion it is just a value');
});

test('matchesFilter: a projectField rule reads the named single-select field\'s option and no other field\'s (#245)', () => {
  const task = issue({ fields: { Priority: 'P1', Size: 'P0' } });
  assert.equal(matchesFilter([priority('any', ['P0', 'p1'])], undefined, task), true);
  assert.equal(matchesFilter([priority('any', ['P0'])], undefined, task), false, 'Size carries P0: another field is never read');
  assert.equal(matchesFilter([priority('none', ['P0'])], undefined, task), true);
  assert.equal(matchesFilter([priority('any', ['P1'], ' priority ')], undefined, task), true, 'the field name matches like a value');
});

test('usesMe: only an assignee rule saying @me, in any case, asks for the viewer (#245)', () => {
  assert.equal(usesMe([]), false);
  assert.equal(usesMe([rule('assignee', 'none', ['ana', ' @Me '])]), true);
  assert.equal(usesMe([rule('label', 'any', ['@me']), priority('any', ['@me'])]), false);
});

test('facetsOf reads what a rule can match on an item: logins, labels, the milestone\'s title, owner/name and each single-select field\'s option by name; Status and text fields are left out, and a bare item gives empty lists (#374)', () => {
  const item = issue({ assignees: ['Ana'], labels: ['hive'], milestone: 'v1', repository: 'acme/app', fields: { Status: 'Ready', Priority: 'P1' } });
  const withText: GhItemNode = { ...item, fieldValues: { nodes: [...(item.fieldValues?.nodes ?? []), { text: 'ops', field: { name: 'Area' } }] } };
  assert.deepEqual(facetsOf(withText), { assignees: ['Ana'], labels: ['hive'], milestone: 'v1', repository: 'acme/app', fields: { Priority: 'P1' } });
  assert.deepEqual(facetsOf(issue()), { assignees: [], labels: [], fields: {} });
  assert.deepEqual(facetsOf({ id: 'I2', content: null }), { assignees: [], labels: [], fields: {} });
});

test('the items query asks each issue\'s repository and each item\'s set field values with their field names, single-select or text (#245, #293)', () => {
  assert.match(ITEMS, /milestone \{ title \} repository \{ nameWithOwner \}/);
  assert.match(ITEMS, /fieldValues\(first: 20\) \{/);
  assert.match(ITEMS, /\.\.\. on ProjectV2ItemFieldSingleSelectValue \{ name field \{ \.\.\. on ProjectV2SingleSelectField \{ name \} \} \}/);
  assert.match(ITEMS, /\.\.\. on ProjectV2ItemFieldTextValue \{ text field \{ \.\.\. on ProjectV2Field \{ name \} \} \}/);
});

test('splitBlocked parts a source filter into its blocked rules and the others, each in order; matchesFilter alone reads every item as free (#441)', () => {
  const free: FilterRule = { field: 'blocked', op: 'none' };
  const hive = rule('label', 'any', ['hive']);
  const p0 = priority('none', ['P0']);
  assert.deepEqual(splitBlocked([hive, free, p0]), { blocked: [free], other: [hive, p0] });
  assert.deepEqual(splitBlocked([]), { blocked: [], other: [] });
  assert.equal(matchesFilter([{ field: 'blocked', op: 'any' }], undefined, issue()), false, 'an item carries no relations: why listItems judges blocked after the relations query');
});

test('projectQuery writes each plain rule in the Project\'s filter syntax and ANDs them with a space; none negates (#234)', () => {
  assert.equal(projectQuery([rule('milestone', 'any', ['Wave 1', 'beta'])]), 'milestone:"Wave 1","beta"');
  assert.equal(projectQuery([rule('label', 'none', ['wip'])]), '-label:"wip"');
  assert.equal(projectQuery([rule('assignee', 'any', ['@ME', 'ana'])]), 'assignee:@me,"ana"');
  assert.equal(projectQuery([rule('repository', 'any', ['acme/app']), rule('label', 'any', ['bug'])]), 'repo:"acme/app" label:"bug"');
});

test('projectQuery: "nenhum" alone becomes no: or has:; a rule it cannot say is left to matchesFilter; no rule left gives undefined (#234)', () => {
  assert.equal(projectQuery([rule('milestone', 'any', ['@none'])]), 'no:milestone');
  assert.equal(projectQuery([rule('milestone', 'none', ['@none'])]), 'has:milestone');
  assert.equal(projectQuery([rule('milestone', 'any', ['@none', 'beta'])]), undefined, 'emptiness OR a value is not one qualifier');
  assert.equal(projectQuery([rule('label', 'any', ['say "hi"'])]), undefined);
  assert.equal(projectQuery([priority('any', ['High']), { field: 'blocked', op: 'any' }]), undefined);
  assert.equal(projectQuery([priority('any', ['High']), rule('label', 'any', ['bug'])]), 'label:"bug"');
  assert.equal(projectQuery([]), undefined);
});
