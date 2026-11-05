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
  assert.match(query, /completedAt checkSuite \{ createdAt workflowRun \{ databaseId \} \}/);
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
  assert.deepEqual(ciVerdict([only], { ciChecks: 'all' }), { kind: 'awaiting', workflows: ['CI'], fellBack: false, checks: [] });
  assert.equal(ciVerdict([{ ...only, checks: [check('build', 'failure')] }], { ciChecks: 'all' }).kind, 'failed');
  assert.deepEqual(parseCi([A], { p0: answer('h', [run('x', 'COMPLETED', 'ACTION_REQUIRED')]) })[0].checks.map((c) => c.state), ['failure']);
  const query = ciQuery([A]) ?? '';
  assert.match(query, /checkSuites\(first: 50\) \{ nodes \{ conclusion app \{ slug \} workflowRun \{ workflow \{ name \} \} \} \}/);
  assert.match(query, /repository \{ viewerPermission workflows: /);
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

test('parseCi marks noCi only when the repository\'s default branch has no workflow file: no .github/workflows, or a tree with no .yml/.yaml; an unread repository or a base branch requiring checks holds the wait (#11)', () => {
  const withRepo = (workflows: unknown) => ({ ...answer('h', []), repository: { viewerPermission: 'WRITE', workflows } });
  const tree = (...names: string[]) => ({ entries: names.map((name) => ({ name })) });
  assert.equal(parseCi([A], { p0: withRepo(null) })[0].noCi, true, 'no .github/workflows');
  assert.equal(parseCi([A], { p0: withRepo(tree('README.md')) })[0].noCi, true, 'a folder with no workflow file');
  assert.equal(parseCi([A], { p0: withRepo(tree('ci.yml')) })[0].noCi, undefined);
  assert.equal(parseCi([A], { p0: withRepo(tree('ci.YAML')) })[0].noCi, undefined);
  assert.equal(parseCi([A], { p0: answer('h', []) })[0].noCi, undefined, 'no repository read');
  assert.equal(parseCi([A], { p0: { ...withRepo(null), ...answer('h', [], ['jenkins']) } })[0].noCi, undefined, 'a base branch requiring checks');
  assert.equal(parseCi([A], { p0: { ...answer('h', []), repository: { viewerPermission: 'WRITE' } } })[0].noCi, undefined, 'no workflows field read');
  assert.match(ciQuery([A]) ?? '', /workflows: object\(expression: "HEAD:\.github\/workflows"\) \{ \.\.\. on Tree \{ entries \{ name \} \} \}/);
});

test('ciVerdict: a PR whose repository has no CI does not hold the wait; one with CI and no checks yet still does (#11)', () => {
  const all = { ciChecks: 'all' as const };
  const docs = read([], { url: B, head: 'h2', noCi: true });
  const code = read(['build', 'test', 'lint'].map((n) => check(n, 'success')));
  assert.deepEqual(ciVerdict([docs, code], all), { kind: 'passed', fellBack: false });
  assert.deepEqual(ciVerdict([docs], all), { kind: 'passed', fellBack: false });
  assert.equal(ciVerdict([read([], { url: B, head: 'h2' }), code], all).kind, 'pending', 'a repository with CI and no checks yet');
  assert.equal(ciVerdict([read([check('vercel', 'pending', B)], { url: B, head: 'h2', noCi: true }), code], all).kind, 'pending', 'a noCi PR\'s own checks still count');
});

test('parseCi reads the base branch and marks conflicting only on CONFLICTING; MERGEABLE, UNKNOWN or no answer leave it unset; ciQuery asks both (#264)', () => {
  assert.match(ciQuery([A]) ?? '', /mergeable baseRefName/);
  const of = (extra: Record<string, unknown>): CiPrRead | undefined => parseCi([A], { p0: { ...answer('abc', []), ...extra } })[0];
  const conflicting = of({ mergeable: 'CONFLICTING', baseRefName: 'main' });
  assert.deepEqual([conflicting?.conflicting, conflicting?.base], [true, 'main']);
  for (const mergeable of ['MERGEABLE', 'UNKNOWN', undefined]) {
    const read = of({ mergeable, baseRefName: 'main' });
    assert.deepEqual([read?.conflicting, read?.base], [undefined, 'main'], String(mergeable));
  }
  assert.equal(of({ mergeable: 'CONFLICTING', baseRefName: 7 })?.base, undefined, 'a base that is not a string is not read');
});

test('the CI read keeps a queued run\'s suite creation as queuedAt and no start; stageChecks carries it and lists the run as queued (#598)', () => {
  const T0 = '2026-11-04T10:00:00Z';
  const T1 = '2026-11-04T10:05:00Z';
  const suite = { createdAt: T0, workflowRun: { databaseId: 11 } };
  const queued = { ...run('e2e', 'QUEUED', null, 11), startedAt: T1, checkSuite: suite };
  const running = { ...run('test', 'IN_PROGRESS', null, 11), startedAt: T1, checkSuite: suite };
  const [only] = parseCi([A], { p0: answer('h', [queued, running]) });
  assert.deepEqual(only.checks.map((c) => [c.name, c.startedAt, c.queuedAt, c.runId]), [['e2e', undefined, T0, 11], ['test', T1, undefined, 11]]);
  assert.deepEqual(stageChecks(only.checks).map((c) => [c.name, c.startedAt, c.queuedAt]), [['test', T1, undefined], ['e2e', undefined, T0]]);
});

test('parseCi marks behind only on BEHIND; BLOCKED, UNKNOWN, a new status or no answer leave it unset; ciQuery asks mergeStateStatus (#669)', () => {
  assert.match(ciQuery([A]) ?? '', /mergeable baseRefName mergeStateStatus baseRef/);
  const of = (mergeStateStatus: unknown) => parseCi([A], { p0: { ...answer('abc', []), mergeStateStatus } })[0]?.behind;
  assert.equal(of('BEHIND'), true);
  for (const status of ['BLOCKED', 'UNKNOWN', 'CLEAN', 'SOMETHING_NEW', undefined]) assert.equal(of(status), undefined, String(status));
});

const signed = (requiresSignatures: unknown, commits: unknown[]) => ({ ...answer('abc', []), baseRef: { refUpdateRule: { requiresSignatures } }, signatures: { nodes: commits } });
const commit = (oid: unknown, signature: unknown) => ({ commit: { oid, signature } });

test('parseCi lists the short shas of the commits without a verified signature, in order, only when the base requires signatures; ciQuery asks the last 100 commits apart from the head (#669)', () => {
  const query = ciQuery([A]) ?? '';
  assert.match(query, /refUpdateRule \{ requiredStatusCheckContexts requiresSignatures \}/);
  assert.match(query, /signatures: commits\(last: 100\) \{ nodes \{ commit \{ oid signature \{ isValid \} \} \} \}/);
  const commits = [
    commit('aaaaaaa1111', { isValid: true }), commit('bbbbbbb2222', null), commit('ccccccc3333', { isValid: false }),
    commit(7, null), { commit: null }, commit('ZZZZZZZ9999', null), commit('ddddddd4444', {}),
  ];
  assert.deepEqual(parseCi([A], { p0: signed(true, commits) })[0].unsigned, ['bbbbbbb', 'ccccccc', 'ddddddd']);
  for (const rule of [false, null, undefined, 'true']) assert.equal(parseCi([A], { p0: signed(rule, commits) })[0].unsigned, undefined, String(rule));
  assert.equal(parseCi([A], { p0: signed(true, [commit('aaaaaaa1111', { isValid: true })]) })[0].unsigned, undefined, 'every commit verified');
  assert.equal(parseCi([A], { p0: signed(true, [commit('ZZZZZZZ9999', null)]) })[0].unsigned, undefined, 'no sha survives the check');
  assert.equal(parseCi([A], { p0: { ...answer('abc', []), signatures: { nodes: commits } } })[0].unsigned, undefined, 'no rule read');
});

test('parseCi reads a signatures rule from the base\'s rulesets too, which refUpdateRule leaves null; another rule type is not one (#669)', () => {
  assert.match(ciQuery([A]) ?? '', /rules\(first: 100\) \{ nodes \{ type \} \}/);
  const ruled = (types: unknown[]) => ({ ...answer('abc', []), baseRef: { refUpdateRule: null, rules: { nodes: types.map((type) => ({ type })) } }, signatures: { nodes: [commit('bbbbbbb2222', null)] } });
  assert.deepEqual(parseCi([A], { p0: ruled(['PULL_REQUEST', 'REQUIRED_SIGNATURES']) })[0].unsigned, ['bbbbbbb']);
  assert.equal(parseCi([A], { p0: ruled(['PULL_REQUEST', 'DELETION', 7]) })[0].unsigned, undefined);
});
