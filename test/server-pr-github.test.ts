import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activityOf, prsOf } from '../src/activities.js';
import { COMMENT_MUTATION, EDIT_MUTATION, MERGE_MUTATION, REPLY_MUTATION, RESOLVE_MUTATION, REVIEW_MUTATION, UNRESOLVE_MUTATION } from '../src/pr-github.js';
import { type PrData, PR_BODY_MAX } from '../src/types.js';
import { fakeLog } from './fakes.js';
import { workId } from './fixtures/work.js';
import { ANCHOR, AT, fakeGh, type FakeGh, GQL_PR_7, HEAD, PR, PR2, PR3, PR_SOURCE, reviewFileOf, startPrs } from './pr-server.js';
import { send } from './review-server.js';
import { hiveFetch } from './secret-client.js';

// What reached gh's stdin (#592): the mutations, in order
const mutations = (gh: FakeGh): unknown[] => gh.calls.flatMap((c) => (c.input === undefined ? [] : [c.input]));
const OTHER_HEAD = 'b'.repeat(40);
const PATH = '/repositories/acme/app/pulls/7'; // task 1's, awaiting approval
const PATH2 = '/repositories/acme/app/pulls/9'; // task 2's
const LONE = '/repositories/acme/app/pulls/8'; // on no task

test('enviar publishes a one-comment review at the head the page showed; a stale head or a merged PR is 409 and sends nothing (#592)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const comment = { head: HEAD, anchor: ANCHOR, text: ' why?\u0007 ' };
  assert.equal((await send(base, 'POST', `${PATH}/comment`, comment)).status, 200);
  assert.deepEqual(mutations(gh), [{ query: REVIEW_MUTATION, variables: { pr: 'PR_1', head: HEAD, event: 'COMMENT', threads: [{ path: 'a.txt', line: 1, side: 'RIGHT', body: 'why?' }] } }]);
  const stale = await send(base, 'POST', `${PATH}/comment`, { ...comment, head: OTHER_HEAD });
  assert.deepEqual([stale.status, await stale.json()], [409, { error: 'o PR mudou desde a última leitura, atualize' }]);
  gh.pr = { ...gh.pr, state: 'MERGED' };
  const merged = await send(base, 'POST', `${PATH}/comment`, comment);
  assert.deepEqual([merged.status, await merged.json()], [409, { error: 'PR não está aberto' }]);
  assert.equal((await send(base, 'POST', `${PATH}/comment`, { ...comment, head: 'x' })).status, 400);
  assert.equal(mutations(gh).length, 1);
});

test('a review sends the stored drafts as threads with its event and summary, then clears them; a comment with neither is 409; a GitHub refusal keeps the drafts (#592, #758)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const nothing = await send(base, 'POST', `${PATH}/review`, { head: HEAD, event: 'comment', body: ' ' });
  assert.deepEqual([nothing.status, await nothing.json()], [409, { error: 'nothing to send: a comment review needs a summary or a draft' }]);
  await send(base, 'POST', `${PATH}/drafts`, { anchor: ANCHOR, text: 'later' });
  gh.failWith = 'Resource not accessible by integration';
  const refused = await send(base, 'POST', `${PATH}/review`, { head: HEAD, event: 'comment', body: 'overall' });
  assert.deepEqual([refused.status, await refused.json()], [502, { error: 'gh api graphql: Resource not accessible by integration' }]);
  assert.equal((await reviewFileOf(base)).drafts.length, 1, 'kept on a refusal');
  gh.failWith = undefined;
  assert.equal((await send(base, 'POST', `${PATH}/review`, { head: HEAD, event: 'request_changes', body: 'overall' })).status, 200);
  assert.deepEqual(mutations(gh).at(-1), {
    query: REVIEW_MUTATION, variables: { pr: 'PR_1', head: HEAD, event: 'REQUEST_CHANGES', body: 'overall', threads: [{ path: 'a.txt', line: 1, side: 'RIGHT', body: 'later' }] },
  });
  assert.deepEqual(await reviewFileOf(base), { reviewed: [], drafts: [] });
});

test('an approval needs no summary; approve and request changes on one\'s own PR are 400 before GitHub is asked; a bad event, head or summary is 400 (#758)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  assert.equal((await send(base, 'POST', `${PATH}/review`, { head: HEAD, event: 'approve' })).status, 200);
  assert.deepEqual(mutations(gh), [{ query: REVIEW_MUTATION, variables: { pr: 'PR_1', head: HEAD, event: 'APPROVE', threads: [] } }]);
  gh.pr = { ...gh.pr, author: { login: 'ana' } }; // the viewer's own PR
  for (const event of ['approve', 'request_changes']) {
    const own = await send(base, 'POST', `${PATH}/review`, { head: HEAD, event, body: 'x' });
    assert.deepEqual([own.status, await own.json()], [400, { error: 'o GitHub não deixa aprovar o próprio PR, nem pedir mudanças nele' }], event);
  }
  for (const body of [{ head: HEAD, event: 'APPROVE' }, { head: 'x', event: 'approve' }, { head: HEAD, event: 'comment', body: 'x'.repeat(PR_BODY_MAX + 1) }]) {
    assert.equal((await send(base, 'POST', `${PATH}/review`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(mutations(gh).length, 1);
});

test('a reply and a resolve go to GitHub at once, one call each, only on a conversation of the PR (#592)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  const threads = `${PATH}/threads`;
  assert.equal((await send(base, 'POST', `${threads}/T1/reply`, { text: 'done' })).status, 200);
  assert.equal((await send(base, 'POST', `${threads}/T1/resolve`, { resolved: true })).status, 200);
  assert.equal((await send(base, 'POST', `${threads}/T1/resolve`, { resolved: false })).status, 200);
  assert.deepEqual(mutations(gh), [
    { query: REPLY_MUTATION, variables: { thread: 'T1', body: 'done' } },
    { query: RESOLVE_MUTATION, variables: { thread: 'T1' } },
    { query: UNRESOLVE_MUTATION, variables: { thread: 'T1' } },
  ]);
  const unknown = await send(base, 'POST', `${threads}/T9/reply`, { text: 'x' });
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'conversa desconhecida' }]);
  assert.equal((await send(base, 'POST', `${threads}/T1/resolve`, { resolved: 'yes' })).status, 400);
  assert.equal((await send(base, 'POST', `${threads}/T1/reply`, { text: ' ' })).status, 400);
});

test('mergear on a task awaiting approval merges with the method at the head, marks the PR merged and approves: the task enters its next stage (#592)', async (t) => {
  const gh = fakeGh();
  const { base, server } = await startPrs(t, gh);
  assert.equal((await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD })).status, 200);
  assert.deepEqual(mutations(gh), [{ query: MERGE_MUTATION, variables: { pr: 'PR_1', head: HEAD, method: 'SQUASH' } }]);
  const task = server.getState()?.tasks.find((c) => c.item.itemId === 'local:1');
  assert.deepEqual([prsOf(server.getState()!, 'local:1'), activityOf(server.getState()!, 'local:1')?.approval, task?.stage], [[{ url: PR, state: 'merged' }], undefined, 'feito']);
});

test('mergear approves only when it merges the task\'s last open PR: the first of two keeps the task awaiting, the second approves it (#261)', async (t) => {
  const gh = fakeGh();
  const { base, server } = await startPrs(t, gh, undefined, { prs: [{ url: PR, state: 'open' }, { url: PR3, state: 'open' }] });
  const stageOf = (): unknown => server.getState()?.tasks.find((c) => c.item.itemId === 'local:1')?.stage;
  assert.equal((await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD })).status, 200);
  assert.deepEqual([activityOf(server.getState()!, 'local:1')?.approval !== undefined, stageOf()], [true, 'fila']);
  assert.equal((await send(base, 'POST', '/repositories/acme/app/pulls/10/merge', { method: 'squash', head: HEAD })).status, 200);
  assert.deepEqual([prsOf(server.getState()!, 'local:1').map((p) => p.state), stageOf()], [['merged', 'merged'], 'feito']);
});

test('mergear keeps the task awaiting while a PR on an earlier record of it is still open (#261)', async (t) => {
  const gh = fakeGh();
  const { base, server } = await startPrs(t, gh, undefined, { kept: [{ url: PR3, state: 'open' }] });
  assert.equal((await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD })).status, 200);
  assert.deepEqual([activityOf(server.getState()!, 'local:1')?.approval !== undefined, server.getState()?.tasks.find((c) => c.item.itemId === 'local:1')?.stage], [true, 'fila']);
});

test('mergear approves when the task\'s other PRs are closed: a PR closed without merging does not hold it back (#261)', async (t) => {
  const gh = fakeGh();
  const { base, server } = await startPrs(t, gh, undefined, { prs: [{ url: PR, state: 'open' }, { url: PR3, state: 'closed' }] });
  assert.equal((await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD })).status, 200);
  assert.equal(server.getState()?.tasks.find((c) => c.item.itemId === 'local:1')?.stage, 'feito');
});

test('mergear on a task not awaiting approval only marks the PR merged; a method the repository refuses is 400 and merges nothing (#592)', async (t) => {
  const gh = fakeGh();
  const { base, server } = await startPrs(t, gh);
  const refused = await send(base, 'POST', `${PATH2}/merge`, { method: 'rebase', head: HEAD });
  assert.deepEqual([refused.status, await refused.json()], [400, { error: 'método de merge não permitido neste repositório' }]);
  assert.equal(mutations(gh).length, 0);
  assert.equal((await send(base, 'POST', `${PATH2}/merge`, { method: 'merge', head: HEAD })).status, 200);
  const task = server.getState()?.tasks.find((c) => c.item.itemId === 'local:2');
  assert.deepEqual([prsOf(server.getState()!, 'local:2'), task?.stage], [[{ url: PR2, state: 'merged' }], 'fila']);
});

test('mergear on a PR without a task merges and dispatches nothing: no record, no task changes (#758)', async (t) => {
  const gh = fakeGh();
  const { base, server } = await startPrs(t, gh);
  const before = JSON.stringify([server.getState()?.activityRecords, server.getState()?.tasks]);
  assert.equal((await send(base, 'POST', `${LONE}/merge`, { method: 'squash', head: HEAD })).status, 200);
  assert.deepEqual(mutations(gh), [{ query: MERGE_MUTATION, variables: { pr: 'PR_1', head: HEAD, method: 'SQUASH' } }]);
  assert.equal(JSON.stringify([server.getState()?.activityRecords, server.getState()?.tasks]), before);
});

test('a draft added while the review is out stays for the next one (#592, #758)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  await send(base, 'POST', `${PATH}/drafts`, { anchor: ANCHOR, text: 'first' });
  gh.onMutation = async () => { await send(base, 'POST', `${PATH}/drafts`, { anchor: ANCHOR, text: 'meanwhile' }); };
  assert.equal((await send(base, 'POST', `${PATH}/review`, { head: HEAD, event: 'comment', body: '' })).status, 200);
  assert.deepEqual((await reviewFileOf(base)).drafts.map((d) => d.text), ['meanwhile']);
});

test('mergear does not approve a task whose approval went while the merge was out (#592)', async (t) => {
  const gh = fakeGh();
  const { log, lines } = fakeLog();
  const { base, server } = await startPrs(t, gh, log);
  gh.onMutation = async () => { await server.dispatch({ type: 'approve', activityId: workId(server.getState()!, 'local:1') }); };
  assert.equal((await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD })).status, 200);
  assert.deepEqual(lines.filter((line) => line.includes('approve activity=')).length, 1, 'only the approval that went meanwhile');
});

test('enviar revisão answers ok once GitHub took the review, even when its file could not be cleared: a retry would post it twice (#592)', async (t) => {
  const gh = fakeGh();
  const { base, home } = await startPrs(t, gh);
  await send(base, 'POST', `${PATH}/drafts`, { anchor: ANCHOR, text: 'later' });
  gh.onMutation = async () => {
    await rm(join(home, 'pr-reviews'), { recursive: true, force: true });
    await writeFile(join(home, 'pr-reviews'), 'not a directory');
  };
  assert.equal((await send(base, 'POST', `${PATH}/review`, { head: HEAD, event: 'comment', body: '' })).status, 200);
  assert.equal(mutations(gh).length, 1);
});

test('an edit sends only the fields given, at the updatedAt the page read; a newer PR on GitHub is 409 and writes nothing; a bad body 400 (#758)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  assert.equal((await send(base, 'POST', PATH, { title: 'New title', updatedAt: AT })).status, 200);
  assert.equal((await send(base, 'POST', PATH, { body: 'New body', updatedAt: AT })).status, 200);
  assert.deepEqual(mutations(gh), [{ query: EDIT_MUTATION, variables: { pr: 'PR_1', title: 'New title' } }, { query: EDIT_MUTATION, variables: { pr: 'PR_1', body: 'New body' } }]);
  const stale = await send(base, 'POST', PATH, { title: 'x', updatedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual([stale.status, await stale.json()], [409, { error: 'o PR mudou no GitHub desde a leitura da página, atualize' }]);
  for (const body of [{ updatedAt: AT }, { title: ' ', updatedAt: AT }, { title: 'x' }]) assert.equal((await send(base, 'POST', PATH, body)).status, 400, JSON.stringify(body));
  assert.equal(mutations(gh).length, 2);
});

test('a general comment posts to the PR\'s id; an empty one is 400; on a merged PR it is 409 (#758)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  assert.equal((await send(base, 'POST', `${PATH}/comments`, { body: ' thanks ' })).status, 200);
  assert.deepEqual(mutations(gh), [{ query: COMMENT_MUTATION, variables: { pr: 'PR_1', body: 'thanks' } }]);
  for (const body of [{ body: ' ' }, { body: 3 }, {}]) assert.equal((await send(base, 'POST', `${PATH}/comments`, body)).status, 400, JSON.stringify(body));
  gh.pr = { ...gh.pr, state: 'MERGED' };
  assert.equal((await send(base, 'POST', `${PATH}/comments`, { body: 'late' })).status, 409);
  assert.equal(mutations(gh).length, 1);
});

test('mergear without push rights on the PR\'s repository is 403 before any mutation (#854)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, baseRepository: { owner: { login: 'acme' }, viewerPermission: 'READ' } };
  const { base } = await startPrs(t, gh);
  const refused = await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD });
  assert.deepEqual([refused.status, await refused.json()], [403, { error: 'sem permissão de escrita neste repositório' }]);
  assert.equal(mutations(gh).length, 0);
});

test('re-executar falhas re-runs each failed Actions run of the head once, by argv; without push rights it is 403 and runs nothing (#854)', async (t) => {
  const gh = fakeGh();
  const run = (name: string, conclusion: string, runId: number) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, detailsUrl: null, completedAt: AT, checkSuite: { workflowRun: { databaseId: runId } } });
  const ci = (permission: string) => ({
    repository: { viewerPermission: permission }, baseRef: { refUpdateRule: null },
    headCommit: { nodes: [{ commit: { oid: HEAD, checkSuites: { nodes: [] }, statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [run('build', 'FAILURE', 11), run('test', 'FAILURE', 11), run('lint', 'FAILURE', 12), run('docs', 'SUCCESS', 13)] } } } }] },
  });
  gh.ci = ci('WRITE');
  const { base } = await startPrs(t, gh);
  assert.deepEqual(await (await send(base, 'POST', `${PATH}/checks/rerun`)).json(), { ok: true, runs: 2 });
  const reruns = (): string[][] => gh.calls.filter((c) => c.args[0] === 'run').map((c) => c.args);
  assert.deepEqual(reruns(), [['run', 'rerun', '11', '--failed', '-R', 'acme/app'], ['run', 'rerun', '12', '--failed', '-R', 'acme/app']]);
  gh.ci = ci('READ');
  const refused = await send(base, 'POST', `${PATH}/checks/rerun`);
  assert.deepEqual([refused.status, await refused.json()], [403, { error: 'sem permissão para re-executar neste repositório' }]);
  assert.equal(reruns().length, 2);
});

test('re-executar falhas is 409 unless the PR is open, as merge and comment (#854)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, state: 'MERGED' };
  const { base } = await startPrs(t, gh);
  const refused = await send(base, 'POST', `${PATH}/checks/rerun`);
  assert.equal(refused.status, 409);
  assert.equal(gh.calls.filter((c) => c.args[0] === 'run').length, 0);
});

test('mergear on a PR GitHub already merged answers ok with no mutation, marks it merged and approves the task awaiting it; again, still ok (#849)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, state: 'MERGED' };
  const { log, lines } = fakeLog();
  const { base, server } = await startPrs(t, gh, log);
  const merged = await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD });
  assert.deepEqual([merged.status, await merged.json()], [200, { ok: true }]);
  assert.equal(mutations(gh).length, 0);
  const task = server.getState()?.tasks.find((c) => c.item.itemId === 'local:1');
  assert.deepEqual([prsOf(server.getState()!, 'local:1'), activityOf(server.getState()!, 'local:1')?.approval, task?.stage], [[{ url: PR, state: 'merged' }], undefined, 'feito']);
  assert.ok(lines.some((line) => line.includes('pr #7 already merged, counted as merged')));
  assert.equal((await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD })).status, 200, 'a second click is ok too');
  assert.equal(mutations(gh).length, 0);
});

test('mergear on a PR closed without a merge is still 409 and sends nothing (#849)', async (t) => {
  const gh = fakeGh();
  gh.pr = { ...gh.pr, state: 'CLOSED' };
  const { base } = await startPrs(t, gh);
  const refused = await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD });
  assert.deepEqual([refused.status, await refused.json()], [409, { error: 'PR não está aberto' }]);
  assert.equal(mutations(gh).length, 0);
});

test('a mutation GitHub refuses still answers its message beside the button, and leaves it in hive.log by the PR\'s number (#849)', async (t) => {
  const gh = fakeGh();
  const { log, lines } = fakeLog();
  const { base, db } = await startPrs(t, gh, log);
  gh.failWith = 'Required status check "test" is expected';
  const refused = await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD });
  assert.deepEqual([refused.status, await refused.json()], [502, { error: 'gh api graphql: Required status check "test" is expected' }]);
  assert.deepEqual(lines.filter((line) => line.startsWith('WARN pr #7:')), ['WARN pr #7: GitHub refused the write: gh api graphql: Required status check "test" is expected']);
  assert.deepEqual([db.prPage(PR_SOURCE, 'acme/app', 7)?.issue.state, db.prPage(PR_SOURCE, 'acme/app', 7)?.pull?.mergedAt], ['open', null], 'a refused write leaves the model as it was');
});

const LATER = ['2026-09-30T11:00:00Z', '2026-09-30T12:00:00Z', '2026-09-30T13:00:00Z', '2026-09-30T14:00:00Z', '2026-09-30T15:00:00Z'];
const pageOf = async (base: string): Promise<PrData> => (await hiveFetch(`${base}${PATH}`)).json() as Promise<PrData>;

test('a comment, a review and a merge upsert their answer: the next GET shows them with no sync round (#187)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  gh.answer = (query) => {
    if (query === COMMENT_MUTATION) {
      const comment = { id: 'IC_9', url: `${PR}#issuecomment-9`, body: 'thanks', createdAt: LATER[0], updatedAt: LATER[0], author: { login: 'ana' } };
      return { addComment: { commentEdge: { node: comment }, subject: GQL_PR_7({ updatedAt: LATER[0], comments: { totalCount: 1 } }) } };
    }
    if (query === REVIEW_MUTATION) {
      return { addPullRequestReview: { pullRequestReview: { id: 'PRR_1', author: { login: 'ana' }, state: 'APPROVED', body: '', submittedAt: LATER[1], pullRequest: GQL_PR_7({ updatedAt: LATER[1] }) } } };
    }
    if (query === MERGE_MUTATION) return { mergePullRequest: { pullRequest: GQL_PR_7({ state: 'MERGED', mergedAt: LATER[2], closedAt: LATER[2], updatedAt: LATER[2] }) } };
    return undefined;
  };
  assert.equal((await send(base, 'POST', `${PATH}/comments`, { body: 'thanks' })).status, 200);
  assert.deepEqual((await pageOf(base)).comments, [{ id: 'IC_9', author: 'ana', at: LATER[0], text: 'thanks' }]);
  assert.equal((await send(base, 'POST', `${PATH}/review`, { head: HEAD, event: 'approve' })).status, 200);
  const reviewed = await pageOf(base);
  assert.deepEqual([reviewed.reviews, reviewed.approvals], [[{ id: 'PRR_1', author: 'ana', at: LATER[1], kind: 'approved', text: '' }], 1]);
  assert.equal((await send(base, 'POST', `${PATH}/merge`, { method: 'squash', head: HEAD })).status, 200);
  assert.equal((await pageOf(base)).state, 'merged');
});

test('a title edit and an inline comment upsert their answer too (#187)', async (t) => {
  const gh = fakeGh();
  const { base } = await startPrs(t, gh);
  gh.answer = (query) => {
    if (query === EDIT_MUTATION) return { updatePullRequest: { pullRequest: GQL_PR_7({ title: 'New title', updatedAt: LATER[3] }) } };
    if (query === REVIEW_MUTATION) {
      return { addPullRequestReview: { pullRequestReview: { id: 'PRR_2', author: { login: 'ana' }, state: 'COMMENTED', body: '', submittedAt: LATER[4], pullRequest: GQL_PR_7({ updatedAt: LATER[4] }) } } };
    }
    return undefined;
  };
  assert.equal((await send(base, 'POST', PATH, { title: 'New title', updatedAt: AT })).status, 200);
  assert.equal((await pageOf(base)).title, 'New title');
  assert.equal((await send(base, 'POST', `${PATH}/comment`, { head: HEAD, anchor: ANCHOR, text: 'why?' })).status, 200);
  assert.deepEqual((await pageOf(base)).reviews.map((r) => [r.id, r.kind]), [['PRR_2', 'commented']]);
});
