// A distro's ptys (#944): a RunSpec's files written through the distro's own fs, then the same `sh -c ptyCommand` line local runs get, started
// by wsl.exe in a pty of the Hive's. The host cannot reach the distro's disk with node:fs, and the distro cannot read the host's paths, so
// every path here is the distro's (machine.paths) and every value that is not one rides the env by name through WSLENV, never the argv.
import { AGENTS } from '../agents.js';
import { runners } from '../agents/registry.js';
import type { AgentRun, McpServer } from '../agents/runner.js';
import { claudeEnvLine, commandShimsEnvFile } from '../command-shim.js';
import { PROMPTS_DIR } from '../hooks-settings.js';
import { type Machine, MachineError, type MachinePty, type RunSpec } from '../machine.js';
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
interface RunFile { path: string; text: string }
// Everything a run needs, settled before the first write: a refused input (a name, an env var, the distro) leaves the distro as it was
interface Plan { files: RunFile[]; argv: string[]; env: NodeJS.ProcessEnv }
interface Part { launch: PtyLaunch; vars: Record<string, string>; path: string; files: RunFile[] }

// A leftover of a run with this id goes first, so 'wx' makes the file anew with its own mode and never follows a planted symlink
async function writePrivate(machine: Machine, { path, text }: RunFile): Promise<void> {
  await machine.fs.rm(path, { force: true });
  await machine.fs.writeFile(path, text, { mode: PRIVATE_FILE, flag: 'wx' });
}

async function privateDir(machine: Machine, dir: string): Promise<void> {
  await machine.fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  await machine.fs.chmod(dir, PRIVATE_DIR); // mkdir's mode applies only to a folder it makes
}

// wsl.exe's --exec runs no login shell, so ~/.local/bin, where Claude's installer puts it, is added here, in a terminal too
function distroPath(machine: Machine, spec: RunSpec): string {
  const info = machine.info();
  return [spec.env?.PATH ?? info.path, machine.paths.join(info.homedir, '.local', 'bin')].join(':');
}

// The prompt, the MCP config (none when the runner has none, #927), the protocol and #800's env file, all at the distro's paths
function agentPart(deps: WslPtyDeps, spec: RunSpec, agent: AgentSpec, base: PtyLaunch, pluginDir: string): Part {
  const { machine, home, relayPort: port } = deps;
  const { ptyId, cwd } = spec;
  const runner = runners[agent.id];
  const at = (name: string): string => machine.paths.join(home.root, PROMPTS_DIR, name);
  const server: McpServer = { port, ptyId, secret: deps.secret, withHive: agent.run.withHive, external: agent.run.external };
  const mcp = runner.mcpConfig(server);
  const promptFile = spec.prompt === undefined ? undefined : { path: at(`${spec.prompt.name}.md`), text: argvSafe(spec.prompt.text) };
  const mcpFile = mcp === '' ? undefined : { path: at(`${ptyId}.mcp.json`), text: mcp };
  const protocolFile = spec.protocol === undefined ? undefined : { path: at(`${ptyId}.protocol.md`), text: spec.protocol };
  const envFile = { path: commandShimsEnvFile(home.commandShims, ptyId, machine.paths), text: claudeEnvLine(home.commandShims, 'linux') };
  const protocol = protocolFile === undefined || spec.protocol === undefined ? {} : { protocolPath: protocolFile.path, protocolText: spec.protocol };
  // no lspPluginDir: a distro has no language servers in this cut (#944)
  const run: AgentRun = { ...agent.run, ptyId, cwd, port, hooksPath: home.hooksPath, ...(mcpFile === undefined ? {} : { mcpPath: mcpFile.path }), pluginDir, ...protocol };
  const argv = agent.copy ? runner.copy(run, agent.copy.from, agent.copy.name) : runner.launch(run);
  if (argv === undefined) throw new Error(`${AGENTS[agent.id].label} cannot copy a session`);
  const promptFlag = runner.promptFlag === undefined ? {} : { promptFlag: runner.promptFlag };
  // the bare name, not agentCommand: that resolves a host .exe, while the distro's PATH finds its own claude
  const launch: PtyLaunch = { ...base, ...(promptFile === undefined ? {} : { promptPath: promptFile.path }), agent: { command: AGENTS[agent.id].command, argv, ...promptFlag } };
  const files = [promptFile, mcpFile, protocolFile, envFile].filter((f): f is RunFile => f !== undefined);
  return { launch, vars: { CLAUDE_ENV_FILE: envFile.path, ...runner.runEnv(server, run) }, path: `${home.commandShims}:${distroPath(machine, spec)}`, files };
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

function requireClaude(spec: RunSpec): void {
  // Claude only in this cut (#944): another agent's runner writes files at host paths
  if (spec.agent !== undefined && spec.agent.id !== 'claude') throw new MachineError(`${AGENTS[spec.agent.id].label} does not run in a distro yet`, { code: 'not_supported' });
}

async function planRun(deps: WslPtyDeps, spec: RunSpec, tmp: string): Promise<Plan> {
  requirePlainName(spec.ptyId);
  if (spec.prompt !== undefined) requirePlainName(spec.prompt.name);
  requireClaude(spec);
  await requireDir(deps.machine, spec.cwd);
  const base: PtyLaunch = { ptyId: spec.ptyId, slug: spec.slug, cwd: spec.cwd, port: deps.relayPort, ...(spec.terminal ? { terminal: true as const } : {}), ...(spec.run ? { run: spec.run } : {}) };
  const part: Part = spec.agent === undefined
    ? { launch: base, vars: {}, path: distroPath(deps.machine, spec), files: [] }
    : agentPart(deps, spec, spec.agent, base, await deps.pluginDir(spec.workspace));
  const env = wslEnv(runVars(deps, spec, tmp, part.vars), deps.hostEnv);
  const { file, args } = wslArgv(deps.command, deps.distro, ['env', `PATH=${part.path}`, 'sh', '-c', ptyCommand(part.launch)]);
  return { files: part.files, argv: [file, ...args], env };
}

async function writeRun(machine: Machine, tmp: string, files: readonly RunFile[]): Promise<void> {
  await privateDir(machine, tmp);
  for (const dir of new Set(files.map((f) => machine.paths.dirname(f.path)))) await privateDir(machine, dir);
  // every write settled before a failure is thrown: a cleanup racing a write still under way would leave that file (the MCP secret) behind
  const results = await Promise.allSettled(files.map((f) => writePrivate(machine, f)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}

function removeAll(machine: Machine, tmp: string, files: readonly string[], onError: PtyHandlers['onError']): void {
  machine.fs.rm(tmp, { recursive: true, force: true, maxRetries: TMP_RM_RETRIES, retryDelay: TMP_RM_RETRY_MS }).catch((err: unknown) => onError(`tmp: ${errorMessage(err)}`));
  for (const file of files) machine.fs.rm(file, { force: true }).catch((err: unknown) => onError(`run file: ${errorMessage(err)}`));
}

/** The run's pty: started, one kill resolving on its exit, the exit reported once; its temp folder and env file go with it (#428, #800).
 * A start that fails once its plan passed removes everything the plan names, the prompts/ files too, whatever was written before the failure. */
function spawnRun(deps: WslPtyDeps, spec: RunSpec, handlers: PtyHandlers): PtyHandle {
  const { machine, ptys } = deps;
  const tmp = runTmpDir(spec.ptyId, machine.paths, machine.info().tmpdir);
  const envFile = commandShimsEnvFile(deps.home.commandShims, spec.ptyId, machine.paths);
  let markGone: () => void = () => {};
  const gone = new Promise<void>((resolve) => { markGone = resolve; });
  let isExited = false;
  const exitOnce = (): void => {
    if (isExited) return;
    isExited = true;
    removeAll(machine, tmp, [envFile], handlers.onError);
    markGone();
    handlers.onExit();
  };
  let planned: Plan | undefined; // set only once the plan passed: before it, a refused name names no path to remove
  const started = planRun(deps, spec, tmp).then(async (plan) => {
    planned = plan;
    await writeRun(machine, tmp, plan.files);
    ptys.spawn(spec.ptyId, plan.argv, deps.hostCwd, plan.env, spec.terminal === undefined ? {} : spec.keep, spec.size);
    try {
      ptys.subscribe(spec.ptyId, () => {}, exitOnce);
    } catch (err) {
      ptys.kill(spec.ptyId); // a pty nobody hears the exit of would outlive its rejected start, unkillable through this handle
      throw err;
    }
  }).catch((err: unknown) => {
    if (planned !== undefined) removeAll(machine, tmp, planned.files.map((f) => f.path), handlers.onError);
    throw err;
  });
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
const TITLE_WINDOW = 4096; // ConPTY's title comes with its screen setup, first; past this head the stream goes out untouched
// biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC sequence is control characters
const WHOLE_TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC sequence is control characters
const OPEN_TITLE = /\x1b\]0;[^\x07\x1b]*\x1b?$/;
const isWslExe = (file: string): boolean => (file.split(/[\\/]/).at(-1) ?? '').toLowerCase() === 'wsl.exe';

// Where a title that may still name wsl.exe starts at the end of `text`: an open OSC 0, or a piece of its opener; text.length if none
function openTitleAt(text: string): number {
  const open = OPEN_TITLE.exec(text);
  if (open !== null) return open.index;
  for (let k = OSC_TITLE.length - 1; k > 0; k -= 1) if (text.endsWith(OSC_TITLE.slice(0, k))) return text.length - k;
  return text.length;
}

// The first wsl.exe title in `text` cut out, every byte around it kept; undefined when there is none
function withoutTitle(text: string): string | undefined {
  const title = [...text.matchAll(WHOLE_TITLE)].find((m) => m[1]?.toLowerCase().includes('wsl.exe'));
  return title === undefined ? undefined : text.slice(0, title.index) + text.slice(title.index + title[0].length);
}

// ConPTY opens a pty's stream with its window title, the program's path: for wsl.exe, a host path the distro's run never printed. Only a
// possible title is held back, so a head with no title (a prompt waiting for a key) is never delayed
function titleless(pty: Pty): Pty {
  const listeners: ((data: string) => void)[] = [];
  let pending: string | undefined = ''; // undefined: the head is done, everything passes
  let sent = 0;
  const send = (data: string): void => { if (data !== '') for (const l of listeners) l(data); };
  const pass = (data: string): void => { pending = undefined; send(data); };
  pty.onData((chunk) => {
    if (pending === undefined) return send(chunk);
    const seen = pending + chunk;
    const cut = withoutTitle(seen);
    if (cut !== undefined) return pass(cut);
    const at = openTitleAt(seen);
    if (sent + seen.length >= TITLE_WINDOW) return pass(seen);
    send(seen.slice(0, at));
    sent += at;
    pending = seen.slice(at);
  });
  return {
    onData: (listener) => { listeners.push(listener); },
    onExit: (listener) => pty.onExit((event) => {
      pass(pending ?? ''); // a stream that ended inside an open title still shows what it sent
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
