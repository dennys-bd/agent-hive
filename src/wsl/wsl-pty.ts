// A distro's ptys (#944): a RunSpec's files written through the distro's own fs, then the same `sh -c ptyCommand` line local runs get, started
// by wsl.exe in a pty of the Hive's. The host cannot reach the distro's disk with node:fs, and the distro cannot read the host's paths, so
// every path here is the distro's (machine.paths) and every value that is not one rides the env by name through WSLENV, never the argv.
import { AGENTS } from '../agents.js';
import { runners } from '../agents/registry.js';
import type { AgentRun, McpServer } from '../agents/runner.js';
import { claudeEnvLine, commandShimsEnvFile } from '../command-shim.js';
import { PROMPTS_DIR } from '../hooks-settings.js';
import type { Machine, MachinePty, RunSpec } from '../machine.js';
import { requirePlainName } from '../machine-local-pty.js';
import type { Pty, PtyHost, SpawnPty } from '../pty-host.js';
import { argvSafe, ptyCommand, runTmpDir } from '../spawn.js';
import type { PtyHandle, PtyHandlers, PtyLaunch } from '../types.js';
import type { DistroHome } from './distro-home.js';
import { wslArgv, wslEnv } from './wsl-exe.js';

export interface WslPtyDeps {
  command: readonly string[]; // wsl.exe and any leading args (a test's fake)
  distro: string;
  machine: Machine; // the distro's
  ptys: PtyHost; // the daemon's
  home: DistroHome;
  relayPort: number; // the distro reaches the Hive through the relay, never the daemon's own port
  secret: string; // the MCP config's header (#467)
  pluginDir(workspace: string): Promise<string>; // distroPluginDir, bound by the caller
  hostEnv: NodeJS.ProcessEnv; // what wsl.exe itself starts with
  hostCwd: string; // where wsl.exe starts on the host: the distro's cwd means nothing to Windows, ptyCommand's own cd takes it there
}

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600; // the MCP config holds the secret, the protocol a workspace's lessons (#797)
const TMP_RM_RETRIES = 10; // as spawn-internal: a process of the run may still be writing its TMPDIR (#495)
const TMP_RM_RETRY_MS = 100;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type AgentSpec = NonNullable<RunSpec['agent']>;
interface Prepared { launch: PtyLaunch; vars: Record<string, string>; path: string }

async function writePrivate(machine: Machine, path: string, text: string): Promise<string> {
  await machine.fs.writeFile(path, text, { mode: PRIVATE_FILE });
  return path;
}

async function privateDir(machine: Machine, dir: string): Promise<void> {
  await machine.fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  await machine.fs.chmod(dir, PRIVATE_DIR); // mkdir's mode applies only to a folder it makes
}

// #800: the line Claude Code's Bash tool sources, one file per run; a leftover of a run with this id goes first, so 'wx' makes it anew
async function writeEnvFile(deps: WslPtyDeps, file: string): Promise<void> {
  const { machine } = deps;
  await privateDir(machine, machine.paths.dirname(file));
  await machine.fs.rm(file, { force: true });
  await machine.fs.writeFile(file, claudeEnvLine(deps.home.commandShims, 'linux'), { mode: PRIVATE_FILE, flag: 'wx' });
}

// The prompt, the MCP config (none for a runner whose server rides its argv, #927) and the protocol, under the distro home's prompts/
async function promptFiles(deps: WslPtyDeps, spec: RunSpec, server: McpServer, mcpConfig: string) {
  const { machine } = deps;
  const dir = machine.paths.join(deps.home.root, PROMPTS_DIR);
  await privateDir(machine, dir);
  const file = (name: string): string => machine.paths.join(dir, name);
  const [promptPath, mcpPath, protocolPath] = await Promise.all([
    spec.prompt === undefined ? undefined : writePrivate(machine, file(`${spec.prompt.name}.md`), argvSafe(spec.prompt.text)),
    mcpConfig === '' ? undefined : writePrivate(machine, file(`${server.ptyId}.mcp.json`), mcpConfig),
    spec.protocol === undefined ? undefined : writePrivate(machine, file(`${server.ptyId}.protocol.md`), spec.protocol),
  ]);
  return { promptPath, mcpPath, protocolPath };
}

async function agentLaunch(deps: WslPtyDeps, spec: RunSpec, agent: AgentSpec, base: PtyLaunch, pluginDir: string): Promise<Prepared> {
  const { machine, home, relayPort: port } = deps;
  const { ptyId, cwd } = spec;
  const runner = runners[agent.id];
  const server: McpServer = { port, ptyId, secret: deps.secret, withHive: agent.run.withHive, external: agent.run.external };
  const { promptPath, mcpPath, protocolPath } = await promptFiles(deps, spec, server, runner.mcpConfig(server));
  const envFile = commandShimsEnvFile(home.commandShims, ptyId, machine.paths);
  await writeEnvFile(deps, envFile);
  const protocol = protocolPath === undefined || spec.protocol === undefined ? {} : { protocolPath, protocolText: spec.protocol };
  const run: AgentRun = { ...agent.run, ptyId, cwd, port, hooksPath: home.hooksPath, ...(mcpPath === undefined ? {} : { mcpPath }), pluginDir, ...protocol };
  const argv = agent.copy ? runner.copy(run, agent.copy.from, agent.copy.name) : runner.launch(run);
  if (argv === undefined) throw new Error(`${AGENTS[agent.id].label} cannot copy a session`);
  await Promise.all(runner.runFiles(run).map(async (f) => {
    await privateDir(machine, machine.paths.dirname(f.path));
    await machine.fs.writeFile(f.path, f.content, { mode: PRIVATE_FILE, flag: 'wx' });
  }));
  const promptFlag = runner.promptFlag === undefined ? {} : { promptFlag: runner.promptFlag };
  const launch: PtyLaunch = { ...base, ...(promptPath === undefined ? {} : { promptPath }), agent: { command: AGENTS[agent.id].command, argv, ...promptFlag } };
  const info = machine.info();
  // the shims first (#800) and ~/.local/bin last, where Claude's installer puts it: wsl.exe's --exec runs no login shell to add it
  const path = [home.commandShims, spec.env?.PATH ?? info.path, machine.paths.join(info.homedir, '.local', 'bin')].join(':');
  return { launch, vars: { CLAUDE_ENV_FILE: envFile, ...runner.runEnv(server, run) }, path };
}

// The run's env as wslEnv carries it: no PATH (it rides env's argv, as the distro's own), a lent value last and only here
function runVars(deps: WslPtyDeps, spec: RunSpec, tmp: string, own: Record<string, string>): Record<string, string> {
  const { PATH: _path, ...env } = spec.env ?? {};
  const hive = { TERM: 'xterm-256color', TMPDIR: tmp, HIVE_PTY_ID: spec.ptyId, HIVE_PORT: String(deps.relayPort), HIVE_SECRET_FILE: deps.home.secretFile };
  return { ...hive, ...env, ...own, ...spec.lent };
}

async function requireDir(machine: Machine, cwd: string): Promise<void> {
  const stats = await machine.fs.stat(cwd);
  if (!stats.isDirectory()) throw new Error(`pty: not a folder: ${cwd}`);
}

// Checked before anything is written or made, so a refused spec leaves the distro as it was; then the temp folder, then the files
async function start(deps: WslPtyDeps, spec: RunSpec, tmp: string, made: () => void): Promise<void> {
  const { machine } = deps;
  requirePlainName(spec.ptyId);
  if (spec.prompt !== undefined) requirePlainName(spec.prompt.name);
  await requireDir(machine, spec.cwd);
  const base: PtyLaunch = { ptyId: spec.ptyId, slug: spec.slug, cwd: spec.cwd, port: deps.relayPort, ...(spec.terminal ? { terminal: true as const } : {}), ...(spec.run ? { run: spec.run } : {}) };
  const terminal: Prepared = { launch: base, vars: {}, path: spec.env?.PATH ?? machine.info().path };
  // a workspace with no rendered folder rejects started before any write, as a bad name does
  const pluginDir = spec.agent === undefined ? undefined : await deps.pluginDir(spec.workspace);
  await privateDir(machine, tmp);
  made();
  const { launch, vars, path } = spec.agent === undefined || pluginDir === undefined ? terminal : await agentLaunch(deps, spec, spec.agent, base, pluginDir);
  const env = wslEnv(runVars(deps, spec, tmp, vars), deps.hostEnv);
  const { file, args } = wslArgv(deps.command, deps.distro, ['env', `PATH=${path}`, 'sh', '-c', ptyCommand(launch)]);
  deps.ptys.spawn(spec.ptyId, [file, ...args], deps.hostCwd, env, spec.terminal === undefined ? {} : spec.keep, spec.size);
}

/** The run's pty: started, one kill resolving on its exit, the exit reported once; its temp folder and env file go with it (#428, #800). */
function spawnRun(deps: WslPtyDeps, spec: RunSpec, handlers: PtyHandlers): PtyHandle {
  const { machine, ptys } = deps;
  const tmp = runTmpDir(spec.ptyId, machine.paths, machine.info().tmpdir);
  const envFile = commandShimsEnvFile(deps.home.commandShims, spec.ptyId, machine.paths);
  let isMade = false;
  const drop = (): void => {
    if (!isMade) return; // a refused name never names a path to remove
    machine.fs.rm(tmp, { recursive: true, force: true, maxRetries: TMP_RM_RETRIES, retryDelay: TMP_RM_RETRY_MS }).catch((err: unknown) => handlers.onError(`tmp: ${errorMessage(err)}`));
    machine.fs.rm(envFile, { force: true }).catch((err: unknown) => handlers.onError(`command shims env: ${errorMessage(err)}`));
  };
  let markGone: () => void = () => {};
  const gone = new Promise<void>((resolve) => { markGone = resolve; });
  let isExited = false;
  const exitOnce = (): void => {
    if (isExited) return;
    isExited = true;
    drop();
    markGone();
    handlers.onExit();
  };
  const started = start(deps, spec, tmp, () => { isMade = true; }).then(
    () => { ptys.subscribe(spec.ptyId, () => {}, exitOnce); },
    (err: unknown) => { drop(); throw err; },
  );
  let killing: Promise<void> | undefined;
  const kill = (): Promise<void> => {
    killing ??= started.then(() => { ptys.kill(spec.ptyId); return gone; }, () => undefined);
    return killing;
  };
  return { started, kill };
}

export function createWslPty(deps: WslPtyDeps): MachinePty {
  const { ptys } = deps;
  return {
    spawn: (spec, handlers) => spawnRun(deps, spec, handlers),
    write: (id, data) => ptys.write(id, data),
    resize: (id, cols, rows, redraw) => ptys.resize(id, cols, rows, redraw),
    subscribe: (id, onData, onExit) => ptys.subscribe(id, onData, onExit),
    kill: (id) => ptys.kill(id),
    pid: () => undefined, // wsl.exe's pid on the host, not the distro shell's: nothing read under it would be the run's
    has: (id) => ptys.has(id),
    adopt: (id, pty) => ptys.adopt(id, pty),
    forget: (id) => ptys.forget(id),
  };
}

const OSC_TITLE = '\x1b]0;';
const TITLE_MAX = 4096; // a title never closed is not ConPTY's: past this the buffer goes out as it came
// biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC sequence is control characters
const WHOLE_TITLE = /^\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC sequence is control characters
const OPEN_TITLE = /^\x1b\]0;[^\x07\x1b]*\x1b?$/;
const isWslExe = (file: string): boolean => (file.split(/[\\/]/).at(-1) ?? '').toLowerCase() === 'wsl.exe';

// ConPTY opens a pty's stream with its window title, the program's path: for wsl.exe, a host path the distro's run never printed
function titleless(pty: Pty): Pty {
  const listeners: ((data: string) => void)[] = [];
  let pending: string | undefined = '';
  const send = (data: string): void => { if (data !== '') for (const l of listeners) l(data); };
  pty.onData((chunk) => {
    if (pending === undefined) return send(chunk);
    const seen = pending + chunk;
    const whole = WHOLE_TITLE.exec(seen);
    const isOpen = whole === null && seen.length < TITLE_MAX && (OSC_TITLE.startsWith(seen) || OPEN_TITLE.test(seen));
    if (isOpen) { pending = seen; return; }
    pending = undefined;
    send(whole?.[1]?.toLowerCase().includes('wsl.exe') ? seen.slice(whole[0].length) : seen);
  });
  return {
    onData: (listener) => { listeners.push(listener); },
    onExit: (listener) => pty.onExit((event) => {
      const held = pending ?? '';
      pending = undefined;
      send(held); // a stream that ended inside an open title still shows what it sent
      listener(event);
    }),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    get pid() { return pty.pid; },
  };
}

/** `spawnPty` with ConPTY's opening title dropped from a wsl.exe pty's output; every other pty as it is. */
export const withoutConptyTitle = (spawnPty: SpawnPty): SpawnPty => (file, args, options) => {
  const pty = spawnPty(file, args, options);
  return isWslExe(file) ? titleless(pty) : pty;
};
