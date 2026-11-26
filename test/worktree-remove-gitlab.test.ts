import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWorktree, type PrHosts } from '../src/worktree-remove.js';
import { fakeGitlabApi } from './fake-gitlab.js';
import { fakeLog, fakeMachine } from './fakes.js';
import { cleanRepo, mergedPr, PR, squashed, TIP } from './worktree-clean-fakes.js';
import { CLEAN_BRANCH, SLUG } from './worktree-fakes.js';


const MR = 'https://gitlab.com/acme/app/-/merge_requests/58';
const MR_PATH = 'GET projects/acme%2Fapp/merge_requests/58';
// gitlab.com's account answers `answers`; any other host has none
function onGitlab(answers: Record<string, unknown>, gitlabHosts: string[] = []): { hosts: PrHosts; calls: ReturnType<typeof fakeGitlabApi>['calls'] } {
  const { api, calls } = fakeGitlabApi(answers);
  return { hosts: { gitlabHosts, gitlabAccess: async (host) => (host === 'gitlab.com' ? api : undefined) }, calls };
}

test('a squashed branch whose MR GitLab merged at the local tip goes with update-ref -d at that tip, read through the host\'s account; nothing reaches gh (#1053)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const f = squashed(repo, path, {});
  const gitlab = onGitlab({ [MR_PATH]: { iid: 58, state: 'merged', sha: TIP } });
  await cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr(MR)], hosts: gitlab.hosts });
  assert.deepEqual([f.gh, gitlab.calls], [[], [{ method: 'GET', path: 'projects/acme%2Fapp/merge_requests/58' }]]);
  assert.deepEqual(f.calls.at(-1), ['update-ref', '-d', `refs/heads/${CLEAN_BRANCH}`, TIP]);
});

test('a failing MR read, an MR not merged, a different or missing sha refuse with unmerged and remove nothing, each logged with the url (#1053)', async (t) => {
  const cases: [unknown, string][] = [
    [new Error('gitlab api: HTTP 502'), `mergedByPr ${MR}: gitlab api: HTTP 502`],
    [{ state: 'opened', sha: TIP }, `mergedByPr ${MR}: not merged on GitLab`],
    [{ state: 'merged', sha: 'fedcba9' }, ''],
    [{ state: 'merged' }, `mergedByPr ${MR}: not merged on GitLab`],
  ];
  for (const [answer, logged] of cases) {
    const { repo, path } = await cleanRepo(t, true);
    const f = squashed(repo, path, {});
    const { log, lines } = fakeLog();
    const refusal = { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD' };
    await assert.rejects(cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr(MR)], hosts: onGitlab({ [MR_PATH]: answer }).hosts, log }), { refusal }, JSON.stringify(answer));
    assert.equal(f.calls.some((c) => c[1] === 'remove' || c[0] === 'update-ref'), false);
    assert.deepEqual(lines.map((l) => l.replace(/^INFO /, '')), logged === '' ? [] : [logged]);
  }
});

test('no account for the MR\'s host refuses with noAccount naming it; a host off the list is not read at all; a GitHub link beside still goes to gh (#1053)', async (t) => {
  const { repo, path } = await cleanRepo(t, true);
  const own = 'https://git.example.com/acme/app/-/merge_requests/3';
  const off = 'https://code.example.org/acme/app/-/merge_requests/4';
  const f = squashed(repo, path, { [PR]: 'fedcba9' });
  const { log, lines } = fakeLog();
  const gitlab = onGitlab({}, ['git.example.com']);
  await assert.rejects(
    cleanWorktree(fakeMachine({ exec: f.exec }), repo, { slug: SLUG }, CLEAN_BRANCH, undefined, { prs: [mergedPr(own), mergedPr(off), mergedPr()], hosts: gitlab.hosts, log }),
    { refusal: { reason: 'unmerged', branch: CLEAN_BRANCH, target: 'HEAD', noAccount: ['git.example.com'] }, message: `the branch '${CLEAN_BRANCH}' is not fully merged into HEAD (no GitLab account for git.example.com to read its PR)` },
  );
  assert.deepEqual([gitlab.calls, f.gh.map((args) => args[2])], [[], [PR]]);
  assert.deepEqual(lines.map((l) => l.replace(/^INFO /, '')).sort(), [`mergedByPr ${off}: not a GitHub PR or a GitLab host's merge request`, `mergedByPr ${own}: no GitLab account for git.example.com`].sort());
});
