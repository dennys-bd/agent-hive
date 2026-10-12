// Codex behind the runner contract (#927). Every Hive setting reaches it as a `-c key=value` override on the argv (finding.codex-surface §1,
// §5, §6, §13), so a run needs no file in the user's CODEX_HOME. Its session id is its own, learned from the first SessionStart (§3).
import { hookCommand, MCP_ROUTE, STOP_HOOK_TIMEOUT_S } from '../hooks-settings.js';
import { isRecord } from '../rate-limits.js';
import { SECRET_HEADER } from '../secret.js';
import type { HookPayload } from '../types.js';
import type { AgentRun, AgentRunner, LaunchArg } from './runner.js';

/** The variable Codex reads the MCP secret header from (env_http_headers): the value rides the run's env, never the argv every account reads through ps (#467). */
export const MCP_SECRET_ENV = 'HIVE_MCP_SECRET';

/** Every hook event the Hive reads from Codex (§1); hookPayload makes them the reducer's (#928). Codex has no Notification. */
export const CODEX_HOOK_EVENTS: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'];

const TRUST_FLAG = '--dangerously-bypass-hook-trust'; // the inline hooks run without the trust entry Codex would persist in config.toml (§1)
const MODEL_FLAG = '-m';

/** A TOML basic string: JSON's escapes are TOML's, except DEL, which TOML wants escaped and JSON leaves raw. */
export const tomlString = (text: string): string => JSON.stringify(text).replace(/\u007f/g, '\\u007f');

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

/** Every -c override of a run, in launch's order. */
export const overrides = (run: AgentRun): LaunchArg[] => [
  ...CODEX_HOOK_EVENTS.map((event) => hookOverride(event, run.port)),
  ...(run.withHive ? mcpOverrides(run) : []),
  // appended before Codex's own developer blocks; model_instructions_file would replace its system prompt (§6)
  ...(run.protocolText === undefined ? [] : [override('developer_instructions', tomlString(run.protocolText))]),
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

export const codexRunner: AgentRunner = {
  hostEnv: [MCP_SECRET_ENV], // a Hive started inside a Codex run never hands the outer secret to its own children
  launch: (run) => [...resumeWords(run.session), ...overrides(run), TRUST_FLAG, ...run.extraArgs, ...(run.model === undefined ? [] : [MODEL_FLAG, run.model])],
  copy: () => undefined, // #933
  clear: () => undefined, // #933
  prepareHome: () => Promise.resolve(), // the shim is #932, the plugin #934
  mcpConfig: () => '', // the server goes through -c: writeMcpConfig writes no file
  lspPlugin: () => [],
  // #929: inert until usage is read. No dirname is '', so the transcript guard drops every Codex path, and the server records no tokens
  transcriptDir: () => '',
  readTurn: () => Promise.reject(new Error('codex transcripts are read from #929 on')),
  countMessages: () => Promise.resolve(0),
  planLimits: () => Promise.resolve(undefined),
  statusLimits: () => undefined,
  strayPattern: (ptyId) => ptyId, // in the x-hive-pty header's literal (§12)
  runEnv: ({ secret, withHive }): Record<string, string> => (withHive ? { [MCP_SECRET_ENV]: secret } : {}),
  hookPayload,
};
