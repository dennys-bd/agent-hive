import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { movedStages, nestedRefusal, renamedRules, renamedSwitchAt, configFrom, stageRenamesOf, strandedMessage, strandedTasks, workspacesRefusal } from '../src/settings-save.js';
import type { AccountsConfig, Flow, SourceConfig, Stage, Task, Workspace } from '../src/types.js';
import { CONFIG_FILE, parseConfig } from '../src/config.js';
import type { MachineFor } from '../src/machine.js';
import { NOT_SUPPORTED, unavailableMachine } from '../src/machines.js';
import { initialState } from '../src/orchestrator.js';
import { combConfig, GITHUB_ENTRY, workspacesAt } from './fakes.js';
import { fakeMachine, fakeWsl } from './fake-machine.js';
import { tempDir } from './temp-dir.js';

const SAVED: Stage[] = [{ name: 'spec', from: {} }, { name: 'dev', from: {} }, { name: 'qa', from: {} }];
const NEXT: Stage[] = [{ name: 'Spec', from: {} }, { name: 'build', from: {} }, { name: 'qa', from: {} }];

test('stageRenamesOf takes a map of saved stages onto sent ones, drops a stage renamed to itself, and refuses the rest with the reason (#861)', () => {
  assert.deepEqual(stageRenamesOf({ spec: 'Spec', dev: 'build', qa: 'qa' }, SAVED, NEXT), { spec: 'Spec', dev: 'build' });
  assert.deepEqual(stageRenamesOf(undefined, SAVED, NEXT), {}, 'an omitted map renames nothing');
  assert.throws(() => stageRenamesOf({ nope: 'Spec' }, SAVED, NEXT), { message: 'Unknown stage to rename: "nope"' });
  assert.throws(() => stageRenamesOf({ spec: 'gone' }, SAVED, NEXT), { message: 'Renamed stage "gone" is not in the new stages' });
  assert.throws(() => stageRenamesOf({ spec: 'Spec', dev: 'Spec' }, SAVED, NEXT), { message: 'Two stages renamed to "Spec"' });
  assert.throws(() => stageRenamesOf(['spec'], SAVED, NEXT), { message: 'stageRenames must map stage names to stage names' });
  assert.deepEqual(movedStages({ spec: 'Spec', qa: 'qa' }), { spec: 'Spec' });
});

test('what the saved file names by a stage follows a rename: each usage rule\'s stage and each source\'s switchAt, once per value (#861)', () => {
  assert.deepEqual(renamedRules([{ source: 'hour', percent: 50, maxWorkers: 1, stage: 'dev' }, { source: 'day', percent: 90, signal: 'red' }], { dev: 'build' }),
    [{ source: 'hour', percent: 50, maxWorkers: 1, stage: 'build' }, { source: 'day', percent: 90, signal: 'red' }]);
  const source: SourceConfig = { ...GITHUB_ENTRY, switchAt: 'spec' };
  assert.deepEqual(renamedSwitchAt([source], { spec: 'Spec', dev: 'spec' })?.map((s) => s.switchAt), ['Spec'], 'one pass: a chain never renames twice');
});

test('nestedRefusal names the workspace, the nested path and the cause with its fix; nested repos that pass refuse nothing (#653)', async (t) => {
  const run = promisify(execFile);
  const repo = await realpath(await tempDir(t, 'outer-'));
  await run('git', ['-C', repo, 'init', '--quiet']);
  await writeFile(join(repo, '.gitignore'), 'docs/\n');
  await run('git', ['-C', repo, 'init', '--quiet', 'docs']);
  await mkdir(join(repo, 'docs', 'agent'));
  const config = (nestedRepos: string[]) => ({ comb: { workspaces: [{ ...workspacesAt(repo)[0], nestedRepos }] } });
  const onHost = (): ReturnType<MachineFor> => fakeMachine({ exec: run });
  assert.equal(await nestedRefusal(config(['docs']), onHost), undefined);
  assert.deepEqual(await nestedRefusal(config(['docs', 'docs/agent']), onHost), {
    status: 400, message: "hive: nested repo docs/agent: docs/agent is not a git repository's top level · the top level is docs · use docs",
  });
});

// #932: workspaces on a fake host and a fake distro; no folder exists, so each realpath answers the path as given, less a trailing slash
const at = (name: string, path: string, machine: string): Workspace => ({ ...workspacesAt(path)[0], name, machine });
const configOf = (workspaces: Workspace[]) => parseConfig(combConfig({ workspaces, stages: [{ name: 'dev', from: {} }] }));
const slashless = async (path: string): Promise<string> => path.replace(/\/$/, '');
const host = fakeMachine({ fs: { realpath: slashless } });

test('workspacesRefusal checks each folder on its own machine: one folder on two machines is no pair, and the distro\'s git names its problem (#932)', async () => {
  const distro = fakeWsl('X', { fs: { realpath: slashless } });
  const machineFor: MachineFor = (w) => (w.machine === 'wsl:X' ? distro : host);
  assert.equal(await workspacesRefusal(configOf([at('hive', '/home/u/r', 'local'), at('site', '/home/u/r/', 'wsl:X')]), machineFor), undefined);
  assert.deepEqual(await workspacesRefusal(configOf([at('hive', '/home/u/r', 'local'), at('site', '/home/u/r/', 'local')]), machineFor),
    { status: 400, message: 'workspaces hive and site point at the same folder' }, 'the same two paths on one machine are the pair');
  const broken = fakeWsl('X', { exec: async () => { throw Object.assign(new Error('Command failed: git'), { stderr: 'fatal: not a git repository\n' }); } });
  const refused = await workspacesRefusal(configOf([at('site', '/home/u/r', 'wsl:X')]), () => broken);
  assert.equal(refused?.status, 400);
  assert.match(refused?.message ?? '', /^\/home\/u\/r is not a git repository/);
});

test('a workspace on an unavailable machine is skipped when the save keeps it unchanged, and is the 409 when the save adds or changes it (#932)', async () => {
  const down = unavailableMachine('wsl:Y', NOT_SUPPORTED);
  const machineFor: MachineFor = (w) => (w.machine === 'wsl:Y' ? down : host);
  const kept = configOf([at('hive', '/home/u/r', 'local'), at('docs', '/home/u/docs', 'wsl:Y')]);
  const live = { config: kept, state: initialState(0) };
  assert.equal(await workspacesRefusal(kept, machineFor, live), undefined, 'same name, path and machine: unchecked');
  assert.equal(await nestedRefusal(kept, machineFor, kept), undefined);
  const unavailable = { status: 409, message: 'machine wsl:Y is unavailable: not_supported', code: 'machine_unavailable', machine: 'wsl:Y', reason: 'not_supported' };
  assert.deepEqual(await workspacesRefusal(kept, machineFor), unavailable, 'a first setup: new');
  const moved = configOf([at('hive', '/home/u/r', 'local'), at('docs', '/home/u/elsewhere', 'wsl:Y')]);
  assert.deepEqual(await workspacesRefusal(moved, machineFor, live), unavailable, 're-pathed: changed');
});

const TWO: Flow[] = [
  { name: 'feature', stages: [{ name: 'spec', from: {} }], transitions: [{ from: 'spec', to: 'end', when: 'done' }] },
  { name: 'bug', stages: [{ name: 'fix', from: {} }], transitions: [] },
];

const savedHome = async (t: TestContext, flows: Flow[]): Promise<string> => {
  const home = await tempDir(t, 'home-');
  await writeFile(join(home, CONFIG_FILE), JSON.stringify(combConfig({ flows })));
  return home;
};

test('configFrom writes the flows the body sends, a flow without transitions getting them from its stages; no flows keeps the saved ones (#565)', async (t) => {
  const home = await savedHome(t, TWO);
  assert.deepEqual((await configFrom(home, { prefix: 'HIVE' })).comb.flows, TWO, 'an API caller that omits flows');
  const sent: Flow[] = [{ ...TWO[1], name: 'hotfix' }, TWO[0]];
  assert.deepEqual((await configFrom(home, { prefix: 'HIVE', flows: sent })).comb.flows, sent);
  const bare = [{ name: 'main', stages: [{ name: 'dev', from: {} }] }] as unknown as Flow[]; // an API caller's flow with no transitions key
  assert.deepEqual((await configFrom(home, { prefix: 'HIVE', flows: bare })).comb.flows, [{ name: 'main', stages: [{ name: 'dev', from: {} }], transitions: [{ from: 'dev', to: 'end', when: 'done' }] }]);
});

const inStage = (stage: string, n = 1): Task => ({ item: { itemId: `board:${n}`, id: String(n), title: 'T', body: '', url: '', source: 'board' }, stage, boardColumn: 'Ready', auto: true });
const holding = (...stages: string[]): { tasks: Task[] } => ({ tasks: stages.map((s, i) => inStage(s, i + 1)) });

test('strandedTasks names the first flow whose tasks a save leaves with no stage of their flow, with the count (#565)', () => {
  assert.deepEqual(strandedTasks(holding('fix', 'fix', 'spec'), TWO, [TWO[0]], {}), { flow: 'bug', count: 2 }, 'a deleted flow holding tasks');
  const replaced: Flow = { ...TWO[1], stages: [{ name: 'patch', from: {} }], transitions: [] };
  assert.deepEqual(strandedTasks(holding('fix'), TWO, [TWO[0], replaced], {}), { flow: 'bug', count: 1 }, 'every stage of the flow replaced');
});

test('strandedTasks passes an empty flow\'s deletion, a flow rename and a stage rename (#565)', () => {
  assert.equal(strandedTasks(holding('spec'), TWO, [TWO[0]], {}), undefined, 'bug held nothing');
  assert.equal(strandedTasks(holding('fix'), TWO, [TWO[0], { ...TWO[1], name: 'hotfix' }], {}), undefined);
  const renamed: Flow = { ...TWO[1], stages: [{ name: 'patch', from: {} }], transitions: [] };
  assert.equal(strandedTasks(holding('fix'), TWO, [TWO[0], renamed], { fix: 'patch' }), undefined, 'fix → patch is a rename, not a deletion');
  const { stage: _, ...outside } = inStage('fix', 9);
  assert.equal(strandedTasks({ tasks: [outside] }, TWO, [TWO[0]], {}), undefined, 'a task outside the flow (#566) is in no flow to strand');
});

test('strandedMessage counts one task in the singular and several in the plural (#565)', () => {
  assert.match(strandedMessage('bug', 1), /^Flow "bug" holds 1 task and none of its stages survives/);
  assert.match(strandedMessage('bug', 3), /^Flow "bug" holds 3 tasks and none of its stages survives/);
});

test('configFrom saves the accounts a body sends and keeps the saved ones when it sends none; the parser still names a bad one (#952)', async (t) => {
  const home = await tempDir(t, 'home-');
  await writeFile(join(home, CONFIG_FILE), JSON.stringify(combConfig({ flows: TWO, accounts: { claude: 'work' } })));
  assert.deepEqual((await configFrom(home, { prefix: 'HIVE' })).accounts, { claude: 'work' }, 'an API caller that omits accounts');
  assert.deepEqual((await configFrom(home, { prefix: 'HIVE', accounts: { github: 'me' } })).accounts, { github: 'me' });
  assert.deepEqual((await configFrom(home, { prefix: 'HIVE', accounts: {} })).accounts, {}, '{} is every provider on the machine\'s login');
  await assert.rejects(configFrom(home, { prefix: 'HIVE', accounts: { codex: 'x' } as unknown as AccountsConfig }), { message: 'hive.config.json: "accounts.codex" is not an account provider; one of: claude, copilot, github' });
});
