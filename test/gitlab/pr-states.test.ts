import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type GitlabAnswer, GitlabHttpError } from '../../src/gitlab/api.js';
import { type GitlabAccess, readMrActivity, readMrStates } from '../../src/gitlab/pr-states.js';
import { SourceRateLimitError } from '../../src/source-errors.js';

const MR = 'https://gitlab.com/acme/platform/app/-/merge_requests/7';
const SELF = 'https://git.example.com/acme/app/-/merge_requests/3';
const MR_PATH = 'projects/acme%2Fplatform%2Fapp/merge_requests/7';
const SELF_PATH = 'projects/acme%2Fapp/merge_requests/3';
const COMMITS = '/commits?per_page=100';
const OPENED = '2026-11-20T10:00:00.000Z';
const MERGED_AT = '2026-11-21T09:00:00.000Z';
const BEFORE = '2026-11-19T10:00:00.000Z';
const AFTER = '2026-11-20T11:00:00.000Z';

type Answer = GitlabAnswer | (() => GitlabAnswer);
// A GitLab per host answering by API path: a path with no answer is a 404, and a host with no entry has no account
function fakeAccess(hosts: Record<string, Record<string, Answer>>): { access: GitlabAccess; calls: string[] } {
  const calls: string[] = [];
  const access: GitlabAccess = async (host) => {
    if (!Object.hasOwn(hosts, host)) return undefined;
    const answers = hosts[host];
    return {
      get: async (path: string) => {
        calls.push(`${host} ${path}`);
        const answer = Object.hasOwn(answers, path) ? answers[path] : undefined;
        if (answer === undefined) throw new GitlabHttpError(404);
        return typeof answer === 'function' ? answer() : answer;
      },
    };
  };
  return { access, calls };
}
const mr = (state: string, extra: Record<string, unknown> = {}): GitlabAnswer => ({ body: { iid: 7, state, created_at: OPENED, ...extra } });
const commit = (n: number, date: string) => ({ id: `${String(n).padStart(8, '0')}${'f'.repeat(32)}`, committed_date: date });

test('each MR state reads as the Hive\'s: opened and locked are open, merged and closed are theirs; an unknown state leaves the MR out, named in the failures (#1052)', async () => {
  const cases: [string, string][] = [['opened', 'open'], ['locked', 'open'], ['merged', 'merged'], ['closed', 'closed']];
  for (const [state, expected] of cases) {
    const { reads, failures } = await readMrStates([MR], fakeAccess({ 'gitlab.com': { [MR_PATH]: mr(state) } }).access);
    assert.deepEqual([reads.map((r) => r.state), failures], [[expected], []], state);
  }
  const unknown = await readMrStates([MR], fakeAccess({ 'gitlab.com': { [MR_PATH]: mr('archived') } }).access);
  assert.deepEqual([unknown.reads, unknown.failures], [[], ['gitlab.com #7: unknown state']], 'GitLab\'s text is never quoted');
});

test('created_at, merged_at and closed_at become openedAt, mergedAt and closedAt, each only when it parses as a date (#1052)', async () => {
  const merged = await readMrStates([MR], fakeAccess({ 'gitlab.com': { [MR_PATH]: mr('merged', { merged_at: MERGED_AT, closed_at: null }) } }).access);
  assert.deepEqual(merged.reads, [{ url: MR, state: 'merged', openedAt: OPENED, mergedAt: MERGED_AT }]);
  const closed = await readMrStates([MR], fakeAccess({ 'gitlab.com': { [MR_PATH]: mr('closed', { created_at: 'soon', closed_at: MERGED_AT }) } }).access);
  assert.deepEqual(closed.reads, [{ url: MR, state: 'closed', closedAt: MERGED_AT }]);
});

test('a 404, a 429 and an answer of the wrong shape leave that MR out and name its host and number; the other MRs are still read (#1052)', async () => {
  const cases: [string, Answer | undefined, string][] = [
    ['404', undefined, 'gitlab.com #7: gitlab api: HTTP 404'],
    ['429', () => { throw new SourceRateLimitError('2026-11-25T13:00:00.000Z'); }, 'gitlab.com #7: rate limited until 2026-11-25T13:00:00.000Z'],
    ['a list', { body: ['x'] }, 'gitlab.com #7: unexpected answer'],
    ['no state', { body: { state: 7 } }, 'gitlab.com #7: unexpected answer'],
  ];
  for (const [name, answer, failure] of cases) {
    const { access } = fakeAccess({ 'gitlab.com': answer === undefined ? {} : { [MR_PATH]: answer }, 'git.example.com': { [SELF_PATH]: mr('merged') } });
    const { reads, failures } = await readMrStates([MR, SELF], access);
    assert.deepEqual([reads.map((r) => r.url), failures], [[SELF], [failure]], name);
  }
});

test('a host with no account fails once for all its MRs, with no call; the hosts are read in the order they first appear (#1052)', async () => {
  const other = 'https://code.example.org/acme/app/-/merge_requests/9';
  const { access, calls } = fakeAccess({ 'git.example.com': { [SELF_PATH]: mr('opened') } });
  const { reads, failures } = await readMrStates([MR, SELF, 'https://gitlab.com/acme/site/-/merge_requests/2', other], access);
  assert.deepEqual(reads.map((r) => r.url), [SELF]);
  assert.deepEqual(failures, ['gitlab.com: no account', 'code.example.org: no account']);
  assert.deepEqual(calls, [`git.example.com ${SELF_PATH}`]);
});

test('the commits listing is paged: its length is the count, recent is the first 100 listed with the sha cut to 8, afterOpen counts those after the MR opened, and no checks (#1052)', async () => {
  const all = Array.from({ length: 120 }, (_, i) => commit(i, i % 4 === 0 ? BEFORE : AFTER));
  const page2 = `${MR_PATH}${COMMITS}&page=2`;
  const { access } = fakeAccess({ 'gitlab.com': { [`${MR_PATH}${COMMITS}`]: { body: all.slice(0, 60), next: page2 }, [page2]: { body: all.slice(60) } } });
  const { reads, failures } = await readMrActivity([{ url: MR, state: 'open', openedAt: OPENED }], access);
  assert.deepEqual(failures, []);
  assert.deepEqual(reads, [{
    url: MR, commits: 120, afterOpen: 75, checks: [],
    recent: all.slice(0, 100).map((c) => ({ sha: c.id.slice(0, 8), committedAt: c.committed_date })),
  }]);
});

test('an odd commit counts but is left out of recent; with no opening time there is no afterOpen; a failed listing is named and reads nothing (#1052)', async () => {
  const odd = fakeAccess({ 'gitlab.com': { [`${MR_PATH}${COMMITS}`]: { body: [commit(1, AFTER), { id: 7, committed_date: AFTER }, null, { id: 'x'.repeat(40), committed_date: 'soon' }] } } });
  assert.deepEqual((await readMrActivity([{ url: MR, state: 'merged' }], odd.access)).reads, [{ url: MR, commits: 4, recent: [{ sha: '00000001', committedAt: AFTER }], checks: [] }]);
  const failed = await readMrActivity([{ url: MR, state: 'open', openedAt: OPENED }], fakeAccess({ 'gitlab.com': {} }).access);
  assert.deepEqual([failed.reads, failed.failures], [[], ['gitlab.com #7: gitlab api: HTTP 404']]);
});
