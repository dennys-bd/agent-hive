import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTaskProps, parseSourceTaskProps, predatesTaskProps, RULE_FIELD_MAX, RULE_VALUE_MAX, RULES_MAX } from '../src/task-props.js';
import type { RuleOp, TaskProps, TaskRule } from '../src/types.js';

const rule = (field: string, op: RuleOp, value: string, workspace: string): TaskRule => ({ field, op, value, set: { workspace } });
const match = (rules: TaskRule[], read: (field: string) => string[]) => matchTaskProps(rules, read).workspace; // the operators and readers act on the workspace the same way as on any property
/** One item's fields: each name to its values; a name it lacks reads []. */
const item = (fields: Record<string, string[]>) => (field: string): string[] => fields[field] ?? [];

test('matchTaskProps: each operator, both sides trimmed, the i forms ignoring case; the first matching rule wins; no match is undefined (#293)', () => {
  const title = item({ title: ['  [Backend] Login  '] });
  const cases: [RuleOp, string, boolean][] = [
    ['equals', '[Backend] Login', true], ['equals', '[backend] login', false],
    ['iequals', ' [BACKEND] LOGIN ', true], ['iequals', '[Backend]', false],
    ['contains', '[Backend]', true], ['contains', '[backend]', false],
    ['icontains', ' [BACKEND] ', true], ['icontains', '[frontend]', false],
  ];
  for (const [op, value, hit] of cases) assert.equal(match([rule('title', op, value, 'api')], title), hit ? 'api' : undefined, `${op} ${value}`);
  const rules = [rule('title', 'icontains', 'login', 'first'), rule('title', 'icontains', 'backend', 'second')];
  assert.equal(match(rules, title), 'first', 'top to bottom: the first match decides');
  assert.equal(match([rule('title', 'icontains', 'nope', 'x'), rules[1]], title), 'second', 'a rule that does not match is skipped');
  assert.equal(match([], title), undefined, 'no rules: no workspace');
});

test('matchTaskProps reads every value of a field: labels match on any label; a field with no values never matches (#293)', () => {
  const labels = item({ labels: ['bug', 'Web'] });
  assert.equal(match([rule('labels', 'iequals', 'web', 'site')], labels), 'site');
  assert.equal(match([rule('labels', 'equals', 'web', 'site')], labels), undefined);
  assert.equal(match([rule('Repo', 'contains', 'a', 'site')], labels), undefined, 'absent field: no value, no error');
  assert.equal(match([rule('Repo', 'icontains', 'x', 'site')], item({ Repo: ['  '] })), undefined, 'a blank value is no value');
});

const PROJECTS = ['hive', 'site'];

const PROPS_FIELD = 'comb.sources[0].taskProps';
const parseProps = (raw: unknown) => parseSourceTaskProps(raw, PROPS_FIELD, PROJECTS);
const refusedProps = (raw: unknown, message: string) => assert.throws(() => parseProps(raw), { message: `hive.config.json: ${message}` }, JSON.stringify(raw));
const SETS_SITE = { field: 'labels', op: 'icontains', value: 'core', set: { workspace: 'site' } };

test('parseSourceTaskProps accepts zero rules, no default workspace when a rule sets one, a rule setting both, field and value trimmed; RULES_MAX is inclusive (#688)', () => {
  assert.deepEqual(parseProps({ defaults: { workspace: 'hive', auto: true }, rules: [] }), { defaults: { workspace: 'hive', auto: true }, rules: [] });
  assert.deepEqual(parseProps({ defaults: { auto: false }, rules: [SETS_SITE] }), { defaults: { auto: false }, rules: [SETS_SITE] });
  assert.deepEqual(
    parseProps({ defaults: { auto: true }, rules: [{ field: ' title ', op: 'iequals', value: ' [api] ', set: { workspace: 'hive', auto: false } }] }).rules,
    [{ field: 'title', op: 'iequals', value: '[api]', set: { workspace: 'hive', auto: false } }],
  );
  assert.equal(parseProps({ defaults: { auto: true }, rules: Array.from({ length: RULES_MAX }, () => SETS_SITE) }).rules.length, RULES_MAX);
});

test('parseSourceTaskProps refuses the #293 shape, a non-boolean auto, an unlisted workspace, an empty set or an unknown key in it, no workspace anywhere and too many rules, naming the path (#688)', () => {
  const shape = `"${PROPS_FIELD}" must be an object like { "defaults": { "auto": true }, "rules": [] }`;
  for (const old of [undefined, 'hive', { mode: 'fixed', workspace: 'hive' }, { defaults: 'x', rules: [] }]) refusedProps(old, shape);
  for (const auto of [undefined, 'yes', 1]) refusedProps({ defaults: { workspace: 'hive', auto }, rules: [] }, `"${PROPS_FIELD}.defaults.auto" must be true or false`);
  refusedProps({ defaults: { workspace: 'nope', auto: true }, rules: [] }, `"${PROPS_FIELD}.defaults.workspace" must name one of "comb.workspaces"`);
  for (const rules of [undefined, 'x', Array.from({ length: RULES_MAX + 1 }, () => SETS_SITE)]) {
    refusedProps({ defaults: { workspace: 'hive', auto: true }, rules }, `"${PROPS_FIELD}.rules" must be an array of 0 to 50 rules`);
  }
  const second = (patch: Record<string, unknown>) => ({ defaults: { workspace: 'hive', auto: true }, rules: [SETS_SITE, { ...SETS_SITE, ...patch }] });
  for (const set of [{}, undefined, 'x']) refusedProps(second({ set }), `"${PROPS_FIELD}.rules[1].set" must set 1 or more of: workspace, auto`);
  refusedProps(second({ set: { flow: 'x' } }), `"${PROPS_FIELD}.rules[1].set.flow" is not a task property: workspace, auto`);
  refusedProps(second({ set: { workspace: 'nope' } }), `"${PROPS_FIELD}.rules[1].set.workspace" must name one of "comb.workspaces"`);
  refusedProps(second({ set: { auto: 'no' } }), `"${PROPS_FIELD}.rules[1].set.auto" must be true or false`);
  for (const field of ['', '   ', 'x'.repeat(RULE_FIELD_MAX + 1), 7]) refusedProps(second({ field }), `"${PROPS_FIELD}.rules[1].field" must be 1 to 100 characters`);
  for (const value of ['', '  ', 'v'.repeat(RULE_VALUE_MAX + 1), undefined]) refusedProps(second({ value }), `"${PROPS_FIELD}.rules[1].value" must be 1 to 200 characters`);
  refusedProps(second({ op: 'regex' }), `"${PROPS_FIELD}.rules[1].op" must be one of: equals, iequals, contains, icontains`);
  refusedProps({ defaults: { auto: true }, rules: [{ ...SETS_SITE, set: { auto: false } }] }, `"${PROPS_FIELD}.defaults.workspace" is required when no rule sets workspace`);
});

test('matchTaskProps: per property the first matching rule that sets it; a workspace-only rule never shadows a later auto rule; a non-matching rule is skipped; a missing field never matches (#688)', () => {
  const fields = item({ labels: ['core', 'manual'], title: ['[Core] login'] });
  const r = (field: string, value: string, set: Partial<TaskProps>): TaskRule => ({ field, op: 'icontains', value, set });
  const rules = [r('labels', 'core', { workspace: 'site' }), r('labels', 'nope', { auto: true }), r('title', 'core', { workspace: 'hive', auto: false }), r('Repo', 'x', { auto: true })];
  assert.deepEqual(matchTaskProps(rules, fields), { workspace: 'site', auto: false }, 'rule 1 gives workspace, rule 2 does not match, rule 3 still gives auto');
  assert.deepEqual(matchTaskProps([rules[3]], fields), {}, 'a missing field: no value, no match');
  assert.deepEqual(matchTaskProps([], fields), {});
});

test('predatesTaskProps spots a source whose taskProps is not an object: the #293 workspace setting, or nothing (#688)', () => {
  const file = (...sources: unknown[]) => ({ comb: { sources } });
  const now = { name: 'a', taskProps: { defaults: { auto: true }, rules: [] } };
  assert.equal(predatesTaskProps(file(now)), false);
  assert.equal(predatesTaskProps(file(now, { name: 'b', workspace: { mode: 'fixed', workspace: 'hive' } })), true);
  assert.equal(predatesTaskProps(file({ name: 'a', taskProps: 'x' })), true);
  assert.deepEqual([predatesTaskProps(file()), predatesTaskProps({}), predatesTaskProps('x')], [false, false, false]);
});
