// Copilot's hooks (#874, node 2 of #608). The Hive's hooks plugin is one folder of its home that every run loads with a second --plugin-dir
// (spike §1). Its hooks.json is in Claude's format, so the payloads come in Claude's field names (spike §2)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hookCommand, STOP_HOOK_TIMEOUT_S } from '../hooks-settings.js';
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

/** Every payload dropped until node 2: none would move a worker the reducer's way yet. */
export const hookPayload = (): HookPayload | undefined => undefined;
