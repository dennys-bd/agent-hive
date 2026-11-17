import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COPILOT_HOOK_EVENTS, copilotHooksPlugin, hookPayload, writeCopilotHooksPlugin } from '../../src/agents/copilot-hooks.js';
import { hookCommand, STOP_HOOK_TIMEOUT_S } from '../../src/hooks-settings.js';
import type { HookPayload } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';

const hooksOf = async (home: string) => JSON.parse(await readFile(join(copilotHooksPlugin(home), 'hooks', 'hooks.json'), 'utf8')).hooks;

test('the hooks plugin registers six events in Claude\'s format, every one the port\'s command, no matcher; Stop held as long as an approval under both timeout keys (#874)', async (t) => {
  const home = join(await tempDir(t, 'copilot-hooks-'), 'home');
  await writeCopilotHooksPlugin(home, 4242);
  const hooks = await hooksOf(home);
  assert.deepEqual(COPILOT_HOOK_EVENTS, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']);
  assert.deepEqual(Object.keys(hooks), [...COPILOT_HOOK_EVENTS], 'no PermissionRequest, no SessionEnd');
  for (const event of COPILOT_HOOK_EVENTS.filter((e) => e !== 'Stop')) {
    assert.deepEqual(hooks[event], [{ hooks: [{ type: 'command', command: hookCommand(4242) }] }], event);
  }
  assert.deepEqual(hooks.Stop, [{ hooks: [{ type: 'command', command: hookCommand(4242, STOP_HOOK_TIMEOUT_S), timeout: STOP_HOOK_TIMEOUT_S, timeoutSec: STOP_HOOK_TIMEOUT_S }] }]);
});

test('the plugin keeps its manifest, is rewritten for each boot\'s port, and writes nothing outside the home (#874)', async (t) => {
  const root = await tempDir(t, 'copilot-hooks-');
  const home = join(root, 'home');
  await writeCopilotHooksPlugin(home, 4242);
  await writeCopilotHooksPlugin(home, 5151);
  assert.equal(JSON.parse(await readFile(join(copilotHooksPlugin(home), '.claude-plugin', 'plugin.json'), 'utf8')).name, 'hive-hooks');
  assert.equal((await hooksOf(home)).PostToolUse[0].hooks[0].command, hookCommand(5151));
  assert.deepEqual([await readdir(root), await readdir(home)], [['home'], ['copilot']]);
});

// Copilot's hook bodies as spike §2 recorded them, converted to Claude's field names where the spike recorded native ones; every id and path
// made up. The route casts req.body to HookPayload, so Copilot's own keys (timestamp, title, stop_reason, …) ride along unread, as here
const SESSION = 'c0b11075-5e55-4000-8000-000000000001';
const COMMON = { session_id: SESSION, timestamp: '2026-11-17T10:00:00.000Z', cwd: '/repo/.hive/worktrees/hive-1-task' };
const copilotHook = (event: string, fields: object = {}): HookPayload => ({ ...COMMON, hook_event_name: event, ...fields }) as HookPayload;
const BASH = { tool_name: 'bash', tool_input: { command: 'echo hi > made.txt' } };
const TURN = {
  SessionStart: copilotHook('SessionStart', { source: 'new', initial_prompt: 'Run this shell command: echo hi > made.txt' }),
  Resumed: copilotHook('SessionStart', { source: 'resume' }),
  UserPromptSubmit: copilotHook('UserPromptSubmit', { prompt: 'Run this shell command: echo hi > made.txt' }),
  PreToolUse: copilotHook('PreToolUse', BASH),
  Approval: copilotHook('Notification', { notification_type: 'permission_prompt', title: 'Permission needed', message: 'Run command: echo hi > made.txt' }),
  PostToolUse: copilotHook('PostToolUse', { ...BASH, tool_response: '' }),
  Elicitation: copilotHook('Notification', { notification_type: 'elicitation_dialog', title: 'Information requested', message: 'Pick your preferred color' }),
  Stop: copilotHook('Stop', { transcript_path: `/copilot-home/session-state/${SESSION}/events.jsonl`, stop_reason: 'end_turn', stop_hook_active: false }),
} as const;

test('every event of a turn reaches the reducer as Copilot sent it, the same object, SessionStart\'s source included (#874, spike §2)', () => {
  for (const [name, payload] of Object.entries(TURN)) assert.equal(hookPayload(payload), payload, name);
});

test('native toolName and toolArgs fill tool_name and tool_input when missing: a JSON string parsed, an object kept, a malformed string dropped (#874)', () => {
  const native = (toolArgs: unknown): HookPayload | undefined => hookPayload(copilotHook('PostToolUse', { toolName: 'bash', toolArgs }));
  const parsed = native('{"command":"gh pr create --fill"}');
  assert.deepEqual([parsed?.tool_name, parsed?.tool_input], ['bash', { command: 'gh pr create --fill' }]);
  assert.deepEqual(native({ command: 'ls' })?.tool_input, { command: 'ls' });
  const malformed = native('{"command":');
  assert.deepEqual([malformed?.tool_name, malformed !== undefined && 'tool_input' in malformed], ['bash', false]);
  const both = hookPayload(copilotHook('PostToolUse', { ...BASH, toolName: 'other', toolArgs: '{"command":"x"}' }));
  assert.deepEqual([both?.tool_name, both?.tool_input], ['bash', BASH.tool_input], 'Claude\'s fields win');
});

test('PermissionRequest, SessionEnd and a subagent\'s own hooks are dropped; an empty or non-string agent_id is no subagent (#874, spike §2, §3)', () => {
  assert.equal(hookPayload(copilotHook('PermissionRequest', BASH)), undefined, 'it fires under auto-approval too');
  for (const reason of ['complete', 'user_exit']) assert.equal(hookPayload(copilotHook('SessionEnd', { reason })), undefined, reason);
  const subagent = { session_id: 'eb79a357-0000-4000-8000-000000000002', agent_id: 'eb79a357-0000-4000-8000-000000000002', agent_type: 'hive:probe-agent' };
  for (const event of ['UserPromptSubmit', 'Stop']) assert.equal(hookPayload(copilotHook(event, subagent)), undefined, event);
  for (const agentId of ['', 42, null]) assert.equal(hookPayload(copilotHook('Stop', { agent_id: agentId }))?.hook_event_name, 'Stop', String(agentId));
});

test('a forged body never throws: an object agent_id, a number toolArgs, no hook_event_name (#874)', () => {
  const forged: HookPayload[] = [
    copilotHook('Stop', { agent_id: { id: 'x' } }),
    copilotHook('PostToolUse', { toolName: 7, toolArgs: 42 }),
    copilotHook('PostToolUse', { toolArgs: '[1,2]' }),
    { ...COMMON } as unknown as HookPayload,
  ];
  for (const body of forged) assert.doesNotThrow(() => hookPayload(body), JSON.stringify(body));
  assert.equal('tool_input' in (hookPayload(forged[1]!) ?? {}), false);
});
