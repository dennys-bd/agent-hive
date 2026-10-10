import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_BLOCKED_BY, ADD_PROJECT_ITEM, ADD_SUB_ISSUE, CREATE_ISSUE, ISSUE_ID, REPOSITORY_ID, SET_OPTION } from '../src/sources/github-queries.js';
import { writeDecomposition, type WriteTarget } from '../src/decomposition-write.js';
import { designComment, issueBody, parseDecomposition, rootBody } from '../src/decomposition.js';
import { ADD_COMMENT } from '../src/repos/github-repo-queries.js';
import type { Decomposition } from '../src/types.js';
import { fakeGqlJson } from './fakes.js';
import { EXAMPLE } from './fixtures/decomposition.js';


// A decomposition's write to GitHub (#865): its GraphQL, then writeDecomposition over a fake GitHub (Task 3).

test('the write\'s GraphQL takes every value as a variable: no text, id or number is built into a query (#865)', () => {
  assert.match(REPOSITORY_ID, /repository\(owner: \$owner, name: \$name\) \{ id \}/);
  assert.match(CREATE_ISSUE, /createIssue\(input: \{ repositoryId: \$repositoryId, title: \$title, body: \$body \}\) \{ issue \{ id number url \} \}/);
  assert.match(ADD_PROJECT_ITEM, /addProjectV2ItemById\(input: \{ projectId: \$projectId, contentId: \$contentId \}\) \{ item \{ id \} \}/);
  assert.match(ADD_SUB_ISSUE, /addSubIssue\(input: \{ issueId: \$issueId, subIssueId: \$subIssueId \}\)/);
  assert.match(ADD_BLOCKED_BY, /addBlockedBy\(input: \{ issueId: \$issueId, blockingIssueId: \$blockingIssueId \}\)/);
});

const NAMES = new Map<string, string>([
  [REPOSITORY_ID, 'repo'], [ISSUE_ID, 'issueId'], [ADD_COMMENT, 'comment'], [CREATE_ISSUE, 'create'], [ADD_PROJECT_ITEM, 'project'],
  [SET_OPTION, 'status'], [ADD_SUB_ISSUE, 'sub'], [ADD_BLOCKED_BY, 'blocked'],
]);
const PROJECT = { projectId: 'PV1', fieldId: 'F1', optionId: 'o2' };
const GITHUB_GOAL: WriteTarget = { repository: 'acme/site', goal: 7, project: PROJECT };
const LOCAL_GOAL: WriteTarget = { repository: 'acme/site', project: PROJECT };

function example(): Decomposition {
  const { decomposition } = parseDecomposition(EXAMPLE);
  assert.ok(decomposition);
  return decomposition;
}

// GitHub as the writer meets it: each new issue numbered from `first`, node ids I<number>, project items PI<node id>; `fail` names the
// error one call answers
function github(first = 101, fail?: (query: string, variables: Record<string, unknown>) => string | undefined) {
  let number = first - 1;
  return fakeGqlJson((query, variables) => {
    const message = fail?.(query, variables);
    if (message !== undefined) throw new Error(message);
    if (query === REPOSITORY_ID) return { repository: { id: 'R1' } };
    if (query === ISSUE_ID) return { repository: { issue: { id: `I${String(variables.number)}` } } };
    if (query === CREATE_ISSUE) {
      number += 1;
      return { createIssue: { issue: { id: `I${number}`, number } } };
    }
    if (query === ADD_PROJECT_ITEM) return { addProjectV2ItemById: { item: { id: `P${String(variables.contentId)}` } } };
    return {};
  });
}
const steps = (calls: { query: string }[]): string[] => calls.map((c) => NAMES.get(c.query) ?? '?');
const varsOf = (calls: { query: string; variables: Record<string, unknown> }[], name: string): Record<string, unknown>[] =>
  calls.filter((c) => NAMES.get(c.query) === name).map((c) => c.variables);
function recorder(): { recorded: [string, number][]; record(id: string, number: number): Promise<void> } {
  const recorded: [string, number][] = [];
  return { recorded, record: async (id, number) => { recorded.push([id, number]); } };
}

test('a GitHub goal: its design as a comment, then every issue, its project item and Status, the sub-issues in file order, then the blockers; each step recorded as it is done (#865)', async () => {
  const { calls, gql } = github();
  const { recorded, record } = recorder();
  const d = example();
  assert.equal(await writeDecomposition({ gql, record }, d, GITHUB_GOAL, {}), undefined);
  assert.deepEqual(steps(calls), [
    'issueId', 'comment', 'repo', ...Array<string>(6).fill('create'), ...Array.from({ length: 6 }, () => ['project', 'status']).flat(),
    ...Array<string>(6).fill('sub'), ...Array<string>(3).fill('blocked'),
  ]);
  assert.deepEqual(recorded, [['design', 7], ['1', 101], ['1.1', 102], ['1.2', 103], ['2', 104], ['2.1', 105], ['2.2', 106], ['done', 7]]);
  assert.deepEqual(varsOf(calls, 'issueId'), [{ owner: 'acme', name: 'site', number: 7 }]);
  assert.deepEqual(varsOf(calls, 'comment'), [{ id: 'I7', body: designComment(d) }]);
  assert.deepEqual(varsOf(calls, 'create')[2], { repositoryId: 'R1', title: 'Contact API', body: issueBody(d.nodes[2]) });
  assert.deepEqual(varsOf(calls, 'project')[0], { projectId: 'PV1', contentId: 'I101' });
  assert.deepEqual(varsOf(calls, 'status')[0], { projectId: 'PV1', itemId: 'PI101', fieldId: 'F1', singleSelectOptionId: 'o2' });
  assert.deepEqual(varsOf(calls, 'sub'), [['I7', 'I101'], ['I101', 'I102'], ['I101', 'I103'], ['I7', 'I104'], ['I104', 'I105'], ['I104', 'I106']].map(([issueId, subIssueId]) => ({ issueId, subIssueId })));
  assert.deepEqual(varsOf(calls, 'blocked'), [['I103', 'I102'], ['I104', 'I101'], ['I105', 'I103']].map(([issueId, blockingIssueId]) => ({ issueId, blockingIssueId })));
});

test('a local goal: a root issue with the goal\'s text and design holds the top-level issues and goes into the project too; no comment (#865)', async () => {
  const { calls, gql } = github(100);
  const { recorded, record } = recorder();
  const d = example();
  assert.equal(await writeDecomposition({ gql, record }, d, LOCAL_GOAL, {}), undefined);
  assert.deepEqual([recorded[0], recorded.at(-1)], [['root', 100], ['done', 100]]);
  assert.deepEqual(varsOf(calls, 'create')[0], { repositoryId: 'R1', title: 'Site for XPTO', body: rootBody(d) });
  assert.equal(varsOf(calls, 'project').length, 7);
  assert.deepEqual(varsOf(calls, 'sub').filter((v) => v.issueId === 'I100').map((v) => v.subIssueId), ['I101', 'I104']);
  assert.equal(steps(calls).includes('comment'), false);
});

test('a retry skips the recorded keys, resolves their numbers again and replays every link (#865)', async () => {
  const { calls, gql } = github(201);
  const { recorded, record } = recorder();
  assert.equal(await writeDecomposition({ gql, record }, example(), GITHUB_GOAL, { design: 7, '1': 101, '1.1': 102 }), undefined);
  assert.deepEqual(recorded.map(([id]) => id), ['1.2', '2', '2.1', '2.2', 'done']);
  assert.deepEqual(varsOf(calls, 'issueId').map((v) => v.number), [7, 101, 102]);
  assert.deepEqual([steps(calls).filter((s) => s === 'create').length, steps(calls).filter((s) => s === 'sub').length, steps(calls).includes('comment')], [4, 6, false]);
});

test('a sub-issue or a blocker GitHub already holds counts as done (#865)', async () => {
  const already = (query: string): string | undefined => {
    if (query === ADD_SUB_ISSUE) return 'Issue may not contain duplicate sub-issues';
    return query === ADD_BLOCKED_BY ? 'The issue is already blocked by this issue' : undefined;
  };
  const { gql } = github(101, already);
  const { recorded, record } = recorder();
  assert.equal(await writeDecomposition({ gql, record }, example(), GITHUB_GOAL, {}), undefined);
  assert.deepEqual(recorded.at(-1), ['done', 7]);
});

test('the first other error stops the write with GitHub\'s message; what was done stays recorded (#865)', async () => {
  const { calls, gql } = github(101, (query, variables) => (query === CREATE_ISSUE && variables.title === 'Submissions table' ? 'was submitted too quickly' : undefined));
  const { recorded, record } = recorder();
  assert.equal(await writeDecomposition({ gql, record }, example(), GITHUB_GOAL, {}), 'was submitted too quickly');
  assert.deepEqual(recorded, [['design', 7], ['1', 101]]);
  assert.equal(steps(calls).includes('sub'), false);
});
