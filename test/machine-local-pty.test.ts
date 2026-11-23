import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS } from '../src/agents.js';
import { agentCommand } from '../src/agents/command.js';
import { runners } from '../src/agents/registry.js';
import type { AgentRun, McpServer } from '../src/agents/runner.js';
import { commandShimDir } from '../src/command-shim.js';
import { hooksPath, PROMPTS_DIR } from '../src/hooks-settings.js';
import { MachineError, type RunInputs, type RunSpec } from '../src/machine.js';
import { createLocalPty, type LocalPtyDeps } from '../src/machine-local-pty.js';
import { posixShell } from '../src/posix-shell.js';
import { createPtyHost } from '../src/pty-host.js';
import { shellInitDir } from '../src/shell-init.js';
import { shimDir } from '../src/shim.js';
import { ptyCommand } from '../src/spawn.js';
import { launchInternalPty } from '../src/spawn-internal.js';
import { historyPath } from '../src/terminal-files.js';
import type { AgentId, LaunchPty, PtyLaunch } from '../src/types.js';
import { fakePtys, launchFlag } from './fakes.js';
import { assertMode } from './posix-only.js';
import { tempDir } from './temp-dir.js';

const PORT = 4242;
const SECRET = 'fake-secret-158';
const LENT = 'fake-token-158';
const PTY_ID = 'P1';
const SLUG = 'hive-1-task';
const CWD = '/repo/.hive/worktrees/hive-1-task';
const PROMPT = 'Do the task.';
const PROTOCOL = 'End the stage with hive_done.';
const PLUGINS = '/plugins';
const LSP = '/lsp';
const WORKSPACE = 'acme';
// #947: the folders the machine resolves from spec.workspace; a run's inputs carry neither
const DIRS: Pick<AgentRun, 'pluginDir' | 'lspPluginDir'> = { pluginDir: join(PLUGINS, WORKSPACE), lspPluginDir: join(LSP, WORKSPACE) };
const RUN: RunInputs = { withHive: true, external: [], extraArgs: ['--verbose'], model: 'opus', session: { id: 'S1', resume: false } };
const HANDLERS = { onExit: (): void => {}, onError: (): void => {} };

const stageRun = (id: AgentId, more: Partial<RunSpec> = {}): RunSpec => ({
  ptyId: PTY_ID, slug: SLUG, workspace: WORKSPACE, cwd: CWD, env: { A: '1' }, prompt: { text: PROMPT, name: SLUG }, protocol: PROTOCOL, agent: { id, run: RUN }, ...more,
});

// The PtyLaunch every spawn hands the daemon's launcher, and a pty that starts at once
function recorder(): { handed: PtyLaunch[]; launch: LaunchPty } {
  const handed: PtyLaunch[] = [];
  return { handed, launch: (launch) => { handed.push(launch); return { started: Promise.resolve(), kill: () => Promise.resolve() }; } };
}

// A temp home with the prompts/ folder prepareHome makes on every boot
async function homeIn(t: TestContext): Promise<string> {
  const home = await tempDir(t, 'machine-pty-');
  await mkdir(join(home, 'prompts'));
  return home;
}

const depsIn = (home: string, launch: LaunchPty, over: Partial<LocalPtyDeps> = {}): LocalPtyDeps => ({
  launch, ptys: createPtyHost(fakePtys().spawnPty), home, secret: SECRET, secretFile: join(home, 'hive.secret'),
  commandShims: join(home, 'command-shims'), port: () => PORT, env: process.env, platform: process.platform,
  pluginDir: (workspace) => join(PLUGINS, workspace), lspDir: (workspace) => join(LSP, workspace), ...over,
});

const serverOf = (): McpServer => ({ port: PORT, ptyId: PTY_ID, secret: SECRET, withHive: true, external: [] });

// The AgentRun today's spawn builds for the same inputs, over the paths the machine writes (the protocol at <ptyId>.protocol.md) and the
// folders it resolves from the workspace (#947)
function machineRun(home: string, id: AgentId, run: RunInputs = RUN, dirs: Pick<AgentRun, 'pluginDir' | 'lspPluginDir'> = DIRS): AgentRun {
  const prompts = join(home, 'prompts');
  const mcp = runners[id].mcpConfig(serverOf()) === '' ? {} : { mcpPath: join(prompts, `${PTY_ID}.mcp.json`) };
  return { ...run, ...dirs, ptyId: PTY_ID, cwd: CWD, port: PORT, hooksPath: hooksPath(home), ...mcp, protocolPath: join(prompts, `${PTY_ID}.protocol.md`), protocolText: PROTOCOL };
}

// What server-spawn.ts' spawn hands the pool today (#924, #927, #633): the prompt file, the runner's env over the workspace's, the agent
function todays(home: string, id: AgentId, run: RunInputs = RUN, dirs: Pick<AgentRun, 'pluginDir' | 'lspPluginDir'> = DIRS): Pick<PtyLaunch, 'promptPath' | 'env' | 'agent'> {
  const runner = runners[id];
  const command = agentCommand(id, process.platform, { ...process.env, A: '1' });
  const agentRun = machineRun(home, id, run, dirs);
  return { promptPath: join(home, 'prompts', `${SLUG}.md`), env: { A: '1', ...runner.runEnv(serverOf(), agentRun) }, agent: { command, argv: runner.launch(agentRun) } };
}
const launched = ({ promptPath, env, agent }: PtyLaunch): Pick<PtyLaunch, 'promptPath' | 'env' | 'agent'> => ({ promptPath, env, agent });

test('a Claude stage run writes its prompt, its 0600 MCP config holding the secret and its 0600 protocol, and hands on the runner\'s own launch over the machine\'s paths (#158)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  await createLocalPty(depsIn(home, launch)).spawn(stageRun('claude'), HANDLERS).started;
  const prompts = join(home, 'prompts');
  assert.equal(await readFile(join(prompts, `${SLUG}.md`), 'utf8'), PROMPT);
  assert.ok((await readFile(join(prompts, `${PTY_ID}.mcp.json`), 'utf8')).includes(SECRET), 'the MCP config carries the secret (#467)');
  await assertMode(t, join(prompts, `${PTY_ID}.mcp.json`), 0o600);
  assert.equal(await readFile(join(prompts, `${PTY_ID}.protocol.md`), 'utf8'), PROTOCOL);
  await assertMode(t, join(prompts, `${PTY_ID}.protocol.md`), 0o600);
  assert.deepEqual(launched(handed[0]), todays(home, 'claude'));
  assert.deepEqual([handed[0].ptyId, handed[0].slug, handed[0].cwd, handed[0].port], [PTY_ID, SLUG, CWD, PORT]);
});

test('a Codex stage run writes no MCP file, its server rides the argv, and hands on the runner\'s own launch over the machine\'s paths (#158, #927)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  // Codex reads the plugin folder's agents/ on every launch, so the folder the machine resolves must exist (/plugins/acme does not)
  const pluginDir = await tempDir(t, 'plugin-');
  await mkdir(join(pluginDir, 'agents'));
  await createLocalPty(depsIn(home, launch, { pluginDir: () => pluginDir })).spawn(stageRun('codex'), HANDLERS).started;
  await assert.rejects(access(join(home, 'prompts', `${PTY_ID}.mcp.json`)));
  assert.deepEqual(launched(handed[0]), todays(home, 'codex', RUN, { ...DIRS, pluginDir }));
});

test('an agent launch loads the plugin folder of spec.workspace and then its language-server plugin, both resolved by the machine (#803, #947)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  await createLocalPty(depsIn(home, launch)).spawn(stageRun('claude', { workspace: 'other' }), HANDLERS).started;
  assert.deepEqual([launchFlag(handed[0], '--plugin-dir', 0), launchFlag(handed[0], '--plugin-dir', 1)], [join(PLUGINS, 'other'), join(LSP, 'other')]);
});

test('a workspace with no language-server plugin launches with its plugin folder alone: no second --plugin-dir (#803, #947)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  await createLocalPty(depsIn(home, launch, { lspDir: () => undefined })).spawn(stageRun('claude'), HANDLERS).started;
  assert.deepEqual([launchFlag(handed[0], '--plugin-dir', 0), launchFlag(handed[0], '--plugin-dir', 1)], [join(PLUGINS, WORKSPACE), undefined]);
});

// The runs' TMPDIR under the test's own folder, as spawn-internal.test.ts' runsBase: launchInternalPty makes <tmpdir>/hive-runs/<ptyId>
const TEMP_NAMES = ['TMPDIR', 'TEMP', 'TMP'] as const;
async function runsIn(t: TestContext): Promise<void> {
  const base = await tempDir(t, 'runs-');
  const previous = TEMP_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_NAMES) process.env[name] = base;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('through launchInternalPty the pty starts as the POSIX shell running the ptyCommand of the launch it was handed (#158)', async (t) => {
  const home = await homeIn(t);
  await runsIn(t);
  const { spawnPty, ptys: started } = fakePtys();
  const handed: PtyLaunch[] = [];
  const launch: LaunchPty = (l, handlers, options) => { handed.push(l); return launchInternalPty(l, handlers, options); };
  await createLocalPty({ ...depsIn(home, launch), ptys: createPtyHost(spawnPty) }).spawn(stageRun('claude'), HANDLERS).started;
  const [pty] = started;
  assert.deepEqual([pty.file, pty.args, pty.options.cwd], [posixShell().shell, ['-c', ptyCommand(handed[0])], CWD]); // as spawn-internal.test.ts expects
});

test('a kept terminal writes no file and is handed on with its own HISTFILE, the command shims then the agents\' shims first on its PATH, or the machine\'s PATH when the spec sets none, and HIVE_SHELL_DIR, all under the machine\'s home (#158, #696, #800, #947)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  const keep = { log: join(home, 'T1.log') };
  // linux on every host: the ':' delimiter, and no PowerShell looked up on the real disk; windowsShell's win32 branch is spawn.test.ts'
  const pty = createLocalPty(depsIn(home, launch, { platform: 'linux', env: { PATH: '/hive/bin' } }));
  await pty.spawn({ ptyId: 'T1', slug: SLUG, workspace: WORKSPACE, cwd: CWD, terminal: true, env: { A: '1', PATH: '/ws/bin' }, keep, size: { cols: 80, rows: 24 } }, HANDLERS).started;
  await pty.spawn({ ptyId: 'T2', slug: SLUG, workspace: WORKSPACE, cwd: CWD, terminal: true, env: { A: '1' }, keep }, HANDLERS).started;
  assert.deepEqual(await readdir(join(home, 'prompts')), []);
  const own = (id: string, path: string): Record<string, string> => ({ HISTFILE: historyPath(home, id), PATH: `${commandShimDir(home)}:${shimDir(home)}:${path}`, HIVE_SHELL_DIR: shellInitDir(home) });
  assert.deepEqual(handed, [
    { ptyId: 'T1', slug: SLUG, cwd: CWD, port: PORT, terminal: true, env: { A: '1', ...own('T1', '/ws/bin') }, keep, size: { cols: 80, rows: 24 } },
    { ptyId: 'T2', slug: SLUG, cwd: CWD, port: PORT, terminal: true, env: { A: '1', ...own('T2', '/hive/bin') }, keep },
  ]);
});

test('a terminal that is not kept, a run command, gets only its own env with the lent values last: no HISTFILE, no shims (#300, #696, #947)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  const run = { command: 'pnpm dev', env: { PORT: '5173' } };
  await createLocalPty(depsIn(home, launch, { platform: 'linux' })).spawn({ ptyId: 'T3', slug: SLUG, workspace: WORKSPACE, cwd: CWD, terminal: true, run, env: { A: '1', GH_TOKEN: 'workspace-value' }, lent: { GH_TOKEN: LENT } }, HANDLERS).started;
  assert.deepEqual(handed, [{ ptyId: 'T3', slug: SLUG, cwd: CWD, port: PORT, terminal: true, run, env: { A: '1', GH_TOKEN: LENT } }]);
});

test('lent values reach the run\'s env last, and no file the machine writes and no argv word holds one (#158)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  await createLocalPty(depsIn(home, launch)).spawn(stageRun('claude', { env: { GH_TOKEN: 'workspace-value' }, lent: { GH_TOKEN: LENT } }), HANDLERS).started;
  assert.equal(handed[0].env?.GH_TOKEN, LENT);
  assert.ok(!JSON.stringify(handed[0].agent).includes(LENT), 'never in the argv, which every account reads through ps');
  const prompts = join(home, 'prompts');
  for (const name of await readdir(prompts)) assert.ok(!(await readFile(join(prompts, name), 'utf8')).includes(LENT), name);
});

test('a ptyId or a prompt name that is not one plain file name rejects started with bad_name and writes nothing (#158)', async (t) => {
  const home = await tempDir(t, 'machine-pty-');
  await mkdir(join(home, PROMPTS_DIR));
  const { handed, launch } = recorder();
  const pty = createLocalPty(depsIn(home, launch));
  const isBadName = (err: unknown): boolean => err instanceof MachineError && err.code === MachineError.BAD_NAME;
  await assert.rejects(pty.spawn({ ...stageRun('claude'), ptyId: '../escape' }, HANDLERS).started, isBadName);
  await assert.rejects(pty.spawn({ ...stageRun('claude'), prompt: { name: 'a/b', text: 'x' } }, HANDLERS).started, isBadName);
  await assert.rejects(pty.spawn({ ptyId: '../escape', slug: SLUG, workspace: WORKSPACE, cwd: CWD, terminal: true, keep: { log: join(home, 'T.log') } }, HANDLERS).started, isBadName); // #947: a kept terminal's HISTFILE
  assert.deepEqual(handed, []);
  assert.deepEqual(await readdir(join(home, PROMPTS_DIR)), []);
});

test('a file that cannot be written rejects started and launches nothing, so the pool reports spawnFailed (#158)', async (t) => {
  const home = await tempDir(t, 'machine-pty-'); // no prompts/: every write fails
  const { handed, launch } = recorder();
  await assert.rejects(createLocalPty(depsIn(home, launch)).spawn(stageRun('claude'), HANDLERS).started, { code: 'ENOENT' });
  assert.deepEqual(handed, []);
});

test('a copy\'s first run gets the runner\'s copy argv, and a run the agent cannot copy rejects started with today\'s message (#158, #587)', async (t) => {
  const home = await homeIn(t);
  const { handed, launch } = recorder();
  const pty = createLocalPty(depsIn(home, launch));
  await pty.spawn(stageRun('claude', { agent: { id: 'claude', run: RUN, copy: { from: 'S0', name: 'Fork' } } }), HANDLERS).started;
  assert.deepEqual(handed[0].agent?.argv, runners.claude.copy(machineRun(home, 'claude'), 'S0', 'Fork'));
  const { session: _session, ...unsessioned } = RUN;
  const refused = pty.spawn(stageRun('claude', { ptyId: 'P2', agent: { id: 'claude', run: unsessioned, copy: { from: 'S0' } } }), HANDLERS).started;
  await assert.rejects(refused, { message: `${AGENTS.claude.label} cannot copy a session` });
});

test('a Copilot stage run writes its run files before the pty and hands on its prompt flag, as spawn does today (#159, #873)', async (t) => {
  const home = await homeIn(t);
  await runsIn(t); // Copilot's instructions folder is under the runs' TMPDIR
  const { handed, launch } = recorder();
  await createLocalPty(depsIn(home, launch)).spawn(stageRun('copilot'), HANDLERS).started;
  assert.equal(handed[0].agent?.promptFlag, runners.copilot.promptFlag);
  const files = runners.copilot.runFiles(machineRun(home, 'copilot'));
  assert.ok(files.length > 0, 'Copilot takes its protocol as a file');
  for (const file of files) assert.equal(await readFile(file.path, 'utf8'), file.content);
});
