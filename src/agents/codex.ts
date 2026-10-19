// Codex behind the runner contract (#927). Every Hive setting reaches it as a `-c key=value` override on the argv (finding.codex-surface §1,
// §5, §6, §13), so a run needs no file in the user's CODEX_HOME but the workspace's plugin copy (#934, #317). Its session id is its own, learned from the first SessionStart (§3).
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS } from '../agents.js';
import { hookCommand, MCP_ROUTE, STOP_HOOK_TIMEOUT_S } from '../hooks-settings.js';
import { isRecord } from '../rate-limits.js';
import { SECRET_HEADER } from '../secret.js';
import { installShim } from '../shim.js';
import type { HookPayload } from '../types.js';
import { agentRoles, CODEX_PLUGIN, marketplaceName, roleFile, tomlString } from './codex-home.js';
import { readCodexPlanLimits } from './codex-limits.js';
import { ownsRollout, readRollout, rolloutFiles } from './codex-transcript.js';
import type { AgentRun, AgentRunner, HeadlessRun, LaunchArg } from './runner.js';

/** The variable Codex reads the MCP secret header from (env_http_headers): the value rides the run's env, never the argv every account reads through ps (#467). */
export const MCP_SECRET_ENV = 'HIVE_MCP_SECRET';

/** Every hook event the Hive reads from Codex (§1); hookPayload makes them the reducer's (#928). Codex has no Notification. */
export const CODEX_HOOK_EVENTS: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'];

const TRUST_FLAG = '--dangerously-bypass-hook-trust'; // the inline hooks run without the trust entry Codex would persist in config.toml (§1)
const MODEL_FLAG = '-m';

const override = (key: string, value: string): LaunchArg => ['-c', `${key}=${value}`];

// One hooks table per event; Stop's is held as long as an approval may hold it (#268), as Claude's is
function hookOverride(event: string, port: number): LaunchArg {
  if (event !== 'Stop') return override(`hooks.${event}`, `[{hooks=[{type="command",command=${tomlString(hookCommand(port))}}]}]`);
  return override('hooks.Stop', `[{hooks=[{type="command",command=${tomlString(hookCommand(port, STOP_HOOK_TIMEOUT_S))},timeout=${STOP_HOOK_TIMEOUT_S}}]}]`);
}

// The Hive's MCP server (#99): the pty id as a literal header, which also puts it in the argv killStray matches; the secret from the env;
// every tool approved, or each call waits on an approval (§5)
const mcpOverrides = ({ port, ptyId }: AgentRun): LaunchArg[] => [
  override('mcp_servers.hive.url', tomlString(`http://127.0.0.1:${port}${MCP_ROUTE}`)),
  override('mcp_servers.hive.http_headers', `{${tomlString('x-hive-pty')}=${tomlString(ptyId)}}`),
  override('mcp_servers.hive.env_http_headers', `{${tomlString(SECRET_HEADER)}=${tomlString(MCP_SECRET_ENV)}}`),
  override('mcp_servers.hive.default_tools_approval_mode', tomlString('approve')),
];

const LEGACY_ROLES_DIR = join('codex', 'agents'); // <home>/codex/agents: where the roles lived before #316; removed on boot

// #934, #316: the skills as the render copied the run's plugin folder into Codex's cache, by a dotted key that merges with the user's enabled
// plugins (a whole `plugins=` table would replace them); then each agent of that folder as a role, under the name the skills dispatch,
// hive:<name>. Read on every launch with no cache (about ten small files): a render may have swapped the folder since the last one
const pluginOverrides = (pluginDir: string): LaunchArg[] => [
  override(`plugins.${CODEX_PLUGIN}@${marketplaceName(pluginDir)}.enabled`, 'true'),
  ...agentRoles(pluginDir).map((role) =>
    override(`agents.${CODEX_PLUGIN}:${role.name}`, `{description=${tomlString(role.description)},config_file=${tomlString(roleFile(pluginDir, role.name))}}`)),
];

// The Hive's protocol, then a specialized agent's own instructions after a blank line (#257): Codex has no flag that runs a session as an
// agent, so the agent's body is appended to the same developer block. Neither: no override
function developerOverride({ protocolText, specializedAgent }: AgentRun): LaunchArg[] {
  const parts = [protocolText, specializedAgent?.instructions].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? [] : [override('developer_instructions', tomlString(parts.join('\n\n')))];
}

/** Every -c override of a run, in launch's order. */
export const overrides = (run: AgentRun): LaunchArg[] => [
  ...CODEX_HOOK_EVENTS.map((event) => hookOverride(event, run.port)),
  ...(run.withHive ? mcpOverrides(run) : []),
  ...pluginOverrides(run.pluginDir), // every run, local or not, as Claude's --plugin-dir: its workspace's rendered folder (#316, #317)
  // appended before Codex's own developer blocks; model_instructions_file would replace its system prompt (§6)
  ...developerOverride(run),
  override('check_for_update_on_startup', 'false'), // the update screen takes the first keys: an Enter runs npm install -g (§13)
  // nor the folder-trust screen, for a worktree Codex never saw. The path goes in the value: Codex splits a -c key on every '.', quoted or
  // not, and every worktree path holds .hive
  override('projects', `{${tomlString(run.cwd)}={trust_level=${tomlString('trusted')}}}`),
];

// resume continues Codex's own id (§7); a new run never passes the Hive's, since Codex has no --session-id (§3)
const resumeWords = (session: AgentRun['session']): string[] => (session?.resume ? ['resume', session.id] : []);

const PERMISSION_PROMPT = 'permission_prompt'; // the Notification type the reducer reads as a wait (WAITING_NOTIFICATIONS)

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// Codex has no Notification (§1): its PermissionRequest marks the wait and names the question in tool_input.description (§4)
function permissionPrompt(raw: HookPayload): HookPayload {
  const input: unknown = raw.tool_input;
  const message = nonEmpty(isRecord(input) ? input.description : undefined) ?? nonEmpty(raw.tool_name) ?? PERMISSION_PROMPT;
  return { ...raw, hook_event_name: 'Notification', notification_type: PERMISSION_PROMPT, message };
}

/** Codex's hook as the reducer reads Claude's (#928). Every field is read as unknown: nothing in a forged body throws. */
function hookPayload(raw: HookPayload): HookPayload | undefined {
  if (raw.hook_event_name === 'PermissionRequest') return permissionPrompt(raw); // a subagent's approval needs the user too
  // a subagent's hooks carry the parent's session_id (§11), so isChildSession cannot tell them; its turn ends on SubagentStop, never Stop
  if (isRecord(raw) && nonEmpty(raw.agent_id) !== undefined) return undefined;
  // the pty's exit ends the run (/hooks/exit); Codex sends SessionEnd reason=other on /clear (§8), which would free a live worker
  return raw.hook_event_name === 'SessionEnd' ? undefined : raw;
}

// #330: exec reads the prompt from stdin (-) and writes its last message, under the schema, to -o's file. A read-only sandbox, no rollout kept,
// and none of the user's config.toml or rules: a -c table merges into the user's MCP servers instead of replacing them, and an MCP server
// runs outside the sandbox, so the prompt's third-party text could reach the network through one. Auth still comes from CODEX_HOME
const headless = (run: HeadlessRun): string[] => [
  'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema', run.schemaPath,
  '-o', run.answerPath, ...(run.model === undefined ? [] : [MODEL_FLAG, run.model]), '-',
];

export const codexRunner: AgentRunner = {
  hostEnv: [MCP_SECRET_ENV], // a Hive started inside a Codex run never hands the outer secret to its own children
  launch: (run) => [...resumeWords(run.session), ...overrides(run), TRUST_FLAG, ...run.extraArgs, ...(run.model === undefined ? [] : [MODEL_FLAG, run.model])],
  // A fork is a new Codex id holding the source's turns (§7), under the same overrides as a launch. No -m: a copy runs no stage, as
  // Claude's passes none. No name: fork has no name flag, the Hive's entry carries it. Never the placeholder id: Codex has no --session-id (§3)
  copy: (run, from) => ['fork', from, ...overrides(run), TRUST_FLAG, ...run.extraArgs],
  clear: () => undefined, // a clear is /clear typed inside the session (SessionStart source=clear, §8), as Claude's
  headless,
  headlessAnswer: (_stdout, answerFile) => (answerFile?.trim() ? answerFile.trim() : undefined), // stdout is exec's progress, never the answer
  // its shim (#932) and the roles' old folder (#316). Each workspace's plugin copy and roles are the render's (plugin-render.ts); the run
  // inherits the Hive's CODEX_HOME, so it reads them
  prepareHome: async (home) => {
    await installShim(home, AGENTS.codex);
    await rm(join(home, LEGACY_ROLES_DIR), { recursive: true, force: true });
  },
  mcpConfig: () => '', // the server goes through -c: writeMcpConfig writes no file
  lspPlugin: () => [],
  transcriptDir: () => undefined, // #929: rollouts live under date folders, not per cwd: removal and copy find nothing in a dir
  ownsTranscript: (path, _cwd, sessionId, env) => ownsRollout(path, sessionId, env),
  sessionFiles: (cwd, id, env) => rolloutFiles(id, cwd, env),
  readTurn: (path, since) => readRollout(path, since),
  countMessages: () => Promise.resolve(0),
  planLimits: (deps) => readCodexPlanLimits(deps), // #929: from the newest rollout's rate_limits
  statusLimits: () => undefined,
  strayPattern: (ptyId) => ptyId, // in the x-hive-pty header's literal (§12)
  runEnv: ({ secret, withHive }): Record<string, string> => (withHive ? { [MCP_SECRET_ENV]: secret } : {}),
  hookPayload,
};
