import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { AGENTS } from '../../src/agents.js';
import { codexRunner } from '../../src/agents/codex.js';
import { tomlString } from '../../src/agents/codex-home.js';
import type { AgentRun } from '../../src/agents/runner.js';
import { hookCommand, STOP_HOOK_TIMEOUT_S } from '../../src/hooks-settings.js';
import { shimPath } from '../../src/shim.js';
import { ptyCommand } from '../../src/spawn.js';
import type { HookPayload, LaunchArg } from '../../src/types.js';
import { SECRET } from '../secret-client.js';
import { codexHook, CODEX_TURN, QUESTION, SUBAGENT } from '../fixtures/codex-hooks.js';
import { tempDir } from '../temp-dir.js';

// Codex's argv, word for word (#927, finding.codex-surface §1, §5, §6, §7, §13): every Hive setting is a `-c key=value` pair, the trust
// bypass, the agent's own args, the model; the prompt is ptyCommand's last word, as Claude's.
const PTY = 'c0dec0de-0000-4000-8000-000000000001';
const ID = '01a12d45-1dff-7000-8000-000000000001';
const CWD = '/repo/.hive/worktrees/hive-1-task';
const PROMPT = '/h/prompts/hive-1-task.md';
const PROTOCOL = 'Call hive_done when "done".\nA path: C:\\work\\x\tand a tab.';
const RUN: AgentRun = { ptyId: PTY, cwd: CWD, port: 4242, withHive: true, hooksPath: '/h/hooks.json', pluginDir: '/h/plugin', extraArgs: [] };

const hook = (event: string): LaunchArg => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hookCommand(4242))}}]}]`];
const STOP: LaunchArg = ['-c', `hooks.Stop=[{hooks=[{type="command",command=${JSON.stringify(hookCommand(4242, STOP_HOOK_TIMEOUT_S))},timeout=${STOP_HOOK_TIMEOUT_S}}]}]`];
const HOOKS: LaunchArg[] = [hook('SessionStart'), hook('UserPromptSubmit'), hook('PreToolUse'), hook('PostToolUse'), hook('PermissionRequest'), STOP, hook('SessionEnd')];
const MCP: LaunchArg[] = [
  ['-c', 'mcp_servers.hive.url="http://127.0.0.1:4242/hooks/mcp"'],
  ['-c', `mcp_servers.hive.http_headers={"x-hive-pty"="${PTY}"}`],
  ['-c', 'mcp_servers.hive.env_http_headers={"x-hive-secret"="HIVE_MCP_SECRET"}'],
  ['-c', 'mcp_servers.hive.default_tools_approval_mode="approve"'],
];
const PROTOCOL_ARG: LaunchArg = ['-c', `developer_instructions=${JSON.stringify(PROTOCOL)}`];
const STARTUP: LaunchArg[] = [['-c', 'check_for_update_on_startup=false'], ['-c', `projects={"${CWD}"={trust_level="trusted"}}`]];
const TAIL = ['--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write', '-m', 'gpt-5.6-terra'];
const STAGE_RUN: AgentRun = { ...RUN, protocolText: PROTOCOL, model: 'gpt-5.6-terra', extraArgs: ['--sandbox', 'workspace-write'] };

test('a new stage run: the hooks, the MCP server, the protocol, the startup switches, the trust bypass, the agent\'s args, the model; never the Hive\'s id (#927)', () => {
  const argv = codexRunner.launch({ ...STAGE_RUN, session: { id: ID, resume: false } });
  assert.deepEqual(argv, [...HOOKS, ...MCP, PROTOCOL_ARG, ...STARTUP, ...TAIL]);
  assert.equal(JSON.stringify(argv).includes(ID), false, 'Codex picks its own session id (finding §3)');
});

test('a resume is `resume <id>` followed by the same overrides (#927)', () => {
  assert.deepEqual(codexRunner.launch({ ...STAGE_RUN, session: { id: ID, resume: true } }), ['resume', ID, ...HOOKS, ...MCP, PROTOCOL_ARG, ...STARTUP, ...TAIL]);
});

test('no model has no -m, no protocol text no developer_instructions, and a run without the Hive\'s server no mcp_servers.hive key (#927)', () => {
  const argv = codexRunner.launch({ ...RUN, withHive: false });
  assert.deepEqual(argv, [...HOOKS, ...STARTUP, '--dangerously-bypass-hook-trust']);
  assert.equal(argv.flat().some((word) => word.startsWith('mcp_servers.hive')), false);
});

test('the MCP secret is in the run\'s env, never in an argv word; a run without the Hive\'s server gets none (#927)', () => {
  const server = { port: 4242, ptyId: PTY, secret: SECRET, withHive: true };
  assert.deepEqual(codexRunner.runEnv(server), { HIVE_MCP_SECRET: SECRET });
  assert.deepEqual(codexRunner.runEnv({ ...server, withHive: false }), {});
  assert.equal(JSON.stringify(codexRunner.launch(STAGE_RUN)).includes(SECRET), false);
});

test('tomlString writes a TOML basic string: quotes, backslashes, newlines, tabs and DEL round-trip through JSON.parse (#927)', () => {
  const text = 'say "hi"\\ there\nnext\tline\u007f end';
  const rendered = tomlString(text);
  assert.equal(JSON.parse(rendered), text);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the raw control characters TOML refuses is the point
  assert.doesNotMatch(rendered, /[\u0000-\u0008\u000a-\u001f\u007f]/, 'TOML refuses these unescaped');
});

test('the command line runs codex bare with every override quoted whole and the prompt last (#927)', () => {
  const line = ptyCommand({ ptyId: PTY, slug: 'hive-1-task', cwd: CWD, port: 4242, promptPath: PROMPT, agent: { command: 'codex', argv: codexRunner.launch(STAGE_RUN) } });
  assert.ok(line.startsWith(`cd '${CWD}' && HIVE_PTY_ID=${PTY} HIVE_PORT=4242 codex -c 'hooks.SessionStart=[{hooks=[{type="command",command="curl -sf -m 30 -X POST http://127.0.0.1:4242/hooks/event `), line);
  assert.ok(line.includes(` '--dangerously-bypass-hook-trust' '--sandbox' 'workspace-write' '-m' 'gpt-5.6-terra' "$(cat '${PROMPT}')"; curl `), line);
});

test('Codex\'s stray pattern is the pty id; copy and clear wait for #933; it reads no transcript or limits yet (#927)', async () => {
  assert.equal(codexRunner.strayPattern(PTY), PTY);
  assert.deepEqual([codexRunner.copy(RUN, ID), codexRunner.clear(RUN)], [undefined, undefined]);
  assert.deepEqual([codexRunner.hostEnv, codexRunner.mcpConfig({ port: 4242, ptyId: PTY, secret: SECRET, withHive: true }), codexRunner.lspPlugin({})], [['HIVE_MCP_SECRET'], '', []]);
  assert.equal(codexRunner.transcriptDir('/repo'), '', 'no dirname is empty: the transcript guard drops every Codex path (#929)');
  await assert.rejects(codexRunner.readTurn('/x.jsonl'));
  assert.deepEqual([await codexRunner.countMessages('/x.jsonl'), await codexRunner.planLimits(), codexRunner.statusLimits({}, 0)], [0, undefined, undefined]);
});

test('prepareHome writes an executable <home>/bin/codex: the codex shim, which registers as codex (#932)', async (t) => {
  const home = await tempDir(t, 'home-');
  await codexRunner.prepareHome(home, 4242);
  const path = shimPath(home, AGENTS.codex);
  assert.equal((await stat(path)).mode & 0o777, 0o755);
  assert.match(await readFile(path, 'utf8'), /^cli=codex$/m);
});

test('a PermissionRequest becomes the permission_prompt Notification the reducer reads, its description the question (#928, finding §4)', () => {
  const request = CODEX_TURN.PermissionRequest;
  assert.deepEqual(codexRunner.hookPayload(request), { ...request, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: QUESTION });
});

test('a PermissionRequest with no usable description asks with its tool name, and with neither with permission_prompt (#928)', () => {
  const asked = (fields: object): string | undefined => codexRunner.hookPayload(codexHook('PermissionRequest', fields))?.message;
  for (const input of [{ command: 'gh pr create' }, { description: '' }, { description: 42 }, 'gh pr create', null, [QUESTION]]) {
    assert.equal(asked({ tool_name: 'Bash', tool_input: input }), 'Bash', JSON.stringify(input));
  }
  for (const name of [undefined, '', 7]) assert.equal(asked({ tool_name: name, tool_input: {} }), 'permission_prompt', String(name));
});

test('a subagent\'s hook is dropped whatever its event, but its PermissionRequest still asks the user (#928, finding §11)', () => {
  for (const payload of Object.values(CODEX_TURN).filter((p) => p.hook_event_name !== 'PermissionRequest')) {
    assert.equal(codexRunner.hookPayload(codexHook(payload.hook_event_name, { ...payload, ...SUBAGENT })), undefined, payload.hook_event_name);
  }
  const subagentAsks = codexRunner.hookPayload(codexHook('PermissionRequest', { ...CODEX_TURN.PermissionRequest, ...SUBAGENT }));
  assert.deepEqual([subagentAsks?.hook_event_name, subagentAsks?.message], ['Notification', QUESTION]);
  for (const agentId of ['', 42, null]) {
    assert.equal(codexRunner.hookPayload(codexHook('Stop', { agent_id: agentId }))?.hook_event_name, 'Stop', `${String(agentId)}: not a subagent's id`);
  }
});

test('SessionEnd is dropped: the pty\'s exit ends the run, and Codex sends one with reason=other on /clear (#928, finding §8)', () => {
  for (const reason of ['other', 'clear', 'logout']) assert.equal(codexRunner.hookPayload(codexHook('SessionEnd', { reason })), undefined, reason);
});

test('SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop reach the reducer as Codex sent them (#928, finding §1)', () => {
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const) {
    assert.equal(codexRunner.hookPayload(CODEX_TURN[event]), CODEX_TURN[event], event);
  }
});

test('a forged body never throws: odd event names, tool inputs, tool names and agent ids are read as unknown (#928)', () => {
  const forged: HookPayload[] = [
    codexHook('Stop', { hook_event_name: 42 }),
    codexHook('PermissionRequest', { tool_input: { description: { toString: null } } }),
    codexHook('PermissionRequest', { tool_name: ['x'], tool_input: 'y' }),
    codexHook('Stop', { agent_id: { id: 'x' } }),
  ];
  for (const body of forged) assert.doesNotThrow(() => codexRunner.hookPayload(body), JSON.stringify(body));
});
