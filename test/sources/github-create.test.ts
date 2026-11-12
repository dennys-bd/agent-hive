import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config.js';
import { createSource, namespaced, sourceSpec } from '../../src/source.js';
import { listFilterOptions } from '../../src/sources/github.js';
import { CreateRefusedError, IssuePlacementError } from '../../src/source-create.js';
import type { Source } from '../../src/types.js';
import { repositoryLabels } from '../../src/sources/github-create.js';
import { GITHUB_ENTRY, combConfig, fakeGql, fakeSourceFactory, FILTER } from '../fakes.js';

const options = [{ id: 'O_ready', name: 'Ready' }, { id: 'O_prog', name: 'In progress' }, { id: 'O_rev', name: 'In review' }];
const fields = { repositoryOwner: { projectV2: { id: 'PVT_1', field: { id: 'F_status', options } } } };
const ISSUE_URL = 'https://github.com/acme/app/issues/9';
const ISSUE = { createIssue: { issue: { id: 'I_9', number: 9, url: ISSUE_URL } } };
const LABELS = { repository: { labels: { nodes: [{ id: 'L_bug', name: 'bug' }, { id: 'L_docs', name: 'docs' }] } } };
const specWith = (extra: Record<string, unknown> = {}) => {
  const config = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter: FILTER, ...extra } }));
  return sourceSpec(config, config.comb.sources[0]);
};

test('create makes the issue in the source\'s repository, adds it to the Project and sets the Status option, in that order; the repository id is asked once (#846)', async () => {
  const { gql, calls } = fakeGql({
    fields, repositoryId: { repository: { id: 'R_app' } }, createIssue: ISSUE,
    addProjectItem: { addProjectV2ItemById: { item: { id: 'PVTI_9' } } }, setOption: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_9' } } },
  });
  const source = createSource(specWith({ repository: 'acme/app' }), { gql });
  await source.resolveFields();
  assert.deepEqual(await source.create?.({ title: 'Fix login', body: 'steps', column: 'Ready', labels: [] }), { itemId: 'PVTI_9', issue: { number: 9, url: ISSUE_URL } });
  assert.deepEqual(calls.slice(1).map((c) => [c.name, c.variables]), [
    ['repositoryId', { owner: 'acme', name: 'app' }],
    ['createIssue', { repositoryId: 'R_app', title: 'Fix login', body: 'steps' }],
    ['addProjectItem', { projectId: 'PVT_1', contentId: 'I_9' }],
    ['setOption', { projectId: 'PVT_1', itemId: 'PVTI_9', fieldId: 'F_status', singleSelectOptionId: 'O_ready' }],
  ]);
  await source.create?.({ title: 'Again', column: 'Ready', labels: [] });
  assert.equal(calls.filter((c) => c.name === 'repositoryId').length, 1, 'cached per source');
});

test('create refuses a source without a repository, and a column the Status lacks or a label the repository lacks with CreateRefusedError, before any write (#846, #767)', async () => {
  const { gql, calls } = fakeGql({ fields, repositoryLabels: LABELS });
  const bare = createSource(specWith(), { gql });
  await bare.resolveFields();
  await assert.rejects(bare.create!({ title: 'x', column: 'Ready', labels: [] }), { message: 'source has no repository for new issues' });
  const placed = createSource(specWith({ repository: 'acme/app' }), { gql });
  await placed.resolveFields();
  await assert.rejects(placed.create!({ title: 'x', column: 'Done', labels: [] }), (err) => err instanceof CreateRefusedError && /"Done" is not a Status option/.test(err.message));
  await assert.rejects(placed.create!({ title: 'x', column: 'Ready', labels: ['bug', 'nope'] }), (err) => err instanceof CreateRefusedError && /"nope"/.test(err.message) && /bug, docs/.test(err.message));
  assert.deepEqual(calls.map((c) => c.name), ['fields', 'fields', 'repositoryLabels'], 'reads only: no mutation ran');
});

test('a failure after the issue exists throws IssuePlacementError naming its url and carrying its number (#846, #767)', async () => {
  const { gql } = fakeGql({ fields, repositoryId: { repository: { id: 'R_app' } }, createIssue: ISSUE }); // addProjectItem unanswered: the fake throws
  const source = createSource(specWith({ repository: 'acme/app' }), { gql });
  await source.resolveFields();
  const err = await source.create!({ title: 'x', column: 'Ready', labels: [] }).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof IssuePlacementError);
  assert.deepEqual([err.message, err.issue], [`issue ${ISSUE_URL} was created but not labeled or placed on the Project: unexpected graphql call: addProjectItem`, { number: 9, url: ISSUE_URL }]);
});

test('create sends the label ids to the new issue; column null runs no Project write and answers no itemId (#767)', async () => {
  const { gql, calls } = fakeGql({
    fields, repositoryLabels: LABELS, repositoryId: { repository: { id: 'R_app' } }, createIssue: ISSUE, addLabels: { addLabelsToLabelable: { clientMutationId: null } },
  });
  const source = createSource(specWith({ repository: 'acme/app' }), { gql });
  await source.resolveFields();
  assert.deepEqual(await source.create?.({ title: 'Fix', column: null, labels: ['docs', 'bug'] }), { issue: { number: 9, url: ISSUE_URL } });
  assert.deepEqual(calls.slice(1).map((c) => [c.name, c.variables]), [
    ['repositoryLabels', { owner: 'acme', name: 'app' }],
    ['repositoryId', { owner: 'acme', name: 'app' }],
    ['createIssue', { repositoryId: 'R_app', title: 'Fix', body: '' }],
    ['addLabels', { labelableId: 'I_9', l0: 'L_bug', l1: 'L_docs' }],
  ]);
});

test('namespaced create answers the item under its source\'s name, and an issue off the Project as it is (#846, #767)', async () => {
  const issue = { number: 9, url: ISSUE_URL };
  const create = async ({ column }: Parameters<NonNullable<Source['create']>>[0]) => (column === null ? { issue } : { itemId: 'PVTI_9', issue });
  const board = namespaced(GITHUB_ENTRY, { ...fakeSourceFactory().factory(specWith()), create });
  assert.deepEqual(await board.create?.({ title: 'x', column: 'Ready', labels: [] }), { itemId: 'board:PVTI_9', issue });
  assert.deepEqual(await board.create?.({ title: 'x', column: null, labels: [] }), { issue });
});

test('repositoryLabels reads the repository\'s labels by owner and name, and throws for a repository that is gone (#767)', async () => {
  const { gql, calls } = fakeGql({ repositoryLabels: [LABELS, { repository: null }] });
  assert.deepEqual(await repositoryLabels(gql, 'acme/app'), [{ id: 'L_bug', name: 'bug' }, { id: 'L_docs', name: 'docs' }]);
  await assert.rejects(repositoryLabels(gql, 'acme/gone'), { message: 'repository acme/gone not found' });
  assert.deepEqual(calls.map((c) => [c.name, c.variables]), [['repositoryLabels', { owner: 'acme', name: 'app' }], ['repositoryLabels', { owner: 'acme', name: 'gone' }]]);
});

test('listFilterOptions answers the Project\'s linked repositories (#846)', async () => {
  const { gql } = fakeGql({
    items: { repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
    selectFields: { repositoryOwner: { projectV2: { fields: { nodes: [] }, repositories: { nodes: [{ nameWithOwner: 'acme/app' }, { nameWithOwner: 'acme/site' }] } } } },
  });
  assert.deepEqual((await listFilterOptions('acme', 6, gql)).linkedRepositories, ['acme/app', 'acme/site']);
});
