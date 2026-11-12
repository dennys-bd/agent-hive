import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftFacets, draftReader, routeOf, type CreateDraft } from '../src/create-route.js';
import { entryFor } from '../src/task-entry.js';
import { createGithubSource } from '../src/sources/github.js';
import type { FilterRule, Flow, SourceConfig, SourceTaskProps, Stage } from '../src/types.js';
import { fakeGql, FIXED, GITHUB_ENTRY } from './fakes.js';
import { itemNode } from './read-model/fixtures.js';

const st = (name: string, from: Record<string, string[]> = {}): Stage => ({ name, from, prompt: '/x' });
// Router and Spec (delivery) and Research (discovery) accept Backlog; Build accepts Ready only
const FLOWS: Flow[] = [
  { name: 'delivery', stages: [st('Router', { board: ['Backlog'] }), st('Spec', { board: ['Backlog'] }), st('Build', { board: ['Ready'] })], transitions: [] },
  { name: 'discovery', stages: [st('Research', { board: ['Backlog'] })], transitions: [] },
];
const PROPS: SourceTaskProps = { defaults: { workspace: 'hive', auto: true, entry: { flow: 'delivery' } }, rules: [] };
const source = (patch: Partial<Extract<SourceConfig, { type: 'github' }>> = {}): SourceConfig => ({ ...GITHUB_ENTRY, repository: 'acme/r', taskProps: PROPS, ...patch });
const draft = (patch: Partial<CreateDraft> = {}): CreateDraft => ({ source: 'board', title: 'New', labels: [], status: 'Backlog', ...patch });
const route = (d: CreateDraft, s: SourceConfig) => routeOf(d, [s], FLOWS);
const label = (value: string, set: SourceTaskProps['rules'][number]['set']): SourceTaskProps['rules'][number] => ({ field: 'labels', op: 'equals', value, set });

test('a draft in a Status a stage cites, passing the filter: taken with the defaults workspace and the entry a polled item gets (#769)', () => {
  assert.deepEqual(route(draft(), source()), { taken: true, workspace: 'hive', entry: { flow: 'delivery', stage: 'Router' }, reason: { kind: 'status', status: 'Backlog' } });
  const ready = route(draft({ status: 'Ready' }), source());
  assert.deepEqual(ready, { taken: true, workspace: 'hive', entry: { flow: 'delivery', stage: 'Build' }, reason: { kind: 'status', status: 'Ready' } });
});

test('a rule on labels that sets an entry or a workspace wins over the defaults and names its position (#769)', () => {
  const rules = [label('x', { auto: false }), label('bug', { entry: { flow: 'delivery', stage: 'Spec' } }), label('bug', { workspace: 'other' })];
  const answer = route(draft({ labels: ['bug'] }), source({ taskProps: { ...PROPS, rules } }));
  assert.deepEqual(answer, { taken: true, workspace: 'other', entry: { flow: 'delivery', stage: 'Spec' }, reason: { kind: 'rule', index: 1 }, workspaceRule: 2 });
});

test('a rule whose stage does not accept the Status falls back to the door, reason status (#769)', () => {
  const rules = [label('bug', { entry: { flow: 'delivery', stage: 'Build' } })];
  const answer = route(draft({ labels: ['bug'] }), source({ taskProps: { ...PROPS, rules } }));
  assert.deepEqual(answer, { taken: true, workspace: 'hive', entry: { flow: 'delivery', stage: 'Router' }, reason: { kind: 'status', status: 'Backlog' } });
});

test('an entry of null is taken, outside the flow (#769)', () => {
  const byDefault = route(draft(), source({ taskProps: { ...PROPS, defaults: { ...PROPS.defaults, entry: null } } }));
  assert.deepEqual(byDefault, { taken: true, workspace: 'hive', entry: null, reason: { kind: 'defaults' } });
  const byRule = route(draft({ labels: ['out'] }), source({ taskProps: { ...PROPS, rules: [label('out', { entry: null })] } }));
  assert.deepEqual(byRule, { taken: true, workspace: 'hive', entry: null, reason: { kind: 'rule', index: 0 } });
});

test('a draft with no workspace anywhere omits it (#769)', () => {
  const { workspace: _w, ...defaults } = PROPS.defaults;
  const answer = route(draft(), source({ taskProps: { ...PROPS, defaults } }));
  assert.equal(answer.taken && 'workspace' in answer, false);
});

test('a filter rule the draft fails is the miss, with its index; a Status no stage cites, a null Status and an unknown source miss otherwise (#769)', () => {
  const pass: FilterRule = { field: 'label', op: 'none', values: ['x'] };
  const fail: FilterRule = { field: 'label', op: 'any', values: ['hive'] };
  assert.deepEqual(route(draft(), source({ filter: [pass, fail] })), { taken: false, missed: { kind: 'filter', index: 1, rule: fail } });
  assert.equal(route(draft({ labels: ['hive'] }), source({ filter: [pass, fail] })).taken, true);
  assert.deepEqual(route(draft({ status: 'Done' }), source()), { taken: false, missed: { kind: 'status', status: 'Done' } });
  assert.deepEqual(route(draft({ status: null }), source()), { taken: false, missed: { kind: 'offProject' } });
  assert.deepEqual(routeOf(draft({ source: 'nope' }), [source()], FLOWS), { taken: false, missed: { kind: 'source' } });
});

test('a new issue has no assignee and no blockers: @me any fails, blocked none passes (#769)', () => {
  assert.equal(route(draft(), source({ filter: [{ field: 'assignee', op: 'any', values: ['@me'] }] })).taken, false);
  assert.equal(route(draft(), source({ filter: [{ field: 'blocked', op: 'none' }] })).taken, true);
});

test('the readers: facets carry labels and repository, the reader title, labels and Status (#769)', () => {
  assert.deepEqual(draftFacets(draft({ labels: ['a'] }), source()), { assignees: [], labels: ['a'], repository: 'acme/r', fields: {} });
  assert.equal('repository' in draftFacets(draft(), source({ repository: undefined })), false);
  const read = draftReader(draft({ title: 'T', labels: ['a'] }));
  assert.deepEqual([read('title'), read('labels'), read('Status'), read('Priority')], [['T'], ['a'], ['Backlog'], []]);
});

test('routeOf agrees with the poll: the same labels and Status, listed through the adapter, land in the same stage and workspace (#769)', async () => {
  const rules = [label('bug', { entry: { flow: 'delivery', stage: 'Spec' }, workspace: 'other' }), { field: 'Status', op: 'equals' as const, value: 'Ready', set: { workspace: 'ready-ws' } }];
  const props = { ...FIXED, rules };
  const s = source({ taskProps: props, filter: [{ field: 'label', op: 'any', values: ['bug', 'plain'] }] });
  const cited = [{ column: 'Backlog', by: 'Router' }, { column: 'Ready', by: 'Build' }];
  const list = (labels: readonly string[], status: string) => {
    const node = itemNode(1, status, undefined, { labels: { nodes: labels.map((name) => ({ name })) }, title: 'New' });
    const { gql } = fakeGql({ items: { rateLimit: { limit: 1, remaining: 1, resetAt: 'x' }, repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: [node] } } } }, relations: {} });
    return createGithubSource(s as Extract<SourceConfig, { type: 'github' }>, cited, gql).listItems();
  };
  // a label the filter leaves out: the poll lists nothing and the route is not taken, by that rule
  assert.deepEqual(await list(['other'], 'Backlog'), []);
  assert.deepEqual(route(draft({ labels: ['other'] }), s), { taken: false, missed: { kind: 'filter', index: 0, rule: s.filter[0] } });
  for (const [labels, status] of [[['bug'], 'Backlog'], [['plain'], 'Backlog'], [['plain'], 'Ready'], [['bug'], 'Ready']] as const) {
    const [listed] = await list(labels, status);
    // the server namespaces the source on the item; the bare adapter leaves it out
    const stage = entryFor(FLOWS, { ...listed, item: { ...listed.item, source: s.name } });
    const answer = route(draft({ labels: [...labels], status }), s);
    assert.ok(answer.taken && stage);
    assert.equal(answer.entry?.stage, stage.name, `${labels}/${status}: stage`);
    assert.equal(answer.workspace, listed.item.workspaceHint ?? props.defaults.workspace, `${labels}/${status}: workspace`);
  }
});
