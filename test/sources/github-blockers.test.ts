import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadBlockerRefError, BlockerRefNotFoundError, findBlockers, relateItem, RelationRereadError, SelfBlockerError } from '../../src/sources/github-blockers.js';
import type { FieldsContext } from '../../src/sources/github-fields.js';
import { ADD_BLOCKED_BY, ISSUE_ID, ITEM_FIELDS, relationsQuery, REMOVE_BLOCKED_BY, SEARCH_ISSUES, type GhItemFieldsNode } from '../../src/sources/github-queries.js';
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

test('relateItem maps GitHub\'s "Could not resolve" errors array to BlockerRefNotFoundError, and lets any other failure through (#56)', async () => {
  const failing = (message: string): Gql => async (query, variables) => {
    if (query === ISSUE_ID) throw new Error(message);
    return blockerGql([]).gql(query, variables);
  };
  await assert.rejects(relateItem(ctxOf(failing("Could not resolve to an Issue with the number of 99.")), 'PVTI_1', change('add', 'blockedBy', '99')), BlockerRefNotFoundError);
  await assert.rejects(relateItem(ctxOf(failing("Could not resolve to a Repository with the name 'nope/x'.")), 'PVTI_1', change('add', 'blockedBy', 'nope/x#1')), BlockerRefNotFoundError);
  await assert.rejects(relateItem(ctxOf(failing('API rate limit exceeded')), 'PVTI_1', change('add', 'blockedBy', '7')), (err: unknown) => !(err instanceof BlockerRefNotFoundError));
});

test('relateItem whose relations re-read fails after the write carries no relations, not empty ones (#56)', async () => {
  const { gql } = blockerGql([rels()]); // the relations queue answers once, before the write; after it, the query throws
  const broken: Gql = async (query, variables) => {
    const answer = await gql(query, variables);
    if (answer === undefined) throw new Error('timeout');
    return answer;
  };
  await assert.rejects(relateItem(ctxOf(broken), 'PVTI_1', change('add', 'blockedBy', '7')), (err: unknown) => err instanceof RelationRereadError && err.blockers === undefined);
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

test('findBlockers searches the item\'s repository by title with the whole query as the q variable, maps the issues to refs with their states and caps at 8 (#57)', async () => {
  const calls: Call[] = [];
  const issues = Array.from({ length: 10 }, (_, i) => ref(20 + i, i === 0 ? 'CLOSED' : 'OPEN'));
  const gql: Gql = async (query, variables) => {
    calls.push({ query, variables });
    if (query === ITEM_FIELDS) return { node: NODE };
    if (query === SEARCH_ISSUES) return { search: { nodes: [{}, ref(3, 'OPEN', 'other/lib'), ...issues] } }; // {}: a node that is no issue
    return {};
  };
  const found = await findBlockers(ctxOf(gql), 'PVTI_1', 'pager "v2"');
  assert.deepEqual(calls.find((c) => c.query === SEARCH_ISSUES)?.variables, { q: 'repo:acme/site is:issue in:title pager "v2"' });
  assert.equal(SEARCH_ISSUES.includes('$q'), true, 'the text travels as a variable');
  assert.equal(found.length, 8);
  assert.deepEqual(found.slice(0, 3), [
    { id: 'other/lib#3', title: 'T3', state: 'open' }, { id: '20', title: 'T20', state: 'closed' }, { id: '21', title: 'T21', state: 'open' },
  ]);
});

test('the GitHub adapter has relate and findBlockers, both refused before resolveFields like setField (#56, #57)', async () => {
  const config = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter: FILTER } }));
  const source = createSource(sourceSpec(config, config.comb.sources[0]), { gql: blockerGql([]).gql });
  assert.ok(source.relate);
  assert.ok(source.findBlockers);
  await assert.rejects(source.relate('PVTI_1', change('add', 'blockedBy', '7')), /source not resolved/);
  await assert.rejects(source.findBlockers('PVTI_1', 'pager'), /source not resolved/);
});

test('the poll\'s relations query asks blocking alone; a relation write\'s read asks both directions (#282)', () => {
  const item = { itemId: 'PVTI_1', id: '12', title: '', body: '', url: 'https://github.com/acme/site/issues/12' };
  assert.doesNotMatch(relationsQuery([item]) ?? '', /blockedBy|subIssues/);
  assert.match(relationsQuery([item], ['blockedBy', 'blocking']) ?? '', /blockedBy\(first: 50\) .* blocking\(first: 50\)/);
});
