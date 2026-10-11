import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciQuery, ciVerdict, considered, matches, parseCi, stageChecks } from '../src/ci-checks.js';
import { ROLLUP_FIELDS, rollupFields } from '../src/pr-checks.js';
import type { CiCheck, CiPrRead } from '../src/types.js';

// A PR's CI as the Hive reads it (#834), on top of #758's checks: the query, the parse, the patterns, which checks count and the verdict.

const A = 'https://github.com/acme/app/pull/7';
const B = 'https://github.com/acme/site/pull/3';
const run = (name: string, status: string, conclusion: string | null, runId?: number) => ({
  __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://github.com/acme/app/actions/runs/${runId ?? 0}/job/9`,
  checkSuite: { workflowRun: runId === undefined ? null : { databaseId: runId } },
});
const context = (name: string, state: string, targetUrl?: string) => ({ __typename: 'StatusContext', context: name, state, ...(targetUrl === undefined ? {} : { targetUrl }) });
const answer = (head: string, nodes: unknown[], required?: string[]) => ({
  baseRef: { refUpdateRule: required === undefined ? null : { requiredStatusCheckContexts: required } },
  headCommit: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: 'PENDING', contexts: { nodes } } } }] },
});
const check = (name: string, state: CiCheck['state'], url = A): CiCheck => ({ name, pr: url, state });
const read = (checks: CiCheck[], extra: Partial<CiPrRead> = {}): CiPrRead => ({ url: A, head: 'h1', checks, ...extra });

test('ciQuery asks each PR, aliased in order, its base branch\'s required checks and #758\'s rollup with the head oid and each run\'s id; ROLLUP_FIELDS is unchanged; no PR, no query (#834)', () => {
  const query = ciQuery([A, B]) ?? '';
  assert.ok(query.includes(`p0: resource(url: "${A}")`) && query.includes(`p1: resource(url: "${B}")`));
  assert.match(query, /requiredStatusCheckContexts/);
  assert.match(query, /headCommit: commits\(last: 1\) \{ nodes \{ commit \{ oid .*statusCheckRollup/);
  assert.match(query, /completedAt checkSuite \{ workflowRun \{ databaseId \} \}/);
  assert.equal(ROLLUP_FIELDS, rollupFields());
  assert.equal(ROLLUP_FIELDS.includes('oid') || ROLLUP_FIELDS.includes('workflowRun'), false, 'the PR page asks what it asked');
  assert.equal(ciQuery([]), undefined);
});

test('parseCi reads #758\'s checks with their url and Actions run; a PR missing from the answer, or with a check it cannot read, has no entry (#834)', () => {
  const data = {
    p0: answer('abc', [
      run('build', 'COMPLETED', 'SUCCESS', 11), run('test', 'COMPLETED', 'FAILURE', 11), run('lint', 'IN_PROGRESS', null, 11),
      run('docs', 'COMPLETED', 'SKIPPED'), run('odd', 'COMPLETED', 'SOMETHING_NEW'),
      context('deploy/vercel', 'ERROR', 'https://vercel.com/x'), context('ci/legacy', 'PENDING'),
    ], ['build', 'test']),
    p1: null,
  };
  const reads = parseCi([A, B], data);
  assert.equal(reads.length, 1);
  const [only] = reads;
  assert.deepEqual([only.url, only.head, only.required], [A, 'abc', ['build', 'test']]);
  assert.deepEqual(only.checks.map((c) => [c.name, c.state, c.runId, c.pr]), [
    ['build', 'success', 11, A], ['test', 'failure', 11, A], ['lint', 'pending', 11, A], ['docs', 'success', undefined, A], ['odd', 'pending', undefined, A],
    ['deploy/vercel', 'failure', undefined, A], ['ci/legacy', 'pending', undefined, A],
  ]);
  assert.deepEqual([only.checks[0].url, only.checks[5].url, only.checks[6].url], ['https://github.com/acme/app/actions/runs/11/job/9', 'https://vercel.com/x', undefined]);
  assert.equal(parseCi([A], { p0: answer('abc', []) })[0].required, undefined, 'a branch with no protection lists no required check');
  assert.deepEqual(parseCi([A], { p0: answer('abc', [run('build', 'COMPLETED', 'FAILURE'), { __typename: 'Mystery' }]) }), [], 'a skipped check could be the failed one');
});

test('a check\'s state is #758\'s bucket: STALE reads pending (#834)', () => {
  const states = (conclusions: string[]) => parseCi([A], { p0: answer('h', conclusions.map((c) => run(c, 'COMPLETED', c))) })[0].checks.map((c) => c.state);
  assert.deepEqual(states(['SUCCESS', 'SKIPPED', 'NEUTRAL']), ['success', 'success', 'success']);
  assert.deepEqual(states(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']), Array(6).fill('failure'));
  assert.deepEqual(states(['STALE']), ['pending']);
  const contexts = parseCi([A], { p0: answer('h', ['SUCCESS', 'FAILURE', 'ERROR', 'EXPECTED'].map((state) => context(state, state))) })[0].checks.map((c) => c.state);
  assert.deepEqual(contexts, ['success', 'failure', 'failure', 'pending']);
});

test('matches reads * as any run of characters, ignores case, matches the whole name and takes everything else literally, brackets included (#834)', () => {
  assert.equal(matches('test (ubuntu-latest)', 'test (ubuntu-*)'), true);
  assert.equal(matches('E2E-chrome', 'e2e-*'), true);
  assert.equal(matches('build', 'Build'), true);
  assert.equal(matches('build-docs', 'build'), false);
  assert.equal(matches('test [a]', 'test [a]'), true);
  assert.equal(matches('testa', 'test [a]'), false);
  assert.equal(matches('axb', 'a.b'), false);
});

test('considered: required counts the base branch\'s names, one not reported as pending; no required checks falls back to all, flagged; all; list keeps a pattern that matches nothing as pending (#834)', () => {
  const checks = [check('build', 'success'), check('test', 'pending'), check('e2e-chrome', 'failure')];
  assert.deepEqual(considered(read(checks, { required: ['build', 'deploy'] }), 'required'), { checks: [check('build', 'success'), check('deploy', 'pending')], fellBack: false });
  assert.deepEqual(considered(read(checks, { required: [] }), 'required'), { checks, fellBack: true });
  assert.deepEqual(considered(read(checks), 'required'), { checks, fellBack: true });
  assert.deepEqual(considered(read(checks), 'all'), { checks, fellBack: false });
  assert.deepEqual(considered(read(checks), 'list', ['E2E-*', 'build', 'docs']), { checks: [check('build', 'success'), check('e2e-chrome', 'failure'), check('docs', 'pending')], fellBack: false });
});

test('ciVerdict: no PR waits for one; no checks yet waits; a running check waits with its count; one failure fails at once; two PRs add up (#834)', () => {
  const all = { ciChecks: 'all' as const };
  assert.deepEqual(ciVerdict([], all), { kind: 'pending', done: 0, total: 0, waitingPr: true, pending: [], fellBack: false, checks: [] });
  assert.deepEqual(ciVerdict([read([])], all), { kind: 'pending', done: 0, total: 0, waitingPr: false, pending: [], fellBack: false, checks: [] });
  assert.deepEqual(ciVerdict([read([check('build', 'success'), check('test', 'pending')])], all), {
    kind: 'pending', done: 1, total: 2, waitingPr: false, pending: ['test'], fellBack: false, checks: [{ name: 'build', state: 'success' }, { name: 'test', state: 'pending' }],
  });
  assert.deepEqual(ciVerdict([read([check('build', 'success'), check('docs', 'success')])], all), { kind: 'passed', fellBack: false });
  assert.deepEqual(ciVerdict([read([check('build', 'failure'), check('test', 'pending')])], all), {
    kind: 'failed', failed: [check('build', 'failure')], fellBack: false, checks: [{ name: 'build', state: 'failure' }, { name: 'test', state: 'pending' }],
  });
  const app = read([check('build', 'success')]);
  assert.deepEqual(ciVerdict([app, read([check('build', 'pending', B)], { url: B, head: 'h2' })], all), {
    kind: 'pending', done: 1, total: 2, waitingPr: false, pending: ['build'], fellBack: false, checks: [{ name: 'build', state: 'success' }, { name: 'build', state: 'pending' }],
  });
  assert.equal(ciVerdict([app, read([check('build', 'success', B)], { url: B, head: 'h2' })], all).kind, 'passed');
  assert.equal(ciVerdict([app, read([], { url: B, head: 'h2' })], all).kind, 'pending', 'a PR with no considered check waits');
  assert.equal(ciVerdict([read([check('build', 'success')], { required: [] })], { ciChecks: 'required' }).fellBack, true);
});

test('parseCi reads the workflows awaiting a maintainer\'s approval from the head\'s check suites (github-actions, ACTION_REQUIRED, once each) and the repository\'s push rights; ciVerdict waits on them unless a check failed; a check run\'s ACTION_REQUIRED stays a failure (#854)', () => {
  const suite = (slug: string, conclusion: string, name?: string) => ({ conclusion, app: { slug }, workflowRun: name === undefined ? null : { workflow: { name } } });
  const awaiting = (permission: string | null) => ({
    baseRef: { refUpdateRule: null }, repository: { viewerPermission: permission },
    headCommit: { nodes: [{ commit: { oid: 'h9', statusCheckRollup: null, checkSuites: { nodes: [
      suite('github-actions', 'ACTION_REQUIRED', 'CI'), suite('github-actions', 'ACTION_REQUIRED', 'CI'), suite('vercel', 'ACTION_REQUIRED'), suite('github-actions', 'SUCCESS', 'Lint'),
    ] } } }] },
  });
  const [only] = parseCi([A], { p0: awaiting('READ') });
  assert.deepEqual([only.awaiting, only.canPush, only.checks], [['CI'], false, []]);
  assert.equal(parseCi([A], { p0: awaiting('WRITE') })[0].canPush, true);
  assert.deepEqual(ciVerdict([only], { ciChecks: 'all' }), { kind: 'awaiting', workflows: ['CI'], fellBack: false });
  assert.equal(ciVerdict([{ ...only, checks: [check('build', 'failure')] }], { ciChecks: 'all' }).kind, 'failed');
  assert.deepEqual(parseCi([A], { p0: answer('h', [run('x', 'COMPLETED', 'ACTION_REQUIRED')]) })[0].checks.map((c) => c.state), ['failure']);
  const query = ciQuery([A]) ?? '';
  assert.match(query, /checkSuites\(first: 50\) \{ nodes \{ conclusion app \{ slug \} workflowRun \{ workflow \{ name \} \} \} \}/);
  assert.match(query, /repository \{ viewerPermission \}/);
});

test('stageChecks orders the considered checks for the running block: finished by end, running by start, queued by name; the times and only an https url kept (#914)', () => {
  const at = (name: string, state: CiCheck['state'], extra: Partial<CiCheck> = {}): CiCheck => ({ name, pr: A, state, ...extra });
  const job = 'https://github.com/acme/app/actions/runs/1/job/3';
  const listed = stageChecks([
    at('e2e', 'pending'),
    at('test', 'pending', { startedAt: '2026-10-10T10:02:00Z', url: job }),
    at('build', 'success', { startedAt: '2026-10-10T10:00:00Z', at: '2026-10-10T10:01:30Z' }),
    at('lint', 'success', { startedAt: '2026-10-10T10:00:00Z', at: '2026-10-10T10:00:45Z', url: 'javascript:alert(1)' }),
  ]);
  assert.deepEqual(listed, [
    { name: 'lint', state: 'success', startedAt: '2026-10-10T10:00:00Z', completedAt: '2026-10-10T10:00:45Z' },
    { name: 'build', state: 'success', startedAt: '2026-10-10T10:00:00Z', completedAt: '2026-10-10T10:01:30Z' },
    { name: 'test', state: 'pending', startedAt: '2026-10-10T10:02:00Z', url: job },
    { name: 'e2e', state: 'pending' },
  ]);
});

test('ciVerdict lists the considered checks: an unreported required name is a queued line; a check outside a list filter is not listed (#914)', () => {
  const required = ciVerdict([read([check('build', 'success'), check('other', 'pending')], { required: ['build', 'deploy'] })], { ciChecks: 'required' });
  assert.deepEqual(required.kind === 'pending' ? required.checks : [], [{ name: 'build', state: 'success' }, { name: 'deploy', state: 'pending' }]);
  const listed = ciVerdict([read([check('e2e-chrome', 'pending'), check('docs', 'success')])], { ciChecks: 'list', checks: ['e2e-*'] });
  assert.deepEqual(listed.kind === 'pending' ? listed.checks.map((c) => c.name) : [], ['e2e-chrome']);
});
