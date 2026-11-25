import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { initialState } from '../../src/orchestrator.js';
import { githubRefs, listRepositories, originRepository } from '../../src/repos/repositories.js';
import type { CombConfig, Exec, State, Task, Workspace } from '../../src/types.js';
import { NOT_SUPPORTED, unavailableMachine } from '../../src/machines.js';
import { fakeMachine } from '../fake-machine.js';

const workspace = (name: string): Workspace => ({ name, path: `/code/${name}`, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' });
const COMB: CombConfig = { prefix: 'HIVE', workspaces: ['hive', 'site', 'docs', 'hive2'].map(workspace), sources: [], flows: [], commands: [], hiveSource: true, createIn: 'hive' };
// hive2 shares hive's repository; docs lives on a host of no kind; a path with no checkout makes git fail
const REMOTES: Record<string, string> = {
  '/code/hive': 'git@github.com:acme/hive.git\n', '/code/site': 'https://github.com/acme/site.git\n',
  '/code/docs': 'https://code.example.org/acme/docs.git\n', '/code/hive2': 'https://github.com/acme/hive\n',
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
// Each remote by `<checkout> <remote name>`, as git remote get-url asks for it
const remotesOf = (urls: Record<string, string>): Exec => async (_file, args) => {
  const url = urls[`${args[1]} ${args.at(-1)}`];
  if (url === undefined) throw new Error('no such remote');
  return { stdout: url };
};

test('listRepositories: the origins in the Comb\'s order, then the open PRs\' repositories with their activity\'s workspace, each once by host and path (#757, #1045)', async () => {
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
  assert.deepEqual(await listRepositories({ comb: COMB, gitlabHosts: [] }, state, () => fakeMachine({ exec })), [
    { host: 'github.com', repository: 'acme/hive', workspace: 'hive' }, // hive2's origin is the same repository: the first workspace keeps it
    { host: 'github.com', repository: 'acme/site', workspace: 'site' }, // also an open PR's: listed once
    { host: 'github.com', repository: 'acme/api', workspace: 'docs' },
    { host: 'github.com', repository: 'acme/web', workspace: 'site' },
  ]);
});

test('a workspace on a host of no kind or without a checkout adds none, and originRepository with no path reads nothing (#588, #757, #1045)', async () => {
  const comb: CombConfig = { ...COMB, workspaces: [workspace('docs'), workspace('none')] };
  assert.deepEqual(await listRepositories({ comb, gitlabHosts: [] }, initialState(0), () => fakeMachine({ exec })), []);
  assert.equal(await originRepository(fakeMachine({ exec }), undefined), undefined);
  assert.equal(await originRepository(fakeMachine({ exec }), '/code/site'), 'acme/site');
});

test('a fork workspace lists its original then its fork where its origin stood, each with its role, its PR target and the other\'s repoKey as its pair; a fork with a remote on GitLab lists its origin alone (#854, #1045)', async () => {
  const remotes = remotesOf({
    '/code/ex upstream': 'https://github.com/ex/excalidraw.git\n', '/code/ex origin': 'git@github.com:me/excalidraw.git\n', '/code/site origin': 'https://github.com/acme/site.git\n',
    '/code/half upstream': 'https://gitlab.com/x/half.git\n', '/code/half origin': 'git@github.com:me/half.git\n',
    '/code/lab upstream': 'https://github.com/x/lab.git\n', '/code/lab origin': 'git@gitlab.com:me/lab.git\n',
  });
  const comb: CombConfig = {
    ...COMB,
    workspaces: [
      { ...workspace('ex'), fork: { remote: 'upstream', pr: 'original' } }, workspace('site'), { ...workspace('half'), fork: { remote: 'upstream', pr: 'fork', sync: 'manual' } },
      { ...workspace('lab'), fork: { remote: 'upstream', pr: 'original' } },
    ],
  };
  assert.deepEqual(await listRepositories({ comb, gitlabHosts: [] }, initialState(0), () => fakeMachine({ exec: remotes })), [
    { host: 'github.com', repository: 'ex/excalidraw', workspace: 'ex', role: 'original', pr: 'original', pair: 'github.com/me/excalidraw' },
    { host: 'github.com', repository: 'me/excalidraw', workspace: 'ex', role: 'fork', pr: 'original', pair: 'github.com/ex/excalidraw' },
    { host: 'github.com', repository: 'acme/site', workspace: 'site' },
    { host: 'github.com', repository: 'me/half', workspace: 'half' },
    { host: 'gitlab.com', repository: 'me/lab', workspace: 'lab' }, // its origin on GitLab: a plain row (decision 5)
  ]);
});

test('a nested repo follows its workspace\'s repositories, role nested, paired with the repoKey of the workspace\'s repository (a fork\'s original); one on GitLab lists with its host, one on a host of no kind or with no checkout adds none (#653, #1045, decision 3)', async () => {
  const remotes = remotesOf({
    '/code/hive origin': 'git@github.com:acme/hive.git\n', [`${join('/code/hive', 'docs')} origin`]: 'https://github.com/acme/docs.git\n', [`${join('/code/hive', 'ee')} origin`]: 'https://gitlab.com/acme/ee.git\n',
    [`${join('/code/hive', 'far')} origin`]: 'https://code.example.org/acme/far.git\n',
    '/code/ex upstream': 'https://github.com/ex/excalidraw.git\n', '/code/ex origin': 'git@github.com:me/excalidraw.git\n', [`${join('/code/ex', 'docs')} origin`]: 'https://github.com/me/ex-docs.git\n',
  });
  const comb: CombConfig = {
    ...COMB,
    workspaces: [{ ...workspace('hive'), nestedRepos: ['docs', 'ee', 'far', 'gone'] }, { ...workspace('ex'), fork: { remote: 'upstream', pr: 'original' }, nestedRepos: ['docs'] }],
  };
  assert.deepEqual(await listRepositories({ comb, gitlabHosts: [] }, initialState(0), () => fakeMachine({ exec: remotes })), [
    { host: 'github.com', repository: 'acme/hive', workspace: 'hive' },
    { host: 'github.com', repository: 'acme/docs', workspace: 'hive', role: 'nested', pair: 'github.com/acme/hive' },
    { host: 'gitlab.com', repository: 'acme/ee', workspace: 'hive', role: 'nested', pair: 'github.com/acme/hive' },
    { host: 'github.com', repository: 'ex/excalidraw', workspace: 'ex', role: 'original', pr: 'original', pair: 'github.com/me/excalidraw' },
    { host: 'github.com', repository: 'me/excalidraw', workspace: 'ex', role: 'fork', pr: 'original', pair: 'github.com/ex/excalidraw' },
    { host: 'github.com', repository: 'me/ex-docs', workspace: 'ex', role: 'nested', pair: 'github.com/ex/excalidraw' },
  ]);
});

test('a GitLab origin and a GitLab nested repo on a listed host list with their host and full path; one path on github.com and gitlab.com lists twice (#1045, decisions 1, 2, 4)', async () => {
  const urls: Record<string, string> = {
    '/code/hive': 'git@github.com:acme/hive.git\n', '/code/lab': 'https://gitlab.com/acme/hive.git\n',
    '/code/site': 'git@git.example.com:acme/platform/site.git\n', [join('/code/site', 'docs')]: 'https://git.example.com/acme/platform/docs.git\n',
    '/code/other': 'https://code.example.org/acme/other.git\n',
  };
  const remotes: Exec = async (_file, args) => ({ stdout: urls[String(args[1])] ?? '' });
  const comb: CombConfig = { ...COMB, workspaces: [workspace('hive'), workspace('lab'), { ...workspace('site'), nestedRepos: ['docs'] }, workspace('other')] };
  assert.deepEqual(await listRepositories({ comb, gitlabHosts: ['git.example.com'] }, initialState(0), () => fakeMachine({ exec: remotes })), [
    { host: 'github.com', repository: 'acme/hive', workspace: 'hive' },
    { host: 'gitlab.com', repository: 'acme/hive', workspace: 'lab' },
    { host: 'git.example.com', repository: 'acme/platform/site', workspace: 'site' },
    { host: 'git.example.com', repository: 'acme/platform/docs', workspace: 'site', role: 'nested', pair: 'git.example.com/acme/platform/site' },
  ]);
});

test('an open PR of a record lists its repository by its link: an MR on a listed host with its host, one on an unlisted host none (#1045, decision 4)', async () => {
  const state: State = {
    ...initialState(0), tasks: [task(1, 'hive')], activities: [{ id: 'A1', kind: 'task', workspace: 'hive' }],
    activityRecords: [{
      id: 'A1', taskIds: ['board:1'], sessions: [],
      prs: [{ url: 'https://git.example.com/acme/platform/app/-/merge_requests/3', state: 'open' }, { url: 'https://code.example.org/acme/app/-/merge_requests/4', state: 'open' }, pr('api', 3, 'open')],
    }],
  };
  assert.deepEqual(await listRepositories({ comb: { ...COMB, workspaces: [] }, gitlabHosts: ['git.example.com'] }, state, () => fakeMachine({ exec })), [
    { host: 'git.example.com', repository: 'acme/platform/app', workspace: 'hive' },
    { host: 'github.com', repository: 'acme/api', workspace: 'hive' },
  ]);
});

test('githubRefs keeps the refs on github.com: what the read loop syncs and hive_pr\'s preload matches (#1045, decision 10)', () => {
  const refs = [{ host: 'github.com', repository: 'acme/hive', workspace: 'hive' }, { host: 'gitlab.com', repository: 'acme/hive', workspace: 'lab' }];
  assert.deepEqual(githubRefs(refs), [refs[0]]);
});

test('a nested repo\'s checkout is joined with the machine\'s paths: a win32 machine asks git in C:\\code\\hive\\docs on every OS (#929)', async () => {
  const asked: string[] = [];
  const winExec: Exec = async (_file, args) => {
    asked.push(String(args[1]));
    return { stdout: 'git@github.com:acme/hive.git\n' };
  };
  const comb: CombConfig = { ...COMB, workspaces: [{ ...workspace('hive'), path: 'C:\\code\\hive', nestedRepos: ['docs'] }] };
  await listRepositories({ comb, gitlabHosts: [] }, initialState(0), () => fakeMachine({ exec: winExec, info: { platform: 'win32' } }));
  assert.deepEqual(asked, ['C:\\code\\hive', 'C:\\code\\hive\\docs']);
});

test('each workspace lists its repositories from its own machine; one on an unavailable machine lists none and the others still answer (#932)', async () => {
  const hive = workspace('hive');
  const comb: CombConfig = { ...COMB, workspaces: [hive, { ...hive, name: 'site', path: '/home/u/site', machine: 'wsl:Y' }] };
  const asked: string[] = [];
  const machineFor = (w: Pick<Workspace, 'machine'>) => {
    asked.push(w.machine);
    return w.machine === 'wsl:Y' ? unavailableMachine('wsl:Y', NOT_SUPPORTED) : fakeMachine({ exec: async () => ({ stdout: 'git@github.com:acme/hive.git\n' }) });
  };
  assert.deepEqual((await listRepositories({ comb, gitlabHosts: [] }, initialState(0), machineFor)).map((r) => r.repository), ['acme/hive']);
  assert.deepEqual(asked, ['local', 'wsl:Y']);
});
