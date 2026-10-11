import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_BLOCKED_BY, ADD_PROJECT_ITEM, ADD_SUB_ISSUE, CREATE_ISSUE, CREATE_LABEL, ISSUE_ID, REPOSITORY_BRANCH, REPOSITORY_LABEL, SET_OPTION,
} from '../src/sources/github-queries.js';
import { readRepository, writeDecomposition, type WriteTarget } from '../src/decomposition-write.js';
import { designComment, issueBody, parseDecomposition, rootBody } from '../src/decomposition.js';
import { ADD_COMMENT } from '../src/repos/github-repo-queries.js';
import type { Decomposition } from '../src/types.js';
import { fakeGqlJson } from './fakes.js';
import { EXAMPLE } from './fixtures/decomposition.js';

// A decomposition's write to GitHub (#865, #936): its GraphQL, then writeDecomposition over a fake GitHub.

test('the write\'s GraphQL takes every value as a variable: no text, id or number is built into a query (#865, #936)', () => {
  assert.match(REPOSITORY_BRANCH, /repository\(owner: \$owner, name: \$name\) \{ id defaultBranchRef \{ name \} \}/);
  assert.match(CREATE_ISSUE, /createIssue\(input: \{ repositoryId: \$repositoryId, title: \$title, body: \$body, labelIds: \$labelIds \}\) \{ issue \{ id number url \} \}/);
  assert.match(REPOSITORY_LABEL, /repository\(owner: \$owner, name: \$name\) \{ label\(name: \$label\) \{ id \} \}/);
  assert.match(CREATE_LABEL, /createLabel\(input: \{ repositoryId: \$repositoryId, name: \$name, color: \$color \}\) \{ label \{ id \} \}/);
  assert.match(ADD_PROJECT_ITEM, /addProjectV2ItemById\(input: \{ projectId: \$projectId, contentId: \$contentId \}\) \{ item \{ id \} \}/);
  assert.match(ADD_SUB_ISSUE, /addSubIssue\(input: \{ issueId: \$issueId, subIssueId: \$subIssueId \}\)/);
  assert.match(ADD_BLOCKED_BY, /addBlockedBy\(input: \{ issueId: \$issueId, blockingIssueId: \$blockingIssueId \}\)/);
});

const NAMES = new Map<string, string>([
  [ISSUE_ID, 'issueId'], [ADD_COMMENT, 'comment'], [CREATE_ISSUE, 'create'], [ADD_PROJECT_ITEM, 'project'], [SET_OPTION, 'status'],
  [ADD_SUB_ISSUE, 'sub'], [ADD_BLOCKED_BY, 'blocked'], [REPOSITORY_LABEL, 'label'], [CREATE_LABEL, 'createLabel'],
]);
const PROJECT = { projectId: 'PV1', fieldId: 'F1', optionId: 'o2' };
// the issues in acme/site, the file in a separate docs repository
const ADDRESS = 'https://github.com/acme/docs/blob/main/agent/specs/2026-10-11-site-decomposition.md';
const GITHUB_GOAL: WriteTarget = { repository: 'acme/site', repositoryId: 'R1', address: ADDRESS, goal: 7, project: PROJECT };
const LOCAL_GOAL: WriteTarget = { repository: 'acme/site', repositoryId: 'R1', address: ADDRESS, project: PROJECT };
const LABELLED = EXAMPLE.replace('# Site for XPTO\n', '# Site for XPTO\nLabel: decomposed\n');

function example(text = EXAMPLE): Decomposition {
  const { decomposition } = parseDecomposition(text);
  assert.ok(decomposition);
  return decomposition;
}

// GitHub as the writer meets it: each new issue numbered from `first`, node ids I<number>, project items PI<node id>; `fail` names the
// error one call answers; `hasLabel` whether the repository already has the label
function github(first = 101, fail?: (query: string, variables: Record<string, unknown>) => string | undefined, hasLabel = true) {
  let number = first - 1;
  return fakeGqlJson((query, variables) => {
    const message = fail?.(query, variables);
    if (message !== undefined) throw new Error(message);
    if (query === REPOSITORY_LABEL) return { repository: { label: hasLabel ? { id: 'L1' } : null } };
    if (query === CREATE_LABEL) return { createLabel: { label: { id: 'L2' } } };
    if (query === ISSUE_ID) return { repository: { issue: { id: `I${String(variables.number)}` } } };
    if (query === CREATE_ISSUE) {
      number += 1;
      return { createIssue: { issue: { id: `I${number}`, number } } };
    }
    if (query === ADD_PROJECT_ITEM) return { addProjectV2ItemById: { item: { id: `P${String(variables.contentId)}` } } };
    return {};
  });
}
type Call = { query: string; variables: Record<string, unknown> };
const steps = (calls: { query: string }[]): string[] => calls.map((c) => NAMES.get(c.query) ?? '?');
const varsOf = (calls: Call[], name: string): Record<string, unknown>[] => calls.filter((c) => NAMES.get(c.query) === name).map((c) => c.variables);
// The `Parent: #<n>` of each created issue's body, '' for one with none (a local goal's root)
const parentsOf = (calls: Call[]): string[] => varsOf(calls, 'create').map((v) => /^Parent: #(\d+)$/m.exec(String(v.body))?.[1] ?? '');
function recorder(): { recorded: [string, number][]; record(id: string, number: number): Promise<void> } {
  const recorded: [string, number][] = [];
  return { recorded, record: async (id, number) => { recorded.push([id, number]); } };
}

test('readRepository answers the node id and the default branch; a repository with none is an error (#936)', async () => {
  const { gql, calls } = fakeGqlJson(() => ({ repository: { id: 'R1', defaultBranchRef: { name: 'main' } } }));
  assert.deepEqual(await readRepository(gql, 'acme/site'), { id: 'R1', defaultBranch: 'main' });
  assert.deepEqual(calls, [{ query: REPOSITORY_BRANCH, variables: { owner: 'acme', name: 'site' } }]);
  const empty = fakeGqlJson(() => ({ repository: { id: 'R1', defaultBranchRef: null } }));
  await assert.rejects(readRepository(empty.gql, 'acme/site'), /acme\/site has no default branch/);
});

test('a GitHub goal: its design as a comment, then every issue in file order with its parent\'s number and Design: link, its project item and Status, the sub-issues, then the blockers; each step recorded as it is done (#865, #936)', async () => {
  const { calls, gql } = github();
  const { recorded, record } = recorder();
  const d = example();
  assert.deepEqual(await writeDecomposition({ gql, record }, d, GITHUB_GOAL, {}), { root: 7 });
  assert.deepEqual(steps(calls), [
    'issueId', 'comment', ...Array<string>(6).fill('create'), ...Array.from({ length: 6 }, () => ['project', 'status']).flat(),
    ...Array<string>(6).fill('sub'), ...Array<string>(3).fill('blocked'),
  ]);
  assert.deepEqual(recorded, [['design', 7], ['1', 101], ['1.1', 102], ['1.2', 103], ['2', 104], ['2.1', 105], ['2.2', 106]], 'done is the route\'s');
  assert.deepEqual(varsOf(calls, 'issueId'), [{ owner: 'acme', name: 'site', number: 7 }]);
  assert.deepEqual(varsOf(calls, 'comment'), [{ id: 'I7', body: designComment(d) }]);
  assert.deepEqual(varsOf(calls, 'create')[2], { repositoryId: 'R1', title: 'Contact API', body: issueBody(d.nodes[2], { parent: 101, design: `${ADDRESS}#1-backend` }), labelIds: [] });
  assert.deepEqual(parentsOf(calls), ['7', '101', '101', '7', '104', '104']);
  assert.deepEqual(varsOf(calls, 'project')[0], { projectId: 'PV1', contentId: 'I101' });
  assert.deepEqual(varsOf(calls, 'status')[0], { projectId: 'PV1', itemId: 'PI101', fieldId: 'F1', singleSelectOptionId: 'o2' });
  assert.deepEqual(varsOf(calls, 'sub'), [['I7', 'I101'], ['I101', 'I102'], ['I101', 'I103'], ['I7', 'I104'], ['I104', 'I105'], ['I104', 'I106']].map(([issueId, subIssueId]) => ({ issueId, subIssueId })));
  assert.deepEqual(varsOf(calls, 'blocked'), [['I103', 'I102'], ['I104', 'I101'], ['I105', 'I103']].map(([issueId, blockingIssueId]) => ({ issueId, blockingIssueId })));
});

test('a local goal: a root issue with the goal\'s text and design holds the top-level issues, whose Parent: is its number, and goes into the project too; no comment (#865, #936)', async () => {
  const { calls, gql } = github(100);
  const { recorded, record } = recorder();
  const d = example();
  assert.deepEqual(await writeDecomposition({ gql, record }, d, LOCAL_GOAL, {}), { root: 100 });
  assert.deepEqual([recorded[0], recorded.at(-1)], [['root', 100], ['2.2', 106]]);
  assert.deepEqual(varsOf(calls, 'create')[0], { repositoryId: 'R1', title: 'Site for XPTO', body: rootBody(d), labelIds: [] });
  assert.deepEqual(parentsOf(calls), ['', '100', '101', '101', '100', '104', '104']);
  assert.equal(varsOf(calls, 'project').length, 7);
  assert.deepEqual(varsOf(calls, 'sub').filter((v) => v.issueId === 'I100').map((v) => v.subIssueId), ['I101', 'I104']);
  assert.equal(steps(calls).includes('comment'), false);
});

test('the file\'s label, found in the repository, goes on every issue created, a local goal\'s root included; asked once (#936)', async () => {
  const { calls, gql } = github(100);
  assert.deepEqual(await writeDecomposition({ gql, record: recorder().record }, example(LABELLED), LOCAL_GOAL, {}), { root: 100 });
  assert.deepEqual(varsOf(calls, 'label'), [{ owner: 'acme', name: 'site', label: 'decomposed' }]);
  assert.equal(steps(calls).includes('createLabel'), false);
  assert.deepEqual(varsOf(calls, 'create').map((v) => v.labelIds), Array<string[]>(7).fill(['L1']));
});

test('a label the repository lacks is created once, grey; no Label: line sends no label (#936)', async () => {
  const missing = github(101, undefined, false);
  assert.deepEqual(await writeDecomposition({ gql: missing.gql, record: recorder().record }, example(LABELLED), GITHUB_GOAL, {}), { root: 7 });
  assert.deepEqual(varsOf(missing.calls, 'createLabel'), [{ repositoryId: 'R1', name: 'decomposed', color: 'ededed' }]);
  assert.deepEqual(varsOf(missing.calls, 'create').map((v) => v.labelIds), Array<string[]>(6).fill(['L2']));
  const none = github();
  assert.deepEqual(await writeDecomposition({ gql: none.gql, record: recorder().record }, example(), GITHUB_GOAL, {}), { root: 7 });
  assert.equal(steps(none.calls).includes('label'), false);
  assert.deepEqual(varsOf(none.calls, 'create').map((v) => v.labelIds), Array<string[]>(6).fill([]));
});

test('a retry skips the recorded keys, resolves their numbers again for the bodies\' Parent: and replays every link (#865, #936)', async () => {
  const { calls, gql } = github(201);
  const { recorded, record } = recorder();
  assert.deepEqual(await writeDecomposition({ gql, record }, example(), GITHUB_GOAL, { design: 7, '1': 101, '1.1': 102 }), { root: 7 });
  assert.deepEqual(recorded.map(([id]) => id), ['1.2', '2', '2.1', '2.2']);
  assert.deepEqual(varsOf(calls, 'issueId').map((v) => v.number), [7, 101, 102]);
  assert.deepEqual(parentsOf(calls), ['101', '7', '202', '202']);
  assert.deepEqual([steps(calls).filter((s) => s === 'create').length, steps(calls).filter((s) => s === 'sub').length, steps(calls).includes('comment')], [4, 6, false]);
});

test('a sub-issue or a blocker GitHub already holds counts as done (#865)', async () => {
  const already = (query: string): string | undefined => {
    if (query === ADD_SUB_ISSUE) return 'Issue may not contain duplicate sub-issues';
    return query === ADD_BLOCKED_BY ? 'The issue is already blocked by this issue' : undefined;
  };
  const { gql } = github(101, already);
  assert.deepEqual(await writeDecomposition({ gql, record: recorder().record }, example(), GITHUB_GOAL, {}), { root: 7 });
});

test('the first other error stops the write with GitHub\'s message; what was done stays recorded (#865)', async () => {
  const { calls, gql } = github(101, (query, variables) => (query === CREATE_ISSUE && variables.title === 'Submissions table' ? 'was submitted too quickly' : undefined));
  const { recorded, record } = recorder();
  assert.deepEqual(await writeDecomposition({ gql, record }, example(), GITHUB_GOAL, {}), { error: 'was submitted too quickly' });
  assert.deepEqual(recorded, [['design', 7], ['1', 101]]);
  assert.equal(steps(calls).includes('sub'), false);
});
