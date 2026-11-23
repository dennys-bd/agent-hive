// The local machine's ptys (#158): a RunSpec's files written under the home where today's spawns put them, so `pkill -f <ptyId>.mcp.json`
// still matches, then today's PtyLaunch through the daemon's own launcher, whose `sh -c ptyCommand` stays in spawn-internal.ts where it is
// tested. The machine's own paths enter the argv only here, so node 8's remote machine renders the same argv over its own. The plugin
// folders and a kept terminal's own env are the machine's to fill too (#947): a distro's disk has its own copy, the host's is no use there.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS } from './agents.js';
import { agentCommand } from './agents/command.js';
import { runners } from './agents/registry.js';
import type { AgentRun, McpServer } from './agents/runner.js';
import { hooksPath, PROMPTS_DIR } from './hooks-settings.js';
import { writeMcpConfig } from './home-hooks.js';
import { MachineError, type MachinePty, type RunSpec } from './machine.js';
import type { PtyHost } from './pty-host.js';
import { terminalEnv, windowsShell, writePrompt, writeRunFiles } from './spawn.js';
import type { LaunchPty, PtyHandle, PtyHandlers, PtyLaunch, SpawnOptions } from './types.js';

const PROTOCOL_MODE = 0o600; // a workspace's protocol carries its memory's lessons (#797)

export interface LocalPtyDeps {
  launch: LaunchPty; // deps.launchPty ?? launchInternalPty, as server.ts builds the pool's
  ptys: PtyHost; // the daemon's
  home: string; // prompts/ under it, where today's spawns write
  secret: string; // this boot's: the MCP config's header (#467)
  secretFile: string; // SpawnOptions'
  commandShims: string; // SpawnOptions'
  port(): number; // bound by listen() after the machines are built
  env: NodeJS.ProcessEnv; // the daemon's: what agentCommand looks the agent up in
  platform: NodeJS.Platform;
  pluginDir(workspace: string): string; // #316, #947: the workspace's rendered plugin folder (pluginRender.dir); throws when it has none
  lspDir(workspace: string): string | undefined; // #803, #947: its language-server plugin as the last write left it (workerLsp.dir)
}

type AgentSpec = NonNullable<RunSpec['agent']>;

// What every launch carries as the spec gave it; an absent key stays absent, as today's launches leave it
const shared = (spec: RunSpec, port: number): PtyLaunch => ({
  ptyId: spec.ptyId, slug: spec.slug, cwd: spec.cwd, port,
  ...(spec.terminal ? { terminal: true as const } : {}), ...(spec.run ? { run: spec.run } : {}),
  ...(spec.keep ? { keep: spec.keep } : {}), ...(spec.size ? { size: spec.size } : {}),
});

async function protocolFile(dir: string, ptyId: string, text: string | undefined): Promise<string | undefined> {
  if (text === undefined) return undefined;
  const path = join(dir, `${ptyId}.protocol.md`);
  await writeFile(path, text, { mode: PROTOCOL_MODE });
  return path;
}

// The prompt, the MCP config (none for a runner whose server rides its argv, #927) and the protocol, then the runner's argv over their paths
// Every file name the machine joins under prompts/ is one plain name: once a RunSpec can come over the link (node 8), a `/` or `..` would write outside it
const PLAIN_NAME = /^[\w-][\w.-]*$/;
function requirePlainName(name: string): void {
  if (!PLAIN_NAME.test(name)) throw new MachineError(`not a plain file name: ${JSON.stringify(name)}`, { code: MachineError.BAD_NAME });
}

async function agentLaunch(deps: LocalPtyDeps, spec: RunSpec, agent: AgentSpec): Promise<PtyLaunch> {
  const { ptyId, cwd } = spec;
  requirePlainName(ptyId);
  if (spec.prompt !== undefined) requirePlainName(spec.prompt.name);
  // Before any write: a workspace with no rendered folder writes nothing and rejects started, as a bad name does
  const pluginDir = deps.pluginDir(spec.workspace);
  const lsp = deps.lspDir(spec.workspace);
  const dir = join(deps.home, PROMPTS_DIR);
  const port = deps.port();
  const runner = runners[agent.id];
  const server: McpServer = { port, ptyId, secret: deps.secret, withHive: agent.run.withHive, external: agent.run.external };
  const [promptPath, mcpPath, protocolPath] = await Promise.all([
    spec.prompt === undefined ? undefined : writePrompt(dir, spec.prompt.name, spec.prompt.text),
    writeMcpConfig(dir, ptyId, runner.mcpConfig(server)),
    protocolFile(dir, ptyId, spec.protocol),
  ]);
  const protocol = protocolPath === undefined || spec.protocol === undefined ? {} : { protocolPath, protocolText: spec.protocol };
  const run: AgentRun = { ...agent.run, ptyId, cwd, port, hooksPath: hooksPath(deps.home), mcpPath, pluginDir, ...(lsp === undefined ? {} : { lspPluginDir: lsp }), ...protocol };
  const argv = agent.copy ? runner.copy(run, agent.copy.from, agent.copy.name) : runner.launch(run);
  if (argv === undefined) throw new Error(`${AGENTS[agent.id].label} cannot copy a session`);
  await writeRunFiles(runner.runFiles(run)); // #873: the run's own files (Copilot's protocol), before its pty reads them
  const env = { ...spec.env, ...runner.runEnv(server, run), ...spec.lent }; // #927: no workspace variable stands in for the MCP secret; a lent value wins
  const command = agentCommand(agent.id, deps.platform, { ...deps.env, ...spec.env }); // #633
  return { ...shared(spec, port), env, ...(promptPath === undefined ? {} : { promptPath }), agent: { command, argv, ...(runner.promptFlag === undefined ? {} : { promptFlag: runner.promptFlag }) } };
}

// A kept terminal's own (#696, #800, #947): its HISTFILE, the command shims then the agents' shims before the spec's PATH (else this
// machine's), HIVE_SHELL_DIR and, on win32, the PowerShell it opens (#645), looked up on every launch. A run command is never kept: none
function keptEnv(deps: LocalPtyDeps, spec: RunSpec): Record<string, string> {
  if (spec.keep === undefined) return {};
  requirePlainName(spec.ptyId); // its HISTFILE is joined under terminals/, which the shell appends every typed line to
  const path = spec.env?.PATH ?? deps.env.PATH ?? '';
  return terminalEnv(deps.home, spec.ptyId, path, { platform: deps.platform, pwsh: windowsShell({ ...deps.env, ...spec.env }, deps.platform) });
}

async function launchOf(deps: LocalPtyDeps, spec: RunSpec): Promise<PtyLaunch> {
  if (spec.agent !== undefined) return agentLaunch(deps, spec, spec.agent);
  return { ...shared(spec, deps.port()), env: { ...spec.env, ...keptEnv(deps, spec), ...spec.lent } }; // a terminal: no agent, no MCP, no prompt (#283)
}

export function createLocalPty(deps: LocalPtyDeps): MachinePty {
  const { ptys } = deps;
  const options: SpawnOptions = { ptys, secretFile: deps.secretFile, commandShims: deps.commandShims };
  // A write that fails rejects started, which the pool reports as spawnFailed; a kill before the launch has nothing to kill
  const spawn = (spec: RunSpec, handlers: PtyHandlers): PtyHandle => {
    const inner = launchOf(deps, spec).then((launch) => deps.launch(launch, handlers, options));
    return { started: inner.then((handle) => handle.started), kill: () => inner.then((handle) => handle.kill(), () => undefined) };
  };
  return {
    spawn,
    write: (id, data) => ptys.write(id, data),
    resize: (id, cols, rows, redraw) => ptys.resize(id, cols, rows, redraw),
    subscribe: (id, onData, onExit) => ptys.subscribe(id, onData, onExit),
    kill: (id) => ptys.kill(id),
    pid: (id) => ptys.pid(id),
    has: (id) => ptys.has(id),
    adopt: (id, pty) => ptys.adopt(id, pty),
    forget: (id) => ptys.forget(id),
  };
}
