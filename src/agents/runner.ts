// The contract every coding agent's runner meets (#924): a plain object of pure functions, one per agent in registry.ts. Shared code reads an
// agent's flags, files and formats only through it; the agent's facts (label, command, subcommands, planLimits) stay in agents.ts, which the
// page reads too.
import type { HookPayload, LaunchArg, RateLimits } from '../types.js';
import type { TranscriptTurn } from '../usage.js';
import type { PlanLimitsDeps } from './claude-limits.js';

export type { LaunchArg };

/** Everything a runner needs to render one run's argv after its command. */
export interface AgentRun {
  ptyId: string;
  cwd: string; // #927: the folder the run starts in: Codex trusts it up front, or its TUI opens on the folder-trust screen
  port: number; // #927: the Hive's port, which Codex's inline hooks and MCP url name (Claude's read hooks.json and its MCP file)
  withHive: boolean; // #927: a task's run has the Hive's MCP server; a local session (#587) none
  hooksPath: string;
  pluginDir: string;
  mcpPath?: string;
  lspPluginDir?: string;
  protocolPath?: string;
  protocolText?: string; // #927: protocolPath's content, read by the shared spawn, for an agent that takes the protocol as text (Codex)
  model?: string;
  session?: { id: string; resume: boolean }; // launch: resume continues the session, else it starts under this id. copy: the fork's new id (resume ignored)
  extraArgs: readonly string[]; // agentArgs[agent], then a free session's own args (#257)
  specializedAgent?: { name: string; instructions: string }; // #257: a plugin agent the session runs as: Claude gets the name, Codex the instructions
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
  strayPattern(ptyId: string): string; // #927: what killStray / isStrayAlive match in this agent's argv for the run of ptyId
  runEnv(server: McpServer): Record<string, string>; // #927: what the run's env carries for this agent, over the workspace's (the MCP secret for Codex)
  // #928: the agent's hook as the reducer reads it, before anything else reads it; undefined drops it. The body is any local process's
  hookPayload(raw: HookPayload): HookPayload | undefined;
  prepareHome(home: string, port: number): Promise<void>;
  mcpConfig(server: McpServer): string;
  lspPlugin(servers: LspServers): { path: string; content: string }[];
  transcriptDir(cwd: string, env?: NodeJS.ProcessEnv): string | undefined; // #929: undefined when transcripts are not kept per cwd (Codex)
  // #929: cwd: Claude keys transcripts by it, Codex ignores it; sessionId pins the file to that session (Codex owns nothing without one)
  ownsTranscript(path: string, cwd: string, sessionId: string | undefined, env?: NodeJS.ProcessEnv): boolean;
  sessionFiles(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv): Promise<string[]>; // #929: what deleting the session's transcripts removes
  readTurn(path: string, since?: number): Promise<TranscriptTurn>;
  countMessages(path: string): Promise<number>;
  planLimits(deps?: PlanLimitsDeps): Promise<RateLimits | undefined>;
  statusLimits(body: unknown, now: number): RateLimits | undefined;
}
