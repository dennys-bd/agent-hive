import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { activityOf, resultOf } from '../src/activities.js';
import { AGENTS } from '../src/agents.js';
import { parseConfig } from '../src/config.js';
import { PATCH_MAX } from '../src/evaluate-prompt.js';
import { initialState } from '../src/orchestrator.js';
import { createEvaluateRunner, type EvaluateRunner } from '../src/server-evaluate.js';
import { createServer, type Runtime } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import type { Activity, AgentAvailability, AgentId, Effect, EvaluateRow, Exec, HiveEvent, Stage, StageEvaluate, Task } from '../src/types.js';
import { combConfig, tempHive } from './fakes.js';
import { send, settingsBody } from './review-server.js';
import { SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// An evaluate stage on the server (#877): the runner alone over a real git worktree and a fake agent CLI first on PATH (no real claude or
// codex ever runs), then the Stop route through a server.

const git: Exec = promisify(execFile);
const ALL: AgentAvailability[] = [{ agent: 'claude', available: true }, { agent: 'codex', available: true }];
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Task 1', body: 'the body', url: '' }, stage: 'eval', boardColumn: '', auto: true, workspace: 'hive' };
const RUBRIC = 'Meets {id}?\nTests cover it?';
const stageOf = (reviewers: EvaluateRow[], judge: EvaluateRow = { agent: 'claude' }): Stage => ({ name: 'eval', from: {}, action: 'evaluate', reviewers, judge, threshold: 7, rubric: RUBRIC });
const scoresJson = (scores: number[]): string => JSON.stringify({ scores: scores.map((score, i) => ({ dimension: `d${i}`, score, evidence: 'a.ts:3' })) });

// One script per agent: the prompt on stdin, branching on its focus line. Claude prints its result object; Codex writes the answer to -o
const SCRIPT = `prompt="$(cat)"
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
answer() { if [ -n "$out" ]; then printf '%s' "$1" > "$out"; else printf '{"type":"result","is_error":false,"result":"","structured_output":%s}' "$1"; fi; }
focus="$(printf '%s\\n' "$prompt" | sed -n 's/^Your focus: //p')"
case "$focus" in
  slow*) pwd > "$LOG/$focus.start.pwd"; touch "$LOG/$focus.start"; i=0
    while [ "$(ls "$LOG" | grep -c '\\.start$')" -lt 2 ]; do i=$((i+1)); [ $i -gt 600 ] && exit 1; sleep 0.1; done
    answer "{\\"findings\\":[{\\"file\\":\\"a.ts\\",\\"line\\":3,\\"finding\\":\\"$focus\\"}]}" ;;
  broken) i=0; while [ ! -e "$LOG/hang.start" ]; do i=$((i+1)); [ $i -gt 600 ] && exit 1; sleep 0.1; done; answer 'not json' ;;
  hang*) echo $$ > "$LOG/$focus.pid"; touch "$LOG/$focus.start"; exec sleep 120 ;;
  "") printf '%s' "$prompt" > "$LOG/judge.prompt"; answer "$SCORES" ;;
esac`;

async function fakeClis(t: TestContext, extra: Record<string, string>): Promise<{ env: NodeJS.ProcessEnv; tmpRoot: string; log: string }> {
  const bin = await tempDir(t, 'evaluate-bin-');
  for (const agent of ['claude', 'codex'] as AgentId[]) {
    const file = join(bin, AGENTS[agent].command);
    await writeFile(file, `#!/bin/sh\n${SCRIPT}\n`);
    await chmod(file, 0o755);
  }
  const log = await tempDir(t, 'evaluate-log-');
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, LOG: log, ...extra }, tmpRoot: await tempDir(t, 'evaluate-tmp-'), log };
}

// A repo whose main has a.ts and whose work branch, checked out in its own worktree, is one commit ahead
async function worldOf(t: TestContext, added = 'export const b = 2;\n'): Promise<{ repo: string; worktree: string }> {
  const repo = await tempDir(t, 'evaluate-repo-');
  const worktree = join(await tempDir(t, 'evaluate-wt-'), 'wt');
  const commit = (cwd: string, message: string) => git('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', message]);
  await git('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
  await git('git', ['-C', repo, 'add', 'a.ts']);
  await commit(repo, 'main');
  await git('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'work', worktree]);
  await writeFile(join(worktree, 'a.ts'), `export const a = 1;\n${added}`);
  await commit(worktree, 'work');
  return { repo, worktree };
}

interface Harness {
  runner: EvaluateRunner; runtime: Runtime; worktree: string; events: HiveEvent[]; prepared: string[]; logs: string[]; log: string;
  effect(reviewers: EvaluateRow[], judge?: EvaluateRow): Extract<Effect, { type: 'evaluate' }>;
  read(name: string): Promise<string>;
  drop(): void; // current() answers no mark from now on
}

interface Options { env?: Record<string, string>; agents?: AgentAvailability[]; added?: string; onPrepare?: () => void }
async function harness(t: TestContext, { env = {}, agents = ALL, added, onPrepare }: Options = {}): Promise<Harness> {
  const { repo, worktree } = await worldOf(t, added);
  const cli = await fakeClis(t, env);
  const plugin = await tempDir(t, 'evaluate-plugin-');
  await mkdir(join(plugin, 'agents')); // empty: no specialized agent at all
  const mark: StageEvaluate = { stage: 'eval', runId: 'R1', workerId: 'w1', startedAt: '2026-10-21T12:00:00.000Z', phase: 'reviewing' };
  const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', base: { ref: 'main', tellWorker: false }, evaluate: mark };
  let isDropped = false;
  const h: Pick<Harness, 'events' | 'prepared' | 'logs'> = { events: [], prepared: [], logs: [] };
  const runner = createEvaluateRunner({
    exec: git, agents,
    log: { info: (line) => h.logs.push(line), warn: (line) => h.logs.push(line) },
    dispatch: async (event) => { h.events.push(event); return []; },
    prepare: async (_r, _a, _t, key) => { h.prepared.push(key); onPrepare?.(); return worktree; },
    current: () => (isDropped ? undefined : mark),
    pluginDir: async () => plugin,
    headless: { env: cli.env, tmpRoot: cli.tmpRoot, timeoutMs: 60_000 }, // generous: the whole suite runs in parallel
  });
  const runtime: Runtime = {
    config: parseConfig(combConfig({ stages: [stageOf([])], workspaces: [{ name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] })),
    sources: new Map(), hooksPath: '/hive/hooks.json', promptsDir: '/hive/prompts', protocol: { stage: '/hive/stage.md', session: '/hive/session.md', local: '/hive/local.md' }, port: 4321,
  };
  return {
    ...h, runner, runtime, worktree, log: cli.log,
    effect: (reviewers, judge) => ({ type: 'evaluate', activity, task: TASK, stage: stageOf(reviewers, judge), runId: 'R1' }),
    read: (name) => readFile(join(cli.log, name), 'utf8'),
    drop: () => { isDropped = true; },
  };
}

const lastOf = (h: Harness): HiveEvent | undefined => h.events.at(-1);
const brokenText = (h: Harness): string => {
  const last = lastOf(h);
  assert.equal(last?.type, 'evaluateBroken', JSON.stringify(h.events));
  return (last as Extract<HiveEvent, { type: 'evaluateBroken' }>).message;
};
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 500; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(20);
  }
  return false;
}
const pidOf = async (h: Harness, focus: string): Promise<number> => Number((await h.read(`${focus}.pid`)).trim());
async function waitFor(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 3000 && !(await check()); i += 1) await sleep(10);
  assert.ok(await check(), 'condition not met in time');
}
const exists = (h: Harness, name: string) => async (): Promise<boolean> => h.read(name).then(() => true, () => false);

test('both reviewers run at once in the worktree, read-only; then evaluateJudging; then the judge with their findings and the numbered rubric; then evaluateEnded (#877)', async (t) => {
  const h = await harness(t, { env: { SCORES: scoresJson([8, 9]) } });
  await h.runner.run(h.runtime, h.effect([{ agent: 'claude', focus: 'slow' }, { agent: 'codex', focus: 'slow2' }]));
  assert.deepEqual(h.events.map((e) => e.type), ['worktreeReady', 'evaluateJudging', 'evaluateEnded']);
  assert.deepEqual(h.prepared, ['R1'], 'the worktree is keyed by the run id, which abortEvaluate names');
  const ended = lastOf(h) as Extract<HiveEvent, { type: 'evaluateEnded' }>;
  assert.deepEqual(ended.scores.map((s) => [s.dimension, s.score]), [['Meets HIVE-1?', 8], ['Tests cover it?', 9]], 'named by the rendered rubric');
  assert.deepEqual(ended.findings.map((f) => f.finding), ['slow', 'slow2']);
  assert.equal(await realpath((await h.read('slow.start.pwd')).trim()), await realpath(h.worktree), 'in the worktree');
  const judge = await h.read('judge.prompt');
  assert.match(judge, /1\. Meets HIVE-1\?\n2\. Tests cover it\?/);
  assert.match(judge, /reviewer 1 \(claude\) · slow\n- a\.ts:3 slow/);
  assert.match(judge, /reviewer 2 \(codex\) · slow2\n- a\.ts:3 slow2/);
  assert.match(judge, /^diff --git a\/a\.ts b\/a\.ts/m, 'the patch against the activity\'s base');
  assert.ok(h.logs.includes('evaluate #HIVE-1: scores 8,9 against 7: below: none'), h.logs.join('\n'));
  assert.ok(h.logs.every((line) => !line.includes('a.ts') && !line.includes('diff --git')), 'no finding nor patch in the log');
});

test('zero reviewers: the judge reads the work alone; a failing score is logged by its index, never its text; a line rendering empty stays raw (#877)', async (t) => {
  const h = await harness(t, { env: { SCORES: scoresJson([8, 3]) } });
  const effect = h.effect([]);
  await h.runner.run(h.runtime, { ...effect, stage: { ...effect.stage, rubric: 'Meets {id}?\n{url}' } });
  assert.deepEqual(h.events.map((e) => e.type), ['worktreeReady', 'evaluateJudging', 'evaluateEnded']);
  assert.match(await h.read('judge.prompt'), /No reviewer ran: read the work yourself\./);
  assert.ok(h.logs.includes('evaluate #HIVE-1: scores 8,3 against 7: below: 2'), h.logs.join('\n'));
  const ended = lastOf(h) as Extract<HiveEvent, { type: 'evaluateEnded' }>;
  assert.deepEqual(ended.scores.map((s) => s.dimension), ['Meets HIVE-1?', '{url}'], 'an empty render falls back to the raw line');
});

test('a patch past PATCH_MAX reaches the judge cut, with the line saying so (#877)', async (t) => {
  const h = await harness(t, { env: { SCORES: scoresJson([8, 9]) }, added: `${'x'.repeat(70_000)}\n` });
  await h.runner.run(h.runtime, h.effect([]));
  const judge = await h.read('judge.prompt');
  assert.match(judge, new RegExp(`\\n\\[patch cut at ${PATCH_MAX} characters: read the files for the rest\\]`));
  assert.ok(judge.length < PATCH_MAX + 5_000);
});

test('one reviewer\'s refused answer breaks the stage naming it, and aborts the other; no judge runs (#877)', async (t) => {
  const h = await harness(t, { env: { SCORES: scoresJson([8, 9]) } });
  const ran = h.runner.run(h.runtime, h.effect([{ agent: 'claude', focus: 'hang' }, { agent: 'codex', focus: 'broken' }]));
  await waitFor(exists(h, 'hang.pid')); // the hang started before its sibling's answer could abort it
  await ran;
  assert.match(brokenText(h), /^reviewer 2 \(codex\): not JSON$/);
  assert.equal(h.events.some((e) => e.type === 'evaluateJudging'), false);
  assert.equal(await exists(h, 'judge.prompt')(), false);
  assert.ok(await gone(await pidOf(h, 'hang')), 'the hang\'s sleep died with its group');
});

test('a judge with a wrong score count breaks the stage naming it (#877)', async (t) => {
  const h = await harness(t, { env: { SCORES: scoresJson([8]) } });
  await h.runner.run(h.runtime, h.effect([]));
  assert.equal(brokenText(h), 'judge (claude): 1 scores for 2 dimensions');
  assert.equal(h.events.some((e) => e.type === 'evaluateJudging'), true, 'the judge did run');
});

test('an agent off PATH and a lost specialized agent each break the stage before any git (#877)', async (t) => {
  const off = await harness(t, { agents: [{ agent: 'claude', available: true }, { agent: 'codex', available: false }] });
  await off.runner.run(off.runtime, off.effect([{ agent: 'codex', focus: 'slow' }]));
  assert.equal(brokenText(off), 'reviewer 1 (codex): agent codex is not on PATH: install it, then restart the Hive');
  assert.deepEqual([off.prepared, off.events.length], [[], 1]);
  const lost = await harness(t);
  await lost.runner.run(lost.runtime, lost.effect([{ agent: 'claude', focus: 'slow' }], { agent: 'claude', specializedAgent: 'hive:nobody' }));
  assert.equal(brokenText(lost), 'judge (claude): specialized agent hive:nobody is no longer in the Hive plugin');
  assert.deepEqual([lost.prepared, lost.events.length], [[], 1]);
});

test('abort(runId) stops every child and dispatches nothing after (#877)', async (t) => {
  const h = await harness(t);
  const ran = h.runner.run(h.runtime, h.effect([{ agent: 'claude', focus: 'hang' }, { agent: 'codex', focus: 'hang2' }]));
  await waitFor(async () => (await exists(h, 'hang.pid')()) && exists(h, 'hang2.pid')());
  h.runner.abort('R1');
  await ran;
  assert.deepEqual(h.events.map((e) => e.type), ['worktreeReady']);
  assert.ok(await gone(await pidOf(h, 'hang')));
  assert.ok(await gone(await pidOf(h, 'hang2')));
});

test('abortAll() stops a run too, and a run whose mark is gone after the worktree runs nothing (#877)', async (t) => {
  const all = await harness(t);
  const ran = all.runner.run(all.runtime, all.effect([{ agent: 'claude', focus: 'hang' }]));
  await waitFor(exists(all, 'hang.pid'));
  all.runner.abortAll();
  await ran;
  assert.deepEqual(all.events.map((e) => e.type), ['worktreeReady']);
  assert.ok(await gone(await pidOf(all, 'hang')));
  let h: Harness | undefined;
  h = await harness(t, { onPrepare: () => h?.drop() });
  await h.runner.run(h.runtime, h.effect([{ agent: 'claude', focus: 'slow' }]));
  assert.deepEqual(h.events, []);
  assert.equal(await exists(h, 'slow.start')(), false, 'no reviewer started');
});

test('POST /activities/:id/evaluate/stop ends the evaluation, stopped, with no verdict, its worker freed; an activity with none answers 404 (#877)', async (t) => {
  const { home, repo } = await tempHive(t);
  const local: Task = { ...TASK, auto: false, created: true };
  await saveState(home, { ...initialState(1), localCount: 1, tasks: [local] });
  const exec: Exec = (file) => (file === 'git' ? new Promise(() => undefined) : Promise.resolve({ stdout: '' })); // the evaluation stays in its worktree step
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(base, 'POST', '/settings', settingsBody(repo, [stageOf([{ agent: 'claude', focus: 'slow' }]), { name: 'review', from: {} }]))).status, 200);
  await server.dispatch({ type: 'start', itemId: 'local:1' });
  const activity = activityOf(server.getState()!, 'local:1');
  assert.ok(activity?.evaluate, 'the evaluation runs');
  assert.ok(server.getState()!.workers.some((w) => w.status !== 'empty'), 'it holds a worker');
  const path = `/activities/${encodeURIComponent(activity.id)}/evaluate/stop`;
  assert.equal((await send(base, 'POST', path)).status, 200);
  const after = activityOf(server.getState()!, 'local:1');
  assert.deepEqual([after?.evaluate, after?.stopped, resultOf(server.getState()!, 'local:1')?.evaluate], [undefined, true, undefined]);
  assert.ok(server.getState()!.workers.every((w) => w.status === 'empty'), 'its worker freed');
  const again = await send(base, 'POST', path);
  assert.deepEqual([again.status, await again.json()], [404, { error: 'nenhuma avaliação nessa atividade' }]);
});
