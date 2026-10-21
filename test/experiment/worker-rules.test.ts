import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBranch } from '../../scripts/experiment/plan.js';
import { parseStagesSeed, SEED_DIR } from '../../scripts/experiment/seed.js';
import { harnessRulePaths } from '../../scripts/experiment/arm-config.js';
import { runClaudeArgs, runRules } from '../../src/benchmark/worker-rules.js';
import { bashDecision, readDecision, rulesOf } from './rules.js';

const BRANCH = runBranch('abc123');
const OTHER = runBranch('def456');
const STATE = '/state/agent-hive-lab';
const HOME = `${STATE}/homes/abc123`;
const OTHER_HOME = `${STATE}/homes/def456`;
const PUSH = `git push origin HEAD:${BRANCH}`; // the Merge prompt's own push

async function workerRules(): Promise<{ allow: string[]; deny: string[] }> {
  const seed = parseStagesSeed(JSON.parse(await readFile(join(SEED_DIR, 'stages.json'), 'utf8')));
  const args = runClaudeArgs(seed.claudeArgs, BRANCH, harnessRulePaths({ state: STATE, home: HOME }));
  return { allow: rulesOf(args, '--allowedTools'), deny: rulesOf(args, '--disallowedTools') };
}

// Both stages that run in either arm: the Merge prompt (stages.json) and the build's review against the run branch
const MERGE = ['git branch --show-current', `git fetch origin ${BRANCH}`, `git merge origin/${BRANCH}`, `git switch --detach origin/${BRANCH}`,
  'git merge --no-ff -m "merge: MABC123-1 Monitor View 1" hive/MABC123-1-grid', 'pnpm test', PUSH, 'git switch hive/MABC123-1-grid', `git diff origin/${BRANCH}...HEAD`];

// Arm A: .claude/commands/hive-{spec,plan,build}.md, plus the user-level skills and agents they dispatch (superpowers brainstorming and
// writing-plans; ecc tdd-guide, build-error-resolver, typescript-reviewer, security-reviewer, planner)
const ARM_A = [
  'git status --short --branch', 'git checkout -b feat/monitor-grid main', 'git add docs/superpowers/specs', 'git add docs/superpowers/plans',
  'git commit -m "docs: spec for monitor-grid"', 'pnpm test', 'git diff main...HEAD', 'git add tests/path/test.py src/path/file.py',
  'npm test', 'npm run test:coverage', 'npx tsc --noEmit --pretty', 'npx tsc --noEmit --pretty --incremental false', 'npm run build',
  'git diff --staged', 'git diff', "git show --patch HEAD -- '*.ts' '*.tsx'", 'npm run typecheck --if-present', 'tsc --noEmit -p tsconfig.json',
  'npm audit', 'npm audit --audit-level=high',
];

// Arm B: assets/plugin (skills new-spec, new-plan, new-build; agents; reference/conventions.md). new-pr is the PR step the Build prompt skips
const ARM_B = [
  'git status --short --branch', 'git symbolic-ref --short refs/remotes/origin/HEAD', 'git checkout -b feat/monitor-grid feat/monitor-view-abc123',
  'git -C . check-ignore -q docs/superpowers/specs/2026-10-02-monitor-grid-design.md', 'git check-ignore -q docs/superpowers/plans/x.md',
  'git add docs/superpowers/specs/2026-10-02-monitor-grid-design.md', 'git commit -m "docs: spec for monitor-grid"',
  'git -C /repo/.hive/worktrees/mabc123-1-grid add docs/superpowers/plans/x.md', 'git -C /repo/.hive/worktrees/mabc123-1-grid commit -m "docs: plan for monitor-grid"',
  'git diff --name-only --diff-filter=A feat/monitor-view-abc123...HEAD -- docs/superpowers/specs', 'git rev-parse HEAD', 'git diff 1a2b3c..HEAD',
  'git diff feat/monitor-view-abc123...HEAD', 'git checkout hive/MABC123-1-grid', 'git checkout -b hive/MABC123-1-grid-s2', 'git log --oneline -5',
  'pnpm test', 'pnpm lint', 'pnpm exec tsc --noEmit',
];

// Found in the scan and refused: denied, so a worker that tries one is told no at once instead of waiting on a prompt nobody answers
const REFUSED = ['gh pr create --title t --base main --head hive/x --body-file /tmp/b', 'gh issue view 1', 'npx eslint . --ext .ts,.tsx,.js,.jsx', 'npx eslint . --fix',
  'npx eslint . --plugin security', 'eslint . --ext .ts,.tsx,.js,.jsx', 'prettier --check .', 'git push -u origin hive/MABC123-1-grid',
  'git push -u origin hive/MABC123-1-grid --force-with-lease'];

const OTHER_PUSHES = [
  'git push', 'git push origin', 'git push origin main', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main', 'git push origin HEAD',
  `git push origin +HEAD:${BRANCH}`, `git push --force origin HEAD:${BRANCH}`, `git push -f origin HEAD:${BRANCH}`, `git push origin HEAD:${BRANCH} --force`,
  `git push origin HEAD:${BRANCH} -f`, `git push origin HEAD:${BRANCH} HEAD:main`, `git push origin --delete ${BRANCH}`, `git push -u origin ${BRANCH}`,
  `git push origin ${BRANCH}`, `git push origin ${OTHER}`, 'git push origin hive/MABC123-1-grid', 'git push origin HEAD:hive/MABC123-1-grid',
  'git -C . push origin main', `git -C /repo push origin HEAD:${BRANCH}`, 'git -c push.default=current push', 'git --git-dir=.git push origin main',
  'git -C . -c core.fsmonitor=./x status', 'git -C . config alias.p push', 'git -C . --exec-path=/tmp status',
  // pushes and program runs that never write the word push after git (the confirmation review proved each in a scratch repo)
  'git -C . send-pack --force https://example.test/repo.git HEAD:refs/heads/main', 'git -C . http-push https://example.test/repo.git main',
  "git fetch --upload-pack='touch x' origin", 'git -C . fetch --upload-pack=x origin', 'git -C . ls-remote --receive-pack=x origin',
  'git diff --no-index /dev/null /etc/hosts', 'git -C . diff --no-index a b',
];

// The ninth smoke's two Merge stalls: arm A pushed with `2>&1 | tail`, arm B pushed the merge commit by its sha
const OWN_PUSHES = [PUSH, `${PUSH} 2>&1`, `git push origin 310e0a61:${BRANCH}`, `git push origin 310e0a61:${BRANCH} 2>&1`];

test('a run allows its own push in the forms a worker writes it (a redirect, the merge commit by sha), and nothing in the seed allows another (#105)', async () => {
  const { allow, deny } = await workerRules();
  for (const command of OWN_PUSHES) assert.equal(bashDecision(allow, deny, command), 'allow', command);
  assert.deepEqual(allow.filter((r) => r.startsWith('Bash(git push')), [`Bash(git push origin HEAD:${BRANCH}*)`, `Bash(git push origin *:${BRANCH}*)`]);
  assert.deepEqual(runRules(BRANCH, harnessRulePaths({ state: STATE, home: HOME })).allow.filter((r) => r.includes('push')), [`Bash(git push origin HEAD:${BRANCH}*)`, `Bash(git push origin *:${BRANCH}*)`]);
});

test('every other push form a worker could write is denied: options, refspecs to main or another branch, git -C and -c, options after the refspec (#105)', async () => {
  const { allow, deny } = await workerRules();
  for (const command of OTHER_PUSHES) assert.equal(bashDecision(allow, deny, command), 'deny', command);
  assert.notEqual(bashDecision(allow, deny, `git push origin HEAD:${OTHER}`), 'allow', 'the other arm\'s run branch: no rule allows it');
});

test('every command arm A and arm B run is allowed, by the same list in both arms, and the refused ones are denied (#105)', async () => {
  const { allow, deny } = await workerRules();
  for (const command of [...MERGE, ...ARM_A, ...ARM_B]) assert.equal(bashDecision(allow, deny, command), 'allow', command);
  for (const command of REFUSED) assert.equal(bashDecision(allow, deny, command), 'deny', command);
});

// What the first night's workers ran to read the code (arm A stalled on a prompt for `sed -n`, `tr` and `echo`): allowed, so nobody waits
const READING = [
  'grep -n "monitor" docs/glossary.md', 'head -40 src/types.ts', 'tail -5 src/log.ts', "sed -n 176,215p docs/glossary.md", 'wc -l src/server.ts',
  'cat package.json', 'ls docs/superpowers/specs', "echo ----", "tr '\\n' ' '", 'sort -u', 'uniq -c', 'cut -d: -f1', 'diff a.ts b.ts', 'rg -n pin src',
  'cd docs/handoff_monitor', 'pwd', "printf '%s' a", 'basename src/a.ts', 'dirname src/a.ts', 'stat src', 'du -sh src', 'which pnpm', 'date', 'jq .scripts package.json',
  'git ls-tree -r HEAD', 'git ls-files src', 'git grep -n monitor',
];
const WRITING = ["sed -i '' s/a/b/ src/a.ts", 'sed -e s/a/b/ -i src/a.ts', 'find . -name "*.ts" -exec rm {} +', 'find . -delete'];

test('the read-only shell tools the workers run are allowed, and their writing forms are not (#105)', async () => {
  const { allow, deny } = await workerRules();
  for (const command of READING) assert.equal(bashDecision(allow, deny, command), 'allow', command);
  for (const command of WRITING) assert.notEqual(bashDecision(allow, deny, command), 'allow', command);
});

test('a worker reads its home\'s plugin folders and nothing else of the state folder: no experiment, no daemon file of any home (#105)', async () => {
  const { allow, deny } = await workerRules();
  assert.ok(allow.includes(`Read(/${HOME}/plugins/**)`));
  for (const path of [`${HOME}/plugins/hive/reference/conventions.md`, `${HOME}/plugins/hive/skills/new-spec/SKILL.md`]) assert.equal(readDecision(allow, deny, path), 'allow', path);
  const blind = [`${STATE}/experiments/skills-x/manifest.json`, `${STATE}/experiments/skills-x/abc123/metrics.json`, `${HOME}/hive.secret`, `${HOME}/hive.port`,
    ...['hive.secret', 'hive.port', 'hive.config.json', 'hive.log', 'state.json', 'hooks.json', 'daemon.out', 'prompts/MABC-1.md', 'protocol/x', 'reviews/x.json', 'pr-reviews/y.json']
      .map((name) => `${OTHER_HOME}/${name}`)];
  for (const path of blind) assert.equal(readDecision(allow, deny, path), 'deny', path);
});

test('runClaudeArgs adds to the seed\'s two lists, leaves the seed as it was, and refuses a path a rule cannot hold (#105)', () => {
  const seed = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Glob', '--disallowedTools', 'Bash(git push)'];
  const args = runClaudeArgs(seed, BRANCH, harnessRulePaths({ state: STATE, home: HOME }));
  assert.deepEqual(seed, ['--permission-mode', 'acceptEdits', '--allowedTools', 'Glob', '--disallowedTools', 'Bash(git push)']);
  assert.deepEqual([args.length, rulesOf(args, '--allowedTools')[0], rulesOf(args, '--disallowedTools')[0]], [6, 'Glob', 'Bash(git push)']);
  assert.deepEqual(rulesOf(runClaudeArgs([], BRANCH, harnessRulePaths({ state: STATE, home: HOME })), '--allowedTools'), runRules(BRANCH, harnessRulePaths({ state: STATE, home: HOME })).allow);
  for (const state of ['relative/state', '/with space/s', '/glob*/s', '/paren(s)']) assert.throws(() => runRules(BRANCH, harnessRulePaths({ state, home: `${state}/homes/abc123` })), /permission rule/, state);
  assert.throws(() => runRules('feat/x *', harnessRulePaths({ state: STATE, home: HOME })), /permission rule/);
});
