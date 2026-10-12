// The contract every coding agent's runner meets (#924): a plain object of pure functions, one per agent in registry.ts. Shared code reads an
// agent's flags, files and formats only through it; the agent's facts (label, command, subcommands, planLimits) stay in agents.ts, which the
// page reads too.
import type { LaunchArg, RateLimits } from '../types.js';
import type { TranscriptTurn } from '../usage.js';
import type { PlanLimitsDeps } from './claude-limits.js';

export type { LaunchArg };

/** Everything a runner needs to render one run's argv after its command. */
export interface AgentRun {
  ptyId: string;
  hooksPath: string;
  pluginDir: string;
  mcpPath?: string;
  lspPluginDir?: string;
  protocolPath?: string;
  model?: string;
  session?: { id: string; resume: boolean }; // launch: resume continues the session, else it starts under this id. copy: the fork's new id (resume ignored)
  extraArgs: readonly string[]; // agentArgs[agent]
}

/** What a run's MCP config names (#99, #467): the Hive's server for this pty, or none for a local session (#587). */
export interface McpServer { port: number; ptyId: string; secret: string; withHive: boolean }

/** One server of a workspace's language-server plugin (#803), the entry its file lists per server binary: moved from worker-lsp.ts as is. */
export interface LspServerEntry { command: string; args: string[]; extensionToLanguage: Record<string, string> }
/** A workspace's servers, each named after its binary (#803). */
export type LspServers = Readonly<Record<string, LspServerEntry>>;

export interface AgentRunner {
  hostEnv: readonly string[]; // what no child of the Hive may inherit from the process the Hive was started from
  launch(run: AgentRun): LaunchArg[];
  copy(run: AgentRun, from: string, name?: string): LaunchArg[] | undefined;
  clear(run: AgentRun): LaunchArg[] | undefined;
  prepareHome(home: string, port: number): Promise<void>;
  mcpConfig(server: McpServer): string;
  lspPlugin(servers: LspServers): { path: string; content: string }[];
  transcriptDir(cwd: string, env?: NodeJS.ProcessEnv): string;
  readTurn(path: string, since?: number): Promise<TranscriptTurn>;
  countMessages(path: string): Promise<number>;
  planLimits(deps?: PlanLimitsDeps): Promise<RateLimits | undefined>;
  statusLimits(body: unknown, now: number): RateLimits | undefined;
}
