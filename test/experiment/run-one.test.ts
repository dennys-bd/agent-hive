import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { readJson, writeJson } from '../../scripts/experiment/files.js';
import { runHome } from '../../scripts/experiment/plan.js';
import { executeRun, recordFailure, type RunDeps } from '../../scripts/experiment/run-one.js';
import type { Snapshot, WatchClient } from '../../scripts/experiment/watcher.js';
import { failedMetrics } from '../../scripts/experiment/metrics.js';
import { tempDir } from '../temp-dir.js';
import { BRANCH, clock, fakeChild, fakeRun, line, PREFIX, SEED, snap, task, TOKEN } from './fixtures.js';

const NIGHT = new Date('2026-10-01T22:00:00.000Z');

function depsWith(git: ReturnType<typeof fakeRun>, client: WatchClient, events: string[], docs = fakeRun()): RunDeps {
  const time = clock(NIGHT);
  return {
    run: git.run, docs: docs.run, now: time.now, sleep: time.sleep, log: () => undefined,
    boot: async (home, runJs) => { events.push(`boot ${runJs}`); return { home, address: { port: 1, secret: 'x' }, child: fakeChild().child }; },
    stop: async () => { events.push('stop'); },
    client: () => client,
  };
}

function sequence(snapshots: Snapshot[], events: string[]): WatchClient {
  let i = 0;
  return {
    state: async () => { const next = snapshots[Math.min(i, snapshots.length - 1)]; i += 1; return next; },
    setAuto: async (id) => { events.push(`auto ${id}`); },
    setGreen: async () => { events.push('green'); },
  };
}

const context = (root: string, arm: 'a' | 'b', unpaired = false) => ({
  dir: join(root, 'exp'), root, state: join(root, 'state'), baseline: 'base1', docsBaseline: 'docsbase1', token: TOKEN, arm, seed: SEED, runJs: '/dist/src/run.js', timeoutMs: 3_600_000, unpaired,
});
const allDone = snap([task(1, 'Done'), task(2, 'Done'), task(3, 'Done')]);

test('executeRun branches at the baseline, writes the home under <state>/homes/<token>, releases along the blockers and writes <token>/metrics.json (#105)', async (t) => {
  const root = await tempDir(t, 'run-');
  const git = fakeRun((call) => (call.args[0] === 'diff' ? ' 3 files changed, 10 insertions(+), 2 deletions(-)\n' : ''));
  const events: string[] = [];
  const docs = fakeRun();
  const metrics = await executeRun(context(root, 'b'), depsWith(git, sequence([snap([task(1, 'Done'), task(2, 'Spec'), task(3, 'Done')]), allDone], events), events, docs));
  assert.deepEqual(events, ['boot /dist/src/run.js', 'green', 'auto local:2', 'stop']);
  assert.deepEqual([metrics.token, metrics.outcome, metrics.diff, metrics.unpaired], [TOKEN, 'done', { files: 3, insertions: 10, deletions: 2 }, undefined]);
  assert.deepEqual(await readJson(join(root, 'exp', TOKEN, 'metrics.json')), metrics);
  const config = await loadConfig(runHome(join(root, 'state'), TOKEN));
  assert.deepEqual([config.baseBranch, config.comb.prefix], [BRANCH, PREFIX]);
  assert.ok(config.comb.stages[0].prompt?.startsWith('/hive:new-spec'));
  const args = config.agentArgs.claude;
  const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
  for (const rule of [`Bash(git push origin HEAD:${BRANCH}*)`, `Read(/${runHome(join(root, 'state'), TOKEN)}/plugins/**)`]) assert.ok(allowed.includes(rule), rule);
  const order = git.calls.map(line);
  assert.ok(order.includes(`git branch -f ${BRANCH} base1`));
  assert.ok(order.includes(`git branch --list hive/${PREFIX}-* --format=%(refname:short)`), 'cleanup touches only this run prefix');
  assert.deepEqual(docs.calls.map(line), [`git ls-remote --heads origin refs/heads/${BRANCH}`, `git branch -f ${BRANCH} docsbase1`, `git push -u origin ${BRANCH}`, 'git worktree prune'],
    'the docs run branch at the docs baseline, for the setup to branch from (#79); the docs task branches stay for the evaluation');
});

test('executeRun stops the daemon and records an error when the daemon stops answering; a run made alone is unpaired (#105)', async (t) => {
  const root = await tempDir(t, 'run-');
  const events: string[] = [];
  const dead: WatchClient = { state: async () => { throw new Error('ECONNREFUSED'); }, setAuto: async () => undefined, setGreen: async () => undefined };
  const metrics = await executeRun(context(root, 'a', true), depsWith(fakeRun(), dead, events));
  assert.deepEqual([metrics.outcome, metrics.reason, metrics.unpaired], ['error', 'the daemon stopped answering', true]);
  assert.deepEqual(events, ['boot /dist/src/run.js', 'stop']);
});

test('executeRun boots nothing when the branch of its token is already on origin (#105)', async (t) => {
  const root = await tempDir(t, 'run-');
  const events: string[] = [];
  const git = fakeRun((call) => (call.args[0] === 'ls-remote' ? 'def456\tx\n' : ''));
  await assert.rejects(executeRun(context(root, 'a'), depsWith(git, sequence([allDone], events), events)), /already on origin/);
  assert.deepEqual(events, []);
});

test('recordFailure writes error metrics for a run that left none, and keeps the real metrics of one that did (#105)', async (t) => {
  const dir = await tempDir(t, 'fail-');
  await recordFailure(dir, 'aaaaaa', 'boom', false);
  assert.equal((await readJson<{ reason: string }>(join(dir, 'aaaaaa', 'metrics.json')))?.reason, 'boom');
  await mkdir(join(dir, 'bbbbbb'));
  await writeJson(join(dir, 'bbbbbb', 'metrics.json'), failedMetrics('bbbbbb', NIGHT.toISOString(), 'real', false));
  await recordFailure(dir, 'bbbbbb', 'later failure', false);
  assert.equal((await readJson<{ reason: string }>(join(dir, 'bbbbbb', 'metrics.json')))?.reason, 'real');
});
