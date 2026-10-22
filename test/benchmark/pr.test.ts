import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dropRunFiles, openPr, PrStepError, prBody, type PrInput } from '../../src/benchmark/pr.js';
import { fakeLog } from '../fakes.js';
import { aggregate } from '../../src/benchmark/report.js';
import { bestRun, endedRuns, prTitle, suggestBranch } from '../../src/benchmark/pr-pick.js';
import type { BenchRun, Experiment } from '../../src/types.js';
import { type Call, experiment, fakeRun, line, PR_ROOT, PR_URL, prAnswers, run } from './fixtures.js';

const AT = '2026-10-22T08:00:00.000Z';
// A run judged with these scores, done unless the patch says otherwise
const judged = (token: string, scores: number[], patch: Partial<BenchRun> = {}): BenchRun => run(token, {
  status: 'done', ...patch,
  evaluation: { at: AT, collectors: [], scenarios: [], judge: { agent: 'claude', rubricHash: 'r'.repeat(64), scores: scores.map((score, i) => ({ dimension: `d${i}`, score, evidence: '' })) } },
});
const withRuns = (...rounds: BenchRun[][]): Experiment => experiment({ rounds: rounds.map((runs, i) => ({ n: i + 1, runs })) });
const tokensOf = (tokens: number): Pick<BenchRun, 'metrics'> => ({
  metrics: { tokens, costUsd: 0, ms: 0, waitingMs: 0, restarts: { count: 0, where: [] }, diff: { files: 0, insertions: 0, deletions: 0 }, tests: { green: 0, total: 0 }, tasks: [] },
});

test('bestRun: the highest mean judge score; a tie goes to done, then to fewer tokens, then to the earlier round (#477)', () => {
  assert.equal(bestRun(withRuns([judged('aaaa1', [4, 4]), judged('bbbb1', [5, 4])]))?.token, 'bbbb1');
  assert.equal(bestRun(withRuns([judged('aaaa1', [5, 4], { status: 'timeout' }), judged('bbbb1', [4, 5])]))?.token, 'bbbb1', 'done first');
  assert.equal(bestRun(withRuns([judged('aaaa1', [4], tokensOf(3_000_000)), judged('bbbb1', [4], tokensOf(2_000_000))]))?.token, 'bbbb1', 'fewer tokens');
  assert.equal(bestRun(withRuns([judged('aaaa1', [4], tokensOf(1)), judged('bbbb1', [4])]))?.token, 'aaaa1', 'a run with no metrics counts as the most tokens');
  assert.equal(bestRun(withRuns([judged('aaaa1', [4])], [judged('bbbb2', [4], { round: 2 })]))?.token, 'aaaa1', 'the earlier round');
});

test('bestRun: with no judged run, the first ended one; with none ended, none. Every ended status counts, a live one never (#477)', () => {
  const live = (['queued', 'running', 'waiting', 'sleeping'] as const).map((status, i) => run(`live${i}`, { status }));
  assert.equal(bestRun(withRuns(live)), undefined);
  assert.equal(bestRun(withRuns([run('aaaa1', { status: 'running' }), run('bbbb1', { status: 'interrupted' }), run('cccc1', { status: 'done' })]))?.token, 'bbbb1');
  const ended = withRuns([run('aaaa1', { status: 'error' }), run('bbbb1', { status: 'timeout' }), run('cccc1', { status: 'sleeping' })], [run('dddd2', { status: 'done', round: 2 })]);
  assert.deepEqual(endedRuns(ended).map((r) => r.token), ['aaaa1', 'bbbb1', 'dddd2']);
});

test('suggestBranch kebabs the experiment\'s name under feat/, without accents and capped, and prTitle is feat: and the name (#477)', () => {
  assert.equal(suggestBranch('Skills do plugin'), 'feat/skills-do-plugin');
  assert.equal(suggestBranch('  Ação: rápida!  '), 'feat/acao-rapida');
  assert.equal(suggestBranch('***'), 'feat/experiment');
  assert.equal(suggestBranch('x'.repeat(80)), `feat/${'x'.repeat(60)}`);
  assert.equal(prTitle('Skills do plugin'), 'feat: Skills do plugin');
});


const MIN = 60_000;
const NOW = Date.parse('2026-10-22T09:00:00.000Z');
const measured = (): BenchRun => run('aaaa1', {
  status: 'done', delivered: 1, endedAt: AT,
  metrics: { tokens: 2_500_000, costUsd: 33, ms: 288 * MIN, waitingMs: 0, restarts: { count: 0, where: [] }, diff: { files: 1, insertions: 1, deletions: 0 }, tests: { green: 10, total: 10 }, tasks: [] },
  evaluation: { at: AT, collectors: [], scenarios: [], judge: { agent: 'claude', rubricHash: 'r'.repeat(64), scores: [{ dimension: 'fidelity', score: 4, evidence: '' }, { dimension: 'behavior', score: 5, evidence: '' }] } },
});

test('prBody without the summary: the line and the run\'s task titles, nothing of the report (#477)', () => {
  assert.equal(prBody(withRuns([measured()]), measured(), undefined), 'Opened from a benchmark run.\n\n- One\n');
});

test('prBody with the summary: the experiment, the arm, the run and its round, the arm\'s medians and the hash prefixes, no link (#477)', () => {
  const e = withRuns([measured()]);
  assert.equal(prBody(e, measured(), aggregate(e, 'in', NOW)), [
    'Opened from a benchmark run.', '',
    'Experiment Skills, arm A · arm A, run aaaa1, round 1.', '',
    '- tokens: 2.5M', '- cost: $33', '- time: 4h48', '- tests green: 1/1', '- fidelity: 4', '- behavior: 5', '',
    'seed ssssss · tasks tttttt · plugin pppppp', '',
  ].join('\n'));
});

const REPO = '/work/hive';
const WT = '/work/hive/.hive/worktrees/bench-pr-aaaa1';
const REF = 'refs/hive/bench/aaaa1';
const INPUT: PrInput = {
  experimentId: 'exp-1', token: 'aaaa1', workspace: { path: REPO, benchmarkPrIn: 'worktree' }, repoGit: '/hive/benchmark/exp-1/repo.git',
  base: 'main', branch: 'feat/skills', title: 'feat: Skills', body: 'Opened from a benchmark run.\n\n- One\n',
};
const CHECKOUT: PrInput = { ...INPUT, workspace: { path: REPO, benchmarkPrIn: 'checkout' } };
const FETCH = [
  'git ls-remote --heads origin refs/heads/feat/skills', `git fetch /hive/benchmark/exp-1/repo.git +refs/heads/work/aaaa1:${REF}`, 'git fetch origin main',
  `git rev-list --max-parents=0 ${REF}`, `git rev-list --count ${PR_ROOT}..${REF}`, 'git rev-parse --short origin/main',
];
const REBASE = `git rebase --onto origin/main ${PR_ROOT} feat/skills`;
const DIFF = 'git diff --name-only origin/main HEAD -- .claude/settings.local.json scripts/experiment test/experiment';
const PUSH = 'git push -u origin feat/skills';
const GH = 'gh pr create --base main --head feat/skills --title feat: Skills --body-file BODY';
const shown = (calls: Call[]): string[] => calls.map((c) => line(c).replace(/--body-file \S+/, '--body-file BODY'));

// openPr over one recorded runner for git and gh, so both are on one ordered list; the body is read while gh runs, before its folder goes
function sequence(answer = prAnswers()) {
  const bodies: string[] = [];
  const { run: exec, calls } = fakeRun((call) => {
    if (call.file === 'gh') bodies.push(readFileSync(call.args[call.args.indexOf('--body-file') + 1], 'utf8'));
    return answer(call);
  });
  const { log, lines } = fakeLog();
  return { deps: { exec, gh: exec, log }, calls, bodies, lines };
}

test('openPr in a temporary worktree: fetch, branch, rebase, push and gh pr create in that order, then the worktree and the run ref go; it answers the URL (#477)', async () => {
  const s = sequence();
  assert.deepEqual(await openPr(s.deps, INPUT), { url: PR_URL });
  assert.deepEqual(shown(s.calls), [
    ...FETCH, `git worktree add -b feat/skills ${WT} ${REF}`, REBASE, DIFF, PUSH, GH,
    `git worktree remove --force ${WT}`, 'git worktree prune', `git update-ref -d ${REF}`,
  ]);
  assert.equal(s.calls[0].cwd, REPO);
  assert.deepEqual(s.calls.filter((c) => c.args[0] === 'rebase' || c.file === 'gh').map((c) => c.cwd), [WT, WT], 'the rebase and gh run in the worktree');
  assert.deepEqual(s.bodies, [INPUT.body]);
  assert.equal(existsSync(dirname(s.calls.find((c) => c.file === 'gh')?.args.at(-1) ?? '/')), false, 'the body file\'s folder is removed');
});

test('openPr in the workspace\'s checkout: clean, remembered, branched, rebased, pushed and opened, then back on its branch, or on its commit when detached (#477)', async () => {
  const s = sequence();
  assert.deepEqual(await openPr(s.deps, CHECKOUT), { url: PR_URL });
  assert.deepEqual(shown(s.calls), [
    ...FETCH, 'git status --porcelain', 'git symbolic-ref --short -q HEAD', `git checkout -b feat/skills ${REF}`, REBASE, DIFF, PUSH, GH,
    'git checkout main', `git update-ref -d ${REF}`,
  ]);
  assert.ok(s.calls.every((c) => c.cwd === REPO), 'every call runs in the checkout');
  const sha = 'c'.repeat(40);
  const detached = sequence(prAnswers({ 'git symbolic-ref': Object.assign(new Error('not a symbolic ref'), { code: 1 }), 'git rev-parse HEAD': `${sha}\n` }));
  assert.deepEqual(await openPr(detached.deps, CHECKOUT), { url: PR_URL });
  assert.deepEqual(shown(detached.calls).slice(-2), [`git checkout ${sha}`, `git update-ref -d ${REF}`]);
});

test('a rebase conflict answers its files after the abort; the worktree is removed, or the checkout is back on its branch; the branch is deleted, the run ref kept (#477)', async () => {
  const conflict = prAnswers({ 'git rebase --onto': new Error('CONFLICT (content)'), 'git diff --name-only --diff-filter=U': 'src/a.ts\nsrc/b.ts\n' });
  const wt = sequence(conflict);
  assert.deepEqual(await openPr(wt.deps, INPUT), { error: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
  assert.deepEqual(shown(wt.calls).slice(-6), [REBASE, 'git diff --name-only --diff-filter=U', 'git rebase --abort', `git worktree remove --force ${WT}`, 'git worktree prune', 'git branch -D feat/skills']);
  const co = sequence(conflict);
  assert.deepEqual(await openPr(co.deps, CHECKOUT), { error: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
  assert.deepEqual(shown(co.calls).slice(-5), [REBASE, 'git diff --name-only --diff-filter=U', 'git rebase --abort', 'git checkout main', 'git branch -D feat/skills']);
  for (const s of [wt, co]) assert.equal(shown(s.calls).some((l) => l.startsWith('git push') || l.startsWith('gh') || l.startsWith('git update-ref')), false);
});

test('the run files: one chore commit restoring what the base has and removing what it lacks, only when a run file differs (#477)', async () => {
  const s = sequence(prAnswers({ [DIFF]: 'scripts/experiment/run.ts\n.claude/settings.local.json\n', 'git cat-file -e origin/main:.claude/settings.local.json': new Error('missing') }));
  assert.deepEqual(await openPr(s.deps, INPUT), { url: PR_URL });
  const calls = shown(s.calls);
  const from = calls.indexOf(DIFF);
  assert.deepEqual(calls.slice(from, from + 7), [
    DIFF, 'git cat-file -e origin/main:scripts/experiment/run.ts', 'git cat-file -e origin/main:.claude/settings.local.json',
    'git restore --source origin/main --staged --worktree -- scripts/experiment/run.ts', 'git rm -q -- .claude/settings.local.json',
    'git commit -q -m chore: drop run files', PUSH,
  ]);
  const { run: git, calls: clean } = fakeRun(prAnswers());
  assert.equal(await dropRunFiles(git, 'main'), false);
  assert.deepEqual(clean.map(line), [DIFF], 'no run file differs: no commit');
});

test('a refusal stops the sequence: a branch already on origin, a run with no commit after its baseline, a dirty checkout with its files (#477)', async () => {
  const exists = sequence(prAnswers({ 'git ls-remote': `${'d'.repeat(40)}\trefs/heads/feat/skills\n` }));
  assert.deepEqual(await openPr(exists.deps, INPUT), { error: 'branch-exists' });
  assert.deepEqual(shown(exists.calls), [FETCH[0]]);
  const empty = sequence(prAnswers({ 'git rev-list --count': '0\n' }));
  assert.deepEqual(await openPr(empty.deps, INPUT), { error: 'no-commits' });
  assert.deepEqual(shown(empty.calls), FETCH);
  const dirty = sequence(prAnswers({ 'git status --porcelain': ' M src/x.ts\n?? notes.txt\nR  old.ts -> new.ts\n' }));
  assert.deepEqual(await openPr(dirty.deps, CHECKOUT), { error: 'dirty', files: ['src/x.ts', 'notes.txt', 'new.ts'] });
  assert.deepEqual(shown(dirty.calls), [...FETCH, 'git status --porcelain']);
});

test('a failed step rejects naming it, and the cleanup still runs: a push that fails leaves no worktree and no local branch (#477)', async () => {
  const s = sequence(prAnswers({ 'git push': new Error('rejected') }));
  await assert.rejects(openPr(s.deps, INPUT), (err: unknown) => err instanceof PrStepError && err.step === 'push');
  assert.deepEqual(shown(s.calls).slice(-3), [`git worktree remove --force ${WT}`, 'git worktree prune', 'git branch -D feat/skills']);
});
