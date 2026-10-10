import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config.js';
import { createSource, namespaced, sourceSpec } from '../../src/source.js';
import { listFilterOptions } from '../../src/sources/github.js';
import { GITHUB_ENTRY, combConfig, fakeGql, fakeSourceFactory, FILTER } from '../fakes.js';

const options = [{ id: 'O_ready', name: 'Ready' }, { id: 'O_prog', name: 'In progress' }, { id: 'O_rev', name: 'In review' }];
const fields = { repositoryOwner: { projectV2: { id: 'PVT_1', field: { id: 'F_status', options } } } };
const ISSUE = { createIssue: { issue: { id: 'I_9', url: 'https://github.com/acme/app/issues/9' } } };
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
  assert.equal(await source.create?.({ title: 'Fix login', body: 'steps', column: 'Ready' }), 'PVTI_9');
  assert.deepEqual(calls.slice(1).map((c) => [c.name, c.variables]), [
    ['repositoryId', { owner: 'acme', name: 'app' }],
    ['createIssue', { repositoryId: 'R_app', title: 'Fix login', body: 'steps' }],
    ['addProjectItem', { projectId: 'PVT_1', contentId: 'I_9' }],
    ['setOption', { projectId: 'PVT_1', itemId: 'PVTI_9', fieldId: 'F_status', singleSelectOptionId: 'O_ready' }],
  ]);
  await source.create?.({ title: 'Again', column: 'Ready' });
  assert.equal(calls.filter((c) => c.name === 'repositoryId').length, 1, 'cached per source');
});

test('create refuses a source without a repository and a column the Status lacks, before any write (#846)', async () => {
  const { gql, calls } = fakeGql({ fields });
  const bare = createSource(specWith(), { gql });
  await bare.resolveFields();
  await assert.rejects(bare.create!({ title: 'x', column: 'Ready' }), { message: 'source has no repository for new issues' });
  const placed = createSource(specWith({ repository: 'acme/app' }), { gql });
  await placed.resolveFields();
  await assert.rejects(placed.create!({ title: 'x', column: 'Done' }), /"Done" is not a Status option/);
  assert.deepEqual(calls.map((c) => c.name), ['fields', 'fields']);
});

test('a failure after the issue exists names the issue\'s url (#846)', async () => {
  const { gql } = fakeGql({ fields, repositoryId: { repository: { id: 'R_app' } }, createIssue: ISSUE }); // addProjectItem unanswered: the fake throws
  const source = createSource(specWith({ repository: 'acme/app' }), { gql });
  await source.resolveFields();
  await assert.rejects(source.create!({ title: 'x', column: 'Ready' }), {
    message: 'issue https://github.com/acme/app/issues/9 was created but not placed on the Project: unexpected graphql call: addProjectItem',
  });
});

test('namespaced create answers the item under its source\'s name (#846)', async () => {
  const adapter = { ...fakeSourceFactory().factory(specWith()), create: async () => 'PVTI_9' };
  assert.equal(await namespaced(GITHUB_ENTRY, adapter).create?.({ title: 'x', column: 'Ready' }), 'board:PVTI_9');
});

test('listFilterOptions answers the Project\'s linked repositories (#846)', async () => {
  const { gql } = fakeGql({
    items: { repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
    selectFields: { repositoryOwner: { projectV2: { fields: { nodes: [] }, repositories: { nodes: [{ nameWithOwner: 'acme/app' }, { nameWithOwner: 'acme/site' }] } } } },
  });
  assert.deepEqual((await listFilterOptions('acme', 6, gql)).linkedRepositories, ['acme/app', 'acme/site']);
});
