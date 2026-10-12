import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyNotice, countMessages, noticeSide, readBranch, sourceSide, targetSide, trustedCopies, uncommitted } from '../src/copy-sides.js';
import { initialState } from '../src/orchestrator.js';
import type { Activity, Task, Config, Exec, Worker, State } from '../src/types.js';
import { transcriptDir } from '../src/usage.js';
import { worktreePath } from '../src/worktree.js';
import { localActivityId } from '../src/activities.js';
import { tempDir } from './temp-dir.js';
import { activityIdOf, withLocal, withWork } from './fixtures/work.js';

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const config: Pick<Config, 'comb'> = { comb: { prefix: 'HIVE', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }], sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive' } };
const task = (n: number, extra: Partial<Task> = {}): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `task ${n}`, body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true, workspace: 'hive', created: true, ...extra,
});
// Task n's activity (#629): slug hive-<n>, its worktree on disk unless `live` says otherwise, and what its record holds
const on = (s: State, n: number, live: Partial<Activity> = {}, made: Parameters<typeof withWork>[3] = {}): State =>
  withWork(s, `local:${n}`, { slug: `hive-${n}`, worktree: worktreePath('/repo', `hive-${n}`), ...live }, made);
const state = (tasks: Task[], extra: Partial<State> = {}): State =>
  tasks.reduce((acc, c) => on(acc, Number(c.item.itemId.split(':')[1])), { ...initialState(0), workspaces: ['hive'], tasks, ...extra });
const listed = { id: ID, startedAt: '', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '' };

test('sourceSide: a worktree session is looked for in its worktree\'s dir, a repo one in the worktree\'s then the main repo\'s and runs in the main repo, a local one in the checkout; refusals name the unknown task, workspace or session (#587)', () => {
  const worktree = worktreePath('/repo', 'hive-1');
  assert.deepEqual(sourceSide(on(state([task(1)]), 1, {}, { sessions: [listed] }), config, { activityId: activityIdOf('local:1'), sessionId: ID }),
    { session: listed, side: { cwd: worktree, onDisk: true, transcriptCwds: [worktree], label: 'task HIVE-1 (task 1)' } });
  const repo = { ...listed, repo: true as const };
  assert.deepEqual(sourceSide(on(state([task(1)]), 1, { worktree: undefined }, { sessions: [repo] }), config, { activityId: activityIdOf('local:1'), sessionId: ID }),
    { session: repo, side: { cwd: '/repo', onDisk: true, transcriptCwds: [worktree, '/repo'], label: 'task HIVE-1 (task 1)' } });
  const local = { ...listed, stages: [] };
  assert.deepEqual(sourceSide(withLocal(state([]), 'hive', [local]), config, { activityId: localActivityId('hive'), sessionId: ID }),
    { session: local, side: { cwd: '/repo', onDisk: true, transcriptCwds: ['/repo'], label: 'the local checkout of hive' } });
  assert.deepEqual(sourceSide(state([]), config, { activityId: 'nope', sessionId: ID }), { status: 404, message: 'atividade desconhecida' }); // #629: no record has that id
  assert.deepEqual(sourceSide(withLocal(state([]), 'site', [local]), config, { activityId: localActivityId('site'), sessionId: ID }), { status: 404, message: 'workspace desconhecido' });
  assert.deepEqual(sourceSide(state([task(1)]), config, { activityId: activityIdOf('local:1'), sessionId: ID }), { status: 409, message: 'sessão desconhecida' });
});

test('targetSide: a task with a directory, or a workspace\'s checkout; the source\'s own end, a task with no directory and an unknown workspace are refused (#587)', () => {
  const s = withLocal(withLocal(on(state([task(1), task(2)]), 2, { worktree: undefined }), 'hive'), 'site'); // #629: a target is a live activity
  const from = { activityId: activityIdOf('local:1'), sessionId: ID };
  assert.deepEqual(targetSide(s, config, { activityId: localActivityId('hive') }, from), { cwd: '/repo', onDisk: true, transcriptCwds: ['/repo'], label: 'the local checkout of hive' });
  assert.deepEqual(targetSide(s, config, { activityId: activityIdOf('local:1') }, from), { status: 409, message: 'a sessão já está aqui' });
  assert.deepEqual(targetSide(s, config, { activityId: activityIdOf('local:2') }, from), { status: 409, message: 'esta atividade não tem diretório' });
  assert.deepEqual(targetSide(s, config, { activityId: localActivityId('site') }, from), { status: 404, message: 'workspace desconhecido' });
  assert.deepEqual(targetSide(s, config, { activityId: 'nope' }, from), { status: 404, message: 'atividade desconhecida' });
});

test('readBranch and uncommitted read git through exec with argv arrays; a failure reads as no branch and no change (#587)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: args.includes('status') ? ' M a.ts\n?? b.ts\n' : 'feature/x\n' };
  };
  assert.deepEqual([await readBranch('/w', exec), await uncommitted('/w', exec)], ['feature/x', 2]);
  assert.deepEqual(calls, [['git', '-C', '/w', 'branch', '--show-current'], ['git', '-C', '/w', 'status', '--porcelain']]);
  const failing: Exec = async () => { throw new Error('not a repo'); };
  assert.deepEqual([await readBranch('/w', failing), await uncommitted('/w', failing)], [null, 0]);
});

test('countMessages counts the user\'s prompts and each assistant message once, not tool results nor metadata; copyNotice is the fixed English template (#587)', async (t) => {
  const path = join(await tempDir(t, 'transcript-'), `${ID}.jsonl`);
  const lines = [
    { type: 'user', message: { content: 'hi' } }, { type: 'assistant', message: { id: 'm1', content: [] } }, { type: 'assistant', message: { id: 'm1', content: [] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } }, { type: 'custom-title', customTitle: 'x' },
  ];
  await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
  assert.equal(await countMessages(path), 2);
  const from = noticeSide({ cwd: '/repo/.hive/worktrees/hive-1', onDisk: true, transcriptCwds: [], label: 'task HIVE-1 (task 1)' }, 'hive/HIVE-1');
  const to = noticeSide({ cwd: '/repo', onDisk: true, transcriptCwds: [], label: 'the local checkout of hive' }, null);
  assert.equal(copyNotice(from, to), [
    'Hive: this conversation was copied from task HIVE-1 (task 1), branch hive/HIVE-1, directory /repo/.hive/worktrees/hive-1. It now continues in the local checkout of hive, branch (detached), directory /repo.',
    '',
    'Only the conversation came along: the files, the branch and the uncommitted changes it mentions stayed where they were. Read the code here before relying on what was said about it.',
  ].join('\n'));
});

test('trustedCopies keeps a saved copy mark only when its dir is the transcript dir of its own worker\'s task or workspace, and never one naming the worker\'s own session (#587)', () => {
  const NEW = 'b1b2c3d4-0000-4000-8000-000000000002';
  const mark = (id: string, owner: Partial<Worker>, dir: string): Worker => ({ id, status: 'working', runId: ID, sessionId: NEW, freeSession: true, ...owner, copyOf: { from: ID, dir } });
  const own = transcriptDir(worktreePath('/repo', 'hive-1'));
  const workers = [
    mark('a', { activityId: activityIdOf('local:1') }, own), mark('b', { activityId: localActivityId('hive') }, transcriptDir('/repo')),
    mark('c', { activityId: activityIdOf('local:1') }, transcriptDir('/repo')), mark('d', { activityId: localActivityId('hive') }, '/Users/someone/.ssh'),
    mark('e', { activityId: activityIdOf('nope') }, own), mark('f', { activityId: localActivityId('site') }, transcriptDir('/repo')),
    mark('g', { activityId: activityIdOf('local:1'), sessionId: ID }, own),
  ];
  const trusted = trustedCopies(withLocal(state([task(1)], { workers }), 'hive'), config); // #629: the activities the workers point at
  assert.deepEqual(trusted.workers.map((s) => s.copyOf?.dir), [own, transcriptDir('/repo'), undefined, undefined, undefined, undefined, undefined]);
  assert.equal(workers[2].copyOf?.dir, transcriptDir('/repo'), 'the input is not mutated');
});
