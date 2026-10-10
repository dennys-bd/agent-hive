import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../../src/orchestrator.js';
import { listRepositories, originRepository } from '../../src/repos/repositories.js';
import type { CombConfig, Exec, State, Task, Workspace } from '../../src/types.js';

const workspace = (name: string): Workspace => ({ name, path: `/code/${name}`, env: {}, fork: null });
const COMB: CombConfig = { prefix: 'HIVE', workspaces: ['hive', 'site', 'docs', 'hive2'].map(workspace), sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive' };
// hive2 shares hive's repository; docs lives off GitHub; a path with no checkout makes git fail
const REMOTES: Record<string, string> = {
  '/code/hive': 'git@github.com:acme/hive.git\n', '/code/site': 'https://github.com/acme/site.git\n',
  '/code/docs': 'https://gitlab.com/acme/docs.git\n', '/code/hive2': 'https://github.com/acme/hive\n',
};
const exec: Exec = async (_file, args) => {
  const remote = REMOTES[args[1]];
  if (remote === undefined) throw new Error('not a git repository');
  return { stdout: remote };
};
const task = (n: number, workspaceName: string): Task => ({
  item: { itemId: `board:${n}`, id: String(n), title: `T${n}`, body: '', url: '', source: 'board' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: workspaceName,
});
const pr = (repo: string, n: number, state: 'open' | 'merged' | 'closed') => ({ url: `https://github.com/acme/${repo}/pull/${n}`, state });

test('listRepositories: the origins in the Comb\'s order, then the open PRs\' repositories with their activity\'s workspace, each once (#757)', async () => {
  const state: State = {
    ...initialState(0),
    tasks: [task(1, 'hive'), task(2, 'site')],
    // A1 is live in docs; A2's activity was deleted, so its PRs take its task's workspace
    activities: [{ id: 'A1', kind: 'task', workspace: 'docs' }],
    activityRecords: [
      { id: 'A1', taskIds: ['board:1'], sessions: [], prs: [pr('api', 3, 'open'), pr('old', 1, 'merged'), pr('gone', 2, 'closed'), pr('site', 9, 'open')] },
      { id: 'A2', taskIds: ['board:2'], sessions: [], prs: [pr('web', 5, 'open')] },
    ],
  };
  assert.deepEqual(await listRepositories({ comb: COMB }, state, exec), [
    { repository: 'acme/hive', workspace: 'hive' }, // hive2's origin is the same repository: the first workspace keeps it
    { repository: 'acme/site', workspace: 'site' }, // also an open PR's: listed once
    { repository: 'acme/api', workspace: 'docs' },
    { repository: 'acme/web', workspace: 'site' },
  ]);
});

test('a workspace off GitHub or without a checkout adds none, and originRepository with no path reads nothing (#588, #757)', async () => {
  const comb: CombConfig = { ...COMB, workspaces: [workspace('docs'), workspace('none')] };
  assert.deepEqual(await listRepositories({ comb }, initialState(0), exec), []);
  assert.equal(await originRepository(exec, undefined), undefined);
  assert.equal(await originRepository(exec, '/code/site'), 'acme/site');
});

test('a fork workspace lists its original then its fork where its origin stood, each with its role, its PR target and the other as its pair; a fork whose original is off GitHub lists its origin alone (#854)', async () => {
  const urls: Record<string, string> = {
    '/code/ex upstream': 'https://github.com/ex/excalidraw.git\n', '/code/ex origin': 'git@github.com:me/excalidraw.git\n', '/code/site origin': 'https://github.com/acme/site.git\n',
    '/code/half upstream': 'https://gitlab.com/x/half.git\n', '/code/half origin': 'git@github.com:me/half.git\n',
  };
  const remotes: Exec = async (_file, args) => {
    const url = urls[`${args[1]} ${args.at(-1)}`];
    if (url === undefined) throw new Error('no such remote');
    return { stdout: url };
  };
  const comb: CombConfig = {
    ...COMB,
    workspaces: [{ ...workspace('ex'), fork: { remote: 'upstream', pr: 'original' } }, workspace('site'), { ...workspace('half'), fork: { remote: 'upstream', pr: 'fork', sync: 'manual' } }],
  };
  assert.deepEqual(await listRepositories({ comb }, initialState(0), remotes), [
    { repository: 'ex/excalidraw', workspace: 'ex', role: 'original', pr: 'original', pair: 'me/excalidraw' },
    { repository: 'me/excalidraw', workspace: 'ex', role: 'fork', pr: 'original', pair: 'ex/excalidraw' },
    { repository: 'acme/site', workspace: 'site' },
    { repository: 'me/half', workspace: 'half' },
  ]);
});
