import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteActivityOnDisk } from '../src/activity-delete.js';
import { createConsoleStore } from '../src/console.js';
import { createPtyHost, NO_PTY } from '../src/pty-host.js';
import { transcriptDir } from '../src/agents/claude-transcript.js';
import type { Activity, DeleteActivityScope, Exec, Task } from '../src/types.js';
import { DELETE_ACTIVITY_DEFAULTS } from '../src/types.js';
import { fakeLog, fakeMachine } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { fakeGitlabApi } from './fake-gitlab.js';

const TASK_SLUG = 'hive-1-from-ready'; // the fake source's task
const TASK_BRANCH = 'hive/1-from-ready'; // what the default template renders for it
const UPSTREAM_FORMAT = '--format=%(upstream)%00%(upstream:track)'; // mergeCheck's read (#660)
const BRANCH = 'hive/1-from-ready';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const AT = '2026-09-27T10:00:00.000Z';
const ALL: DeleteActivityScope = { session: true, transcripts: true, nonAutoTasks: false };

// CLAUDE_CONFIG_DIR for one test: where removeTranscripts looks; the suite runs one file per process, and the value is put back after.
function claudeConfigDir(t: TestContext, dir: string): void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
}

test('deleteActivityOnDisk also checks and deletes the own branches a Restart left behind, before and after the task\'s own, and drops the stage-start ref (#283)', async (t) => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    const command = args.slice(2);
    calls.push(command);
    const listing = command[0] === 'for-each-ref' && command[1] === '--format=%(refname:lstrip=2)';
    return { stdout: listing ? `${TASK_BRANCH}\n${TASK_BRANCH}-r2\n${TASK_BRANCH}-r3\n` : '' };
  };
  const task: Task = {
    item: { itemId: 'board:I1', id: '1', title: 'from Ready', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true,
  };
  const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: TASK_SLUG, branch: `${TASK_BRANCH}-r3`, stageStart: { stage: 'fila', commit: 'a1b2c3d' } }; // #629: the activity's
  const deps = { log: fakeLog().log, exec, machineFor: () => fakeMachine({ exec }), ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000) };
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: await tempDir(t, 'repo-'), env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [], prs: [], branch: TASK_BRANCH, scope: DELETE_ACTIVITY_DEFAULTS }, deps);
  const check = (b: string): string[][] => [['for-each-ref', UPSTREAM_FORMAT, `refs/heads/${b}`], ['merge-base', '--is-ancestor', `refs/heads/${b}`, 'HEAD']];
  assert.deepEqual(calls, [
    ['for-each-ref', '--format=%(refname:lstrip=2)', `refs/heads/${TASK_BRANCH}`, `refs/heads/${TASK_BRANCH}-r*`],
    ...check(TASK_BRANCH), ...check(`${TASK_BRANCH}-r2`),
    ['worktree', 'list', '--porcelain'], ['rev-parse', '--verify', '--quiet', `refs/heads/${TASK_BRANCH}-r3`], ...check(`${TASK_BRANCH}-r3`),
    ['branch', '-d', '--', `${TASK_BRANCH}-r3`],
    ['branch', '-d', '--', TASK_BRANCH], ['branch', '-d', '--', `${TASK_BRANCH}-r2`],
    ['rev-parse', '--verify', '--quiet', `refs/hive/${TASK_SLUG}/stage-start`], ['update-ref', '-d', `refs/hive/${TASK_SLUG}/stage-start`],
    ['for-each-ref', '--format=%(refname)', `refs/hive/${TASK_SLUG}/checkpoint/`], // #619
  ]);
});

test('deleteActivityOnDisk drops the stage-start ref of an activity whose start a stage entry already cleared: the ref never pins a commit after the delete (#812)', async (t) => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args.slice(2));
    return { stdout: '' };
  };
  const task: Task = { item: { itemId: 'board:I1', id: '1', title: 'from Ready', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: TASK_SLUG, branch: TASK_BRANCH }; // entered a stage: no stageStart
  const deps = { log: fakeLog().log, exec, machineFor: () => fakeMachine({ exec }), ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000) };
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: await tempDir(t, 'repo-'), env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [], prs: [], branch: TASK_BRANCH, scope: DELETE_ACTIVITY_DEFAULTS }, deps);
  assert.deepEqual(calls.slice(-3), [['rev-parse', '--verify', '--quiet', `refs/hive/${TASK_SLUG}/stage-start`], ['update-ref', '-d', `refs/hive/${TASK_SLUG}/stage-start`], ['for-each-ref', '--format=%(refname)', `refs/hive/${TASK_SLUG}/checkpoint/`]]);
});

test('deleteActivityOnDisk hands the record\'s PRs to the clean: a branch its merged PR squashed goes at its verified tip, no refusal (#660)', async (t) => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...(file === 'git' ? args.slice(2) : args)]);
    if (file === 'gh') return { stdout: JSON.stringify({ state: 'MERGED', headRefOid: 'c0ffee1' }) };
    if (args.includes('--is-ancestor')) throw Object.assign(new Error('Command failed: git merge-base'), { code: 1 }); // squashed: never an ancestor
    return { stdout: args.includes('rev-parse') ? 'c0ffee1\n' : '' };
  };
  const task: Task = { item: { itemId: 'board:I1', id: '1', title: 'from Ready', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: TASK_SLUG, branch: TASK_BRANCH };
  const deps = { log: fakeLog().log, exec, machineFor: () => fakeMachine({ exec }), ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000) };
  const pr = 'https://github.com/acme/r/pull/7';
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: await tempDir(t, 'repo-'), env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [], prs: [{ url: pr, state: 'merged' }], branch: TASK_BRANCH, scope: DELETE_ACTIVITY_DEFAULTS }, deps);
  assert.deepEqual(calls.filter((c) => c[0] === 'gh'), [['gh', 'pr', 'view', pr, '--json', 'state,headRefOid']]);
  assert.ok(calls.some((c) => c.join(' ') === `git update-ref -d refs/heads/${TASK_BRANCH} c0ffee1`), calls.map((c) => c.join(' ')).join('\n'));
});

test('deleteActivityOnDisk on a local task runs no git whatever the scope and deletes its sessions\' transcripts under the workspace\'s own dir, so the deleteActivity effect answers cleaned (#444)', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const repo = await tempDir(t, 'repo-');
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => { calls.push(args); return { stdout: '' }; };
  const task: Task = {
    item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true,
  };
  const activity: Activity = { id: 'a-I1', kind: 'task', workspace: 'hive', slug: 'hive-1-t', local: true, worktree: repo, branch: BRANCH, stageStart: { stage: 'fila', commit: SHA } }; // #629: the activity's
  const dir = transcriptDir(fakeMachine(), repo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SESSION}.jsonl`), '{}\n');
  const deps = { log: fakeLog().log, exec, machineFor: () => fakeMachine({ exec }), ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000) };
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [{ id: SESSION, startedAt: AT, stages: ['fila'], agent: 'claude', lastUsedAt: AT }], prs: [], branch: BRANCH, scope: ALL }, deps);
  assert.deepEqual(calls, [], 'no worktree, no branch -d, no left-behind branches, no stage-start ref');
  assert.deepEqual(await readdir(dir), []);
});

test('deleteActivityOnDisk reads a merged MR through the deps\' GitLab account with the job\'s hosts: the squashed branch goes at its verified tip (#1053)', async (t) => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...(file === 'git' ? args.slice(2) : args)]);
    if (args.includes('--is-ancestor')) throw Object.assign(new Error('Command failed: git merge-base'), { code: 1 }); // squashed: never an ancestor
    return { stdout: args.includes('rev-parse') ? 'c0ffee1\n' : '' };
  };
  const { api, calls: asked } = fakeGitlabApi({ 'GET projects/acme%2Fr/merge_requests/7': { state: 'merged', sha: 'c0ffee1' } });
  const task: Task = { item: { itemId: 'board:I1', id: '1', title: 'from Ready', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: TASK_SLUG, branch: TASK_BRANCH };
  const deps = { log: fakeLog().log, exec, machineFor: () => fakeMachine({ exec }), ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000), gitlabAccess: async (host: string) => (host === 'git.example.com' ? api : undefined) };
  const mr = 'https://git.example.com/acme/r/-/merge_requests/7';
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: await tempDir(t, 'repo-'), env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [], prs: [{ url: mr, state: 'merged' }], branch: TASK_BRANCH, scope: DELETE_ACTIVITY_DEFAULTS, gitlabHosts: ['git.example.com'] }, deps);
  assert.deepEqual([calls.filter((c) => c[0] === 'gh'), asked.length], [[], 1]);
  assert.ok(calls.some((c) => c.join(' ') === `git update-ref -d refs/heads/${TASK_BRANCH} c0ffee1`), calls.map((c) => c.join(' ')).join('\n'));
});
