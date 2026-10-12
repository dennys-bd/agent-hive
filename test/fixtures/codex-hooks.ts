import type { HookPayload } from '../../src/types.js';

// Codex's hook bodies as finding.codex-surface recorded them (§1, §2, §4, §11), every id and path made up. The route casts req.body to
// HookPayload; Codex's own keys (model, permission_mode, agent_id, stop_hook_active, …) ride along unread, as they do here.
export const CODEX_SESSION = '01a12d45-1dff-7000-8000-0000000000aa';
export const QUESTION = 'Do you want to allow opening the pull request with gh pr create?';
export const PR_URL = 'https://github.com/o/r/pull/7';
/** What a subagent's hooks add (§11): its id and role, beside the parent's session_id. */
export const SUBAGENT = { agent_id: 'agent-7f3a', agent_type: 'hive-reviewer' };

const COMMON = {
  session_id: CODEX_SESSION, transcript_path: '/codex-home/sessions/2026/10/11/rollout-2026-10-11T20-21-06-01a12d45.jsonl', cwd: '/wt',
  model: 'gpt-5.6-luna', permission_mode: 'default',
};

/** One Codex hook body: the common keys, the event, then `fields` (which may override any of them, a forged body's included). */
export const codexHook = (event: string, fields: object = {}): HookPayload => ({ ...COMMON, hook_event_name: event, ...fields }) as HookPayload;

const PR_CREATE = { tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' } };

/** One approved turn in the order §4 recorded it: the stage opens, asks to run gh pr create, is approved, and ends. */
export const CODEX_TURN = {
  SessionStart: codexHook('SessionStart', { source: 'startup' }),
  UserPromptSubmit: codexHook('UserPromptSubmit', { prompt: '/hive-build' }),
  PreToolUse: codexHook('PreToolUse', PR_CREATE),
  PermissionRequest: codexHook('PermissionRequest', { tool_name: 'Bash', tool_input: { ...PR_CREATE.tool_input, description: QUESTION } }),
  PostToolUse: codexHook('PostToolUse', { ...PR_CREATE, tool_response: PR_URL }),
  Stop: codexHook('Stop', { stop_hook_active: false, last_assistant_message: 'Opened the PR.' }),
} as const;
