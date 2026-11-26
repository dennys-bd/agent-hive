import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitlabApi } from '../../src/gitlab/api.js';
import { mergedMrHead, openMergeRequest, readProject } from '../../src/gitlab/merge-requests.js';

const HOST = 'gitlab.com';
const TOKEN = `glpat-test-${randomUUID()}`; // built at runtime: no token in a fixture
const PROJECT = 'acme/group/docs';
const P = 'acme%2Fgroup%2Fdocs'; // the project path as one encoded segment
const OWN = `https://${HOST}/${PROJECT}/-/merge_requests/11`;
const FORK = `https://${HOST}/someone/docs/-/merge_requests/9`;
const MR = { source: 'hive/7-site', target: 'main', title: 'docs: decomposition for acme/site#7', body: 'The decomposition.' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { method: string; path: string; body?: unknown }
// The real client over a fetch answering `${method} ${path}`; anything else is GitLab's 404
function fakeGitlab(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = String(url).replace(`https://${HOST}/api/v4/`, '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    return answers[`${method} ${path}`]?.() ?? json(404, { message: '404 Not Found' });
  }) as unknown as typeof fetch;
  return { calls, api: gitlabApi({ host: HOST, token: async () => TOKEN, fetch: doFetch }) };
}
const LIST = `projects/${P}/merge_requests?state=opened&source_branch=hive%2F7-site&target_branch=main`;

test('readProject answers the project\'s id as a string and its default branch, the path sent as one encoded segment; another shape throws (#1053)', async () => {
  const { api, calls } = fakeGitlab({ [`GET projects/${P}`]: () => json(200, { id: 42, default_branch: 'trunk' }) });
  assert.deepEqual(await readProject(api, PROJECT), { id: '42', defaultBranch: 'trunk' });
  assert.deepEqual(calls, [{ method: 'GET', path: `projects/${P}` }]);
  const odd = fakeGitlab({ [`GET projects/${P}`]: () => json(200, { id: 'x', default_branch: 'trunk' }) });
  await assert.rejects(readProject(odd.api, PROJECT), /no project/);
});

test('openMergeRequest creates the MR from the branch into the target with its title and description, and answers its iid and link (#1053)', async () => {
  const { api, calls } = fakeGitlab({ [`POST projects/${P}/merge_requests`]: () => json(201, { iid: 11, web_url: OWN }) });
  assert.deepEqual(await openMergeRequest(api, PROJECT, MR), { iid: 11, url: OWN });
  assert.deepEqual(calls, [{ method: 'POST', path: `projects/${P}/merge_requests`, body: { source_branch: 'hive/7-site', target_branch: 'main', title: MR.title, description: MR.body } }]);
});

test('a create GitLab refuses adopts the open MR whose source is the project itself, never a fork\'s of the same branch name (#1053)', async () => {
  const project = (): Response => json(200, { id: 42, default_branch: 'main' });
  const { api, calls } = fakeGitlab({
    [`POST projects/${P}/merge_requests`]: () => json(409, { message: ['Another open merge request already exists for this source branch'] }),
    [`GET projects/${P}`]: project,
    [`GET ${LIST}`]: () => json(200, [{ iid: 9, source_project_id: 77, web_url: FORK }, { iid: 11, source_project_id: 42, web_url: OWN }]),
  });
  assert.deepEqual(await openMergeRequest(api, PROJECT, MR), { iid: 11, url: OWN });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST projects/${P}/merge_requests`, `GET projects/${P}`, `GET ${LIST}`]);
  const forkOnly = fakeGitlab({
    [`POST projects/${P}/merge_requests`]: () => json(409, {}),
    [`GET projects/${P}`]: project,
    [`GET ${LIST}`]: () => json(200, [{ iid: 9, source_project_id: 77, web_url: FORK }]),
  });
  await assert.rejects(openMergeRequest(forkOnly.api, PROJECT, MR), { message: 'gitlab api: HTTP 409' }, 'the create\'s own error');
});

test('mergedMrHead answers the head sha of a merged MR, and none for opened, closed or a merged one with no sha; an answer with no state throws (#1053)', async () => {
  const at = (body: unknown) => fakeGitlab({ [`GET projects/${P}/merge_requests/11`]: () => json(200, body) }).api;
  assert.equal(await mergedMrHead(at({ iid: 11, state: 'merged', sha: 'c0ffee1' }), PROJECT, 11), 'c0ffee1');
  for (const body of [{ state: 'opened', sha: 'c0ffee1' }, { state: 'closed', sha: 'c0ffee1' }, { state: 'merged' }, { state: 'merged', sha: '' }]) {
    assert.equal(await mergedMrHead(at(body), PROJECT, 11), undefined, JSON.stringify(body));
  }
  await assert.rejects(mergedMrHead(at({ sha: 'c0ffee1' }), PROJECT, 11), /no state/);
});

test('no answer or error of these calls holds the token (#1053)', async () => {
  const failing = fakeGitlab({ [`POST projects/${P}/merge_requests`]: () => json(500, {}), [`GET projects/${P}`]: () => json(401, {}) });
  const errors = await Promise.all([
    openMergeRequest(failing.api, PROJECT, MR).catch((e: unknown) => e),
    readProject(failing.api, PROJECT).catch((e: unknown) => e),
    mergedMrHead(failing.api, PROJECT, 11).catch((e: unknown) => e),
  ]);
  for (const err of errors) {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(TOKEN) && !JSON.stringify(err).includes(TOKEN), err.message);
  }
});
