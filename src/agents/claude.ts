// Claude Code behind the runner contract (#924): the argv every run of it gets, and the modules that know its home, its transcripts and its
// plan limits. The argv is the one the Hive always passed, word for word: its own flags as [flag, value] pairs, every other word plain.
import { claudeLspPlugin, claudeMcpConfig, prepareClaudeHome } from './claude-home.js';
import { mcpConfigPattern } from '../hooks-settings.js';
import { parseRateLimits, readPlanLimits } from './claude-limits.js';
import { countMessages, ownsTranscript, readTranscript, sessionFiles, transcriptDir } from './claude-transcript.js';
import type { AgentRun, AgentRunner, LaunchArg } from './runner.js';

const MODEL_FLAG = '--model'; // what a stage's modelo is passed behind, as typed (#516)
const PROTOCOL_FLAG = '--append-system-prompt-file'; // the Hive's protocol (#167): appended to Claude Code's own system prompt, never replacing it
const AGENT_FLAG = '--agent'; // #257: the plugin agent a free session runs as, hive:<name>

// #257: before the model, as the dialog's runs line shows it
const agentWords = ({ specializedAgent }: AgentRun): string[] => (specializedAgent === undefined ? [] : [AGENT_FLAG, specializedAgent.name]);

const flag = (name: string, value: string | undefined): LaunchArg[] => (value === undefined ? [] : [[name, value]]);

// The Hive's own flags in the order the command line always had them: --settings right after --mcp-config ends that flag's list of values,
// or the plugin dir or the prompt would be read as a second config. The workspace's language servers (#803) are a second --plugin-dir
const hiveFlags = (run: AgentRun): LaunchArg[] => [
  ...flag('--mcp-config', run.mcpPath), ...flag('--settings', run.hooksPath), ...flag('--plugin-dir', run.pluginDir),
  ...flag('--plugin-dir', run.lspPluginDir), ...flag(PROTOCOL_FLAG, run.protocolPath),
];

// new: the Hive generated the id; resume: the session's own. No session at all leaves the choice to Claude Code
const sessionWords = (session: AgentRun['session']): string[] =>
  (session === undefined ? [] : [session.resume ? '--resume' : '--session-id', session.id]);

// #587: the source resumed as a new session under the id the reducer chose, so the new transcript and its SessionStart carry that id; the
// dialog's name as the fork's own title, `--name=` so a name starting with `-` is never an option
const copyWords = (from: string, id: string, name: string | undefined): string[] =>
  ['--resume', from, '--fork-session', '--session-id', id, ...(name === undefined ? [] : [`--name=${name}`])];

export const claudeRunner: AgentRunner = {
  // CLAUDECODE: a Hive started from inside Claude Code would stop the child from starting; CLAUDE_CODE_CHILD_SESSION turns its transcript off
  hostEnv: ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION'],
  launch: (run) => [...hiveFlags(run), ...run.extraArgs, ...agentWords(run), ...(run.model === undefined ? [] : [MODEL_FLAG, run.model]), ...sessionWords(run.session)],
  copy: (run, from, name) => (run.session === undefined ? undefined : [...hiveFlags(run), ...run.extraArgs, ...copyWords(from, run.session.id, name)]),
  clear: () => undefined, // a clear is /clear typed inside the session (SessionStart source=clear): there is no argv to render
  strayPattern: (ptyId) => mcpConfigPattern(ptyId), // its --mcp-config path holds the pty id (#696)
  runEnv: () => ({}), // the secret is in its MCP file (0600) and curl's header file
  hookPayload: (raw) => raw, // the reducer's hook rules are Claude Code's own events (#928)
  // Arrows on purpose: registry.ts sits in import cycles with usage.ts and transcript.ts, and an arrow reads the binding at call time
  prepareHome: (home, port) => prepareClaudeHome(home, port),
  mcpConfig: (server) => claudeMcpConfig(server),
  lspPlugin: (servers) => claudeLspPlugin(servers),
  transcriptDir: (cwd, env) => transcriptDir(cwd, env),
  ownsTranscript: (path, cwd, sessionId, env) => ownsTranscript(path, cwd, sessionId, env),
  sessionFiles: (cwd, id, env) => Promise.resolve(sessionFiles(cwd, id, env)),
  readTurn: (path, since) => readTranscript(path, since),
  countMessages: (path) => countMessages(path),
  planLimits: (deps) => readPlanLimits(deps),
  statusLimits: (body, now) => parseRateLimits(body, new Date(now)),
};
