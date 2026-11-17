// Copilot's hooks (#874, node 2 of #608). The Hive's hooks plugin is one folder of its home that every run loads with a second --plugin-dir
// (spike §1). Its hooks.json is in Claude's format, so the payloads come in Claude's field names (spike §2)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hookCommand, STOP_HOOK_TIMEOUT_S } from '../hooks-settings.js';
import { isRecord } from '../rate-limits.js';
import type { HookPayload } from '../types.js';

/** Every hook event the Hive registers for Copilot (#874). No PermissionRequest: it fires under auto-approval too (spike §2). No SessionEnd:
 * the pty's exit ends the run, and /clear sends one for a live worker (spike §3). */
export const COPILOT_HOOK_EVENTS: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];

const MANIFEST = { name: 'hive-hooks', description: 'The Hive\'s hooks for its Copilot runs (#873)', version: '1.0.0' };
const asFile = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Stop is held as long as an approval may hold it (#268). Claude's format names the key timeout and Copilot's own timeoutSec; nothing says
// which one Copilot reads in Claude's format, and the one it ignores costs nothing. No matcher: every tool's PostToolUse may end a wait (#874)
const STOP = (port: number) => ({ type: 'command', command: hookCommand(port, STOP_HOOK_TIMEOUT_S), timeout: STOP_HOOK_TIMEOUT_S, timeoutSec: STOP_HOOK_TIMEOUT_S });
const entry = (event: string, port: number) => ({ hooks: [event === 'Stop' ? STOP(port) : { type: 'command', command: hookCommand(port) }] });

/** <home>/copilot/hooks-plugin: what every run's second --plugin-dir names. No I/O. */
export const copilotHooksPlugin = (home: string): string => join(home, 'copilot', 'hooks-plugin');

/** The hooks plugin, rewritten on every boot as Claude's hooks.json is, since the command carries the port. One file serves every run: the
 * command reads the pty id and the secret file from the run's env. */
export async function writeCopilotHooksPlugin(home: string, port: number): Promise<void> {
  const dir = copilotHooksPlugin(home);
  await Promise.all([mkdir(join(dir, '.claude-plugin'), { recursive: true }), mkdir(join(dir, 'hooks'), { recursive: true })]);
  const hooks = Object.fromEntries(COPILOT_HOOK_EVENTS.map((event) => [event, [entry(event, port)]]));
  await Promise.all([
    writeFile(join(dir, '.claude-plugin', 'plugin.json'), asFile(MANIFEST)),
    writeFile(join(dir, 'hooks', 'hooks.json'), asFile({ hooks })),
  ]);
}

// PermissionRequest fires under auto-approval too, so it is no wait (spike §2); the pty's exit ends the run, and /clear sends a SessionEnd for a
// live worker (spike §3). Neither is registered; one that arrives anyway is dropped
const DROPPED: readonly string[] = ['PermissionRequest', 'SessionEnd'];

// toolArgs is a JSON string in Copilot's native payload (spike §2); only an object reaches tool_input, where describeTool and the PR check read it
function toolArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return isRecord(value) ? value : undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined; // a forged or cut string: no tool input, as a payload without one
  }
}

// The spike recorded only native tool payloads, so Claude's tool_name / tool_input win and Copilot's toolName / toolArgs fill them when missing
function withToolFields(raw: HookPayload & Record<string, unknown>): HookPayload {
  const name = raw.tool_name ?? (typeof raw.toolName === 'string' ? raw.toolName : undefined);
  const input = raw.tool_input ?? toolArgs(raw.toolArgs);
  if (name === raw.tool_name && input === raw.tool_input) return raw;
  return { ...raw, ...(name === undefined ? {} : { tool_name: name }), ...(input === undefined ? {} : { tool_input: input }) };
}

/** Copilot's hook as the reducer reads Claude's (#874). Every field is read as unknown: nothing in a forged body throws. */
export function hookPayload(raw: HookPayload): HookPayload | undefined {
  if (DROPPED.includes(raw.hook_event_name)) return undefined;
  if (!isRecord(raw)) return raw;
  // a subagent's own prompt and Stop carry its id as session_id plus agent_id (spike §2): its prompt would turn the worker green
  if (typeof raw.agent_id === 'string' && raw.agent_id !== '') return undefined;
  return withToolFields(raw);
}
