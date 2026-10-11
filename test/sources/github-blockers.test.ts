import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadBlockerRefError, BlockerRefNotFoundError, relateItem, RelationRereadError, SelfBlockerError } from '../../src/sources/github-blockers.js';
import type { FieldsContext } from '../../src/sources/github-fields.js';
import { ADD_BLOCKED_BY, ISSUE_ID, ITEM_FIELDS, REMOVE_BLOCKED_BY, type GhItemFieldsNode } from '../../src/sources/github-queries.js';
import { parseConfig } from '../../src/config.js';
import { createSource, sourceSpec } from '../../src/source.js';
import type { BlockerChange, Gql, SourceItem } from '../../src/types.js';
import { combConfig, FILTER, FIXED } from '../fakes.js';

// Issue acme/site#12 on project PVT_1, as ITEM_FIELDS answers it: what relateItem reads first and re-reads after (#56)
const NODE: GhItemFieldsNode = {
  id: 'PVTI_1', project: { id: 'PVT_1', fields: { nodes: [] } }, fieldValueByName: { name: 'Ready' },
  content: { __typename: 'Issue', id: 'I_12', number: 12, title: 'Pager', body: '', url: 'https://github.com/acme/site/issues/12', repository: { nameWithOwner: 'acme/site' } },
};
// What ISSUE_ID resolves, by owner/name#number; anything else is no issue
const ISSUES: Record<string, string> = { 'acme/site#7': 'I_7', 'acme/site#12': 'I_12', 'other/lib#3': 'I_L3' };
const ref = (number: number, state: string, repo = 'acme/site') => ({ number, title: `T${number}`, state, repository: { nameWithOwner: repo } });
type Ref = ReturnType<typeof ref>;
const rels = (blockedBy: Ref[] = [], blocking: Ref[] = []) =>
  ({ i0: { issue: { blockedBy: { nodes: blockedBy }, blocking: { nodes: blocking }, subIssues: { nodes: [] } } } });
const ENTRY: SourceItem = { item: { itemId: 'PVTI_1', id: '12', title: 'Pager', body: '', url: 'https://github.com/acme/site/issues/12' }, column: 'Ready' };
const READ = { login: 'acme', number: 6, notFound: 'source not found', filter: [], me: undefined, epics: 'ignore' as const, taskProps: FIXED };
const SEVEN = { blockedBy: [{ id: '7', title: 'T7', state: 'open' }], blocking: [] };

interface Call { query: string; variables?: Record<string, string | number | boolean> }
// A Gql over the item's read, ISSUE_ID and the relations query (its answers in order: before the write, then after); a mutation answers {}
function blockerGql(relations: unknown[]): { gql: Gql; calls: Call[] } {
  const queue = [...relations];
  const calls: Call[] = [];
  const gql: Gql = async (query, variables) => {
    calls.push({ query, variables });
    if (query === ITEM_FIELDS) return { node: NODE };
    if (query === ISSUE_ID) {
      const id = ISSUES[`${String(variables?.owner)}/${String(variables?.name)}#${String(variables?.number)}`];
      return { repository: { issue: id === undefined ? null : { id } } };
    }
    if (query.includes('blocking(')) return queue.shift();
    return {};
  };
  return { gql, calls };
}
const ctxOf = (gql: Gql, entry: FieldsContext['entry'] = async () => ENTRY): FieldsContext => ({ gql, projectId: 'PVT_1', read: READ, entry });
const mutations = (calls: Call[]): Call[] => calls.filter((c) => c.query === ADD_BLOCKED_BY || c.query === REMOVE_BLOCKED_BY);
const change = (action: BlockerChange['action'], kind: BlockerChange['kind'], r: string): BlockerChange => ({ action, kind, ref: r });

test('relateItem adds a blocked-by with this issue as issueId, 7, #7 and acme/site#7 resolving to the same ISSUE_ID, and answers the re-read relations and entry (#56)', async () => {
  for (const r of ['7', '#7', 'acme/site#7']) {
    const { gql, calls } = blockerGql([rels(), rels([ref(7, 'OPEN')])]);
    const written = await relateItem(ctxOf(gql), 'PVTI_1', change('add', 'blockedBy', r));
    assert.deepEqual(calls.find((c) => c.query === ISSUE_ID)?.variables, { owner: 'acme', name: 'site', number: 7 }, r);
    assert.deepEqual(mutations(calls), [{ query: ADD_BLOCKED_BY, variables: { issueId: 'I_12', blockingIssueId: 'I_7' } }], r);
    assert.deepEqual(written, { blockers: SEVEN, entry: ENTRY }, r);
  }
});

test('relateItem with blocking swaps the sides: the other issue is the one blocked (#56)', async () => {
  const { gql, calls } = blockerGql([rels(), rels([], [ref(7, 'OPEN')])]);
  const written = await relateItem(ctxOf(gql), 'PVTI_1', change('add', 'blocking', '7'));
  assert.deepEqual(mutations(calls), [{ query: ADD_BLOCKED_BY, variables: { issueId: 'I_7', blockingIssueId: 'I_12' } }]);
  assert.deepEqual(written.blockers.blocking, [{ id: '7', title: 'T7', state: 'open' }]);
});

test('relateItem removes with REMOVE_BLOCKED_BY, a blocker of another repository named owner/repo#n (#56)', async () => {
  const { gql, calls } = blockerGql([rels([ref(3, 'CLOSED', 'other/lib')]), rels()]);
  const written = await relateItem(ctxOf(gql), 'PVTI_1', change('remove', 'blockedBy', 'other/lib#3'));
  assert.deepEqual(calls.find((c) => c.query === ISSUE_ID)?.variables, { owner: 'other', name: 'lib', number: 3 });
  assert.deepEqual(mutations(calls), [{ query: REMOVE_BLOCKED_BY, variables: { issueId: 'I_12', blockingIssueId: 'I_L3' } }]);
  assert.deepEqual(written.blockers, { blockedBy: [], blocking: [] });
});

test('relateItem sends nothing for a relation already as asked, an add that exists or a remove of none, and answers the relations it read (#56)', async () => {
  const added = blockerGql([rels([ref(7, 'OPEN')])]);
  assert.deepEqual(await relateItem(ctxOf(added.gql), 'PVTI_1', change('add', 'blockedBy', '#7')), { blockers: SEVEN });
  const removed = blockerGql([rels()]);
  assert.deepEqual(await relateItem(ctxOf(removed.gql), 'PVTI_1', change('remove', 'blocking', '7')), { blockers: { blockedBy: [], blocking: [] } });
  assert.deepEqual([mutations(added.calls), mutations(removed.calls)], [[], []]);
});

test('relateItem refuses a bad ref, an issue that does not exist and the item itself, before any mutation (#56)', async () => {
  const { gql, calls } = blockerGql([]);
  await assert.rejects(relateItem(ctxOf(gql), 'PVTI_1', change('add', 'blockedBy', 'acme/site12')), BadBlockerRefError);
  await assert.rejects(relateItem(ctxOf(gql), 'PVTI_1', change('add', 'blockedBy', 'HIVE-3')), BadBlockerRefError);
  await assert.rejects(relateItem(ctxOf(gql), 'PVTI_1', change('add', 'blockedBy', '99')), BlockerRefNotFoundError);
  await assert.rejects(relateItem(ctxOf(gql), 'PVTI_1', change('add', 'blocking', '#12')), SelfBlockerError);
  assert.deepEqual(mutations(calls), []);
});

test('relateItem whose re-read fails after the write rejects with a RelationRereadError carrying the relations it read (#56)', async () => {
  const { gql, calls } = blockerGql([rels(), rels([ref(7, 'OPEN')])]);
  const broken = ctxOf(gql, async () => { throw new Error('timeout'); });
  await assert.rejects(relateItem(broken, 'PVTI_1', change('add', 'blockedBy', '7')), (err: unknown) => {
    assert.ok(err instanceof RelationRereadError);
    assert.deepEqual([err.message, err.blockers], ['timeout', SEVEN]);
    return true;
  });
  assert.equal(mutations(calls).length, 1, 'the write landed');
});

test('the GitHub adapter has relate, refused before resolveFields like setField (#56)', async () => {
  const config = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter: FILTER } }));
  const source = createSource(sourceSpec(config, config.comb.sources[0]), { gql: blockerGql([]).gql });
  assert.ok(source.relate);
  await assert.rejects(source.relate('PVTI_1', change('add', 'blockedBy', '7')), /source not resolved/);
});
