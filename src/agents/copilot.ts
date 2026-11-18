// GitHub Copilot CLI behind the runner contract (#873, node 1 of #608). Everything reaches a run by flags and env (spike §1): the workspace's
// plugin and the Hive's hooks plugin as two --plugin-dir, the MCP servers in the run's 0600 file, the protocol as an instructions file in the
// run's own tmp dir. Nothing is written into the user's Copilot home. Hooks, headless, transcripts and limits are their modules' (nodes 2, 5, 6, 7).
import { dirname, join } from 'node:path';
import { AGENTS } from '../agents.js';
import { MCP_ROUTE, mcpConfigPattern } from '../hooks-settings.js';
import { posixShell } from '../posix-shell.js';
import { runTmpDir } from '../run-tmp.js';
import { SECRET_HEADER } from '../secret.js';
import { installShim } from '../shim.js';
import { HEADLESS_MCP, headless, headlessAnswer, headlessEnv, headlessPrompt } from './copilot-headless.js';
import { copilotHooksPlugin, hookPayload, writeCopilotHooksPlugin } from './copilot-hooks.js';
import { readCopilotPlanLimits } from './copilot-limits.js';
import { countMessages, ownsTranscript, readTurn, sessionFiles, transcriptDir } from './copilot-transcript.js';
import type { AgentRun, AgentRunner, LaunchArg, McpServer, RunMcpServer } from './runner.js';

const PROMPT_FLAG = '-i'; // copilot takes no positional prompt; -i starts the TUI and runs it (the decomposition's Design)
const MODEL_FLAG = '--model';
const AGENT_FLAG = '--agent'; // hive:<name>: the plugin's agent file is the session's agent (spike §1); a tools line is not copied as Claude's is (#758)
const ALLOW_HIVE = '--allow-tool=hive'; // the Hive's server without approval prompts; one word, since --allow-tool takes several values
const INSTRUCTIONS_FILE = 'hive.instructions.md'; // only *.instructions.md loads from COPILOT_CUSTOM_INSTRUCTIONS_DIRS (spike §1)
const APPLY_TO_ALL = '---\napplyTo: "**"\n---\n\n';
const ALL_TOOLS: readonly string[] = ['*']; // which of a server's tools load, not which are approved (spike §1)

/** The run's instructions folder, in its own tmp dir (#428), so it goes with the run. */
export const instructionsDir = (ptyId: string): string => join(runTmpDir(ptyId), 'copilot-instructions');

type McpEntry =
  | { type: 'http'; url: string; headers?: Record<string, string>; tools: readonly string[] }
  | { type: 'stdio'; command: string; args: readonly string[]; tools: readonly string[] };

// The pty id and the secret as literal headers, as Claude's file holds them: Copilot sent the file's headers on every request (spike §1)
const hiveEntry = ({ port, ptyId, secret }: McpServer): McpEntry =>
  ({ type: 'http', url: `http://127.0.0.1:${port}${MCP_ROUTE}`, headers: { 'x-hive-pty': ptyId, [SECRET_HEADER]: secret }, tools: ALL_TOOLS });

// #333: a command as stdio, a URL as http with its header; their tools keep Copilot's own prompts (only the Hive's are allowed)
const externalEntry = (server: RunMcpServer): McpEntry => ('command' in server
  ? { type: 'stdio', command: server.command, args: server.args, tools: ALL_TOOLS }
  : { type: 'http', url: server.url, ...(server.header ? { headers: { [server.header.name]: server.header.value } } : {}), tools: ALL_TOOLS });

const mcpConfig = (server: McpServer): string => `${JSON.stringify({
  mcpServers: { ...(server.withHive ? { hive: hiveEntry(server) } : {}), ...Object.fromEntries(server.external.map((s) => [s.name, externalEntry(s)])) },
}, null, 2)}\n`;

const flag = (name: string, value: string | undefined): LaunchArg[] => (value === undefined ? [] : [[name, value]]);

// The hooks plugin sits in the Hive's home, whose only path a run carries is hooksPath (<home>/hooks.json, hooksPath())
const hooksPlugin = (run: AgentRun): string => copilotHooksPlugin(dirname(run.hooksPath));

// The Hive's flags first, as Claude's: both plugins, the MCP file as one @<path> value, the Hive's tools allowed
const hiveFlags = (run: AgentRun): LaunchArg[] => [
  ...flag('--plugin-dir', run.pluginDir), ...flag('--plugin-dir', hooksPlugin(run)),
  ...flag('--additional-mcp-config', run.mcpPath === undefined ? undefined : `@${run.mcpPath}`),
  ...(run.withHive ? [ALLOW_HIVE] : []),
];

// new: the id the Hive chose; resume: the session's own (spike §3). Copilot refuses the two together
const sessionWords = (session: AgentRun['session']): string[] =>
  (session === undefined ? [] : [session.resume ? '--resume' : '--session-id', session.id]);

// The agent and the model last, as Claude's dialog line shows them
const tailWords = ({ specializedAgent, model }: AgentRun): string[] => [
  ...(specializedAgent === undefined ? [] : [AGENT_FLAG, specializedAgent.name]),
  ...(model === undefined ? [] : [MODEL_FLAG, model]),
];

// The protocol is appended to Copilot's own prompt, frontmatter and all (spike §1)
const runFiles = ({ ptyId, protocolText }: AgentRun): { path: string; content: string }[] =>
  (protocolText === undefined ? [] : [{ path: join(instructionsDir(ptyId), INSTRUCTIONS_FILE), content: `${APPLY_TO_ALL}${protocolText}` }]);

// No update check at start, a resume stays in the folder the Hive started it in (spike §3, §8), and the instructions folder only with its file
const copilotEnv = ({ ptyId, protocolText }: AgentRun): Record<string, string> => ({
  COPILOT_AUTO_UPDATE: 'false', COPILOT_DISABLE_RESUME_AUTO_CD: '1',
  ...(protocolText === undefined ? {} : { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: instructionsDir(ptyId) }),
});

export const copilotRunner: AgentRunner = {
  // An inherited COPILOT_ALLOW_ALL=true would trust every folder and approve every tool in every run; the Hive never sets it, and the user's shell must not either
  hostEnv: ['COPILOT_ALLOW_ALL'],
  promptFlag: PROMPT_FLAG,
  launch: (run) => [...hiveFlags(run), ...sessionWords(run.session), ...run.extraArgs, ...tailWords(run)],
  copy: () => undefined, // node 3
  clear: () => undefined, // node 3
  headlessMcp: HEADLESS_MCP,
  headless,
  headlessAnswer,
  headlessPrompt,
  headlessEnv,
  strayPattern: (ptyId) => mcpConfigPattern(ptyId), // its --additional-mcp-config path holds the pty id, as Claude's --mcp-config does
  runEnv: (_server, run) => copilotEnv(run), // the secret is in the 0600 MCP file, never in the env
  runFiles,
  hookPayload,
  // its shim (#932's pattern), then the hooks plugin every run's second --plugin-dir names; nothing in the user's Copilot home
  prepareHome: async (home, port) => {
    await installShim(home, AGENTS.copilot, { platform: process.platform, sh: posixShell().shell });
    await writeCopilotHooksPlugin(home, port); // #874: the hook command carries the boot's port
  },
  mcpConfig,
  lspPlugin: () => [], // the workspace's language servers are out of scope (#873)
  transcriptDir,
  ownsTranscript,
  sessionFiles,
  readTurn,
  countMessages,
  planLimits: () => readCopilotPlanLimits(),
  statusLimits: () => undefined,
};
