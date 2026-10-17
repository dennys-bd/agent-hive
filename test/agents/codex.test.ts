import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENTS } from '../../src/agents.js';
import { codexRunner } from '../../src/agents/codex.js';
import { agentRoles, marketplaceName, roleFile, tomlString } from '../../src/agents/codex-home.js';
import type { AgentRun, HeadlessRun } from '../../src/agents/runner.js';
import { hookCommand, pluginSource, STOP_HOOK_TIMEOUT_S } from '../../src/hooks-settings.js';
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
const PLUGIN_FOLDER = pluginSource(); // #316: a run's roles are read from its own plugin folder, so the fixture's folder must hold agents
const RUN: AgentRun = { ptyId: PTY, cwd: CWD, port: 4242, withHive: true, hooksPath: '/h/hooks.json', pluginDir: PLUGIN_FOLDER, extraArgs: [] };

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
// #934, #316: the skills as the render copied the run's folder into Codex's cache, then one role per agent of that folder
const MARKETPLACE = marketplaceName(PLUGIN_FOLDER);
const PLUGIN: LaunchArg = ['-c', `plugins.hive@${MARKETPLACE}.enabled=true`];
const AGENT_NAMES = ['architect', 'build-fixer', 'code-reviewer', 'design-reviewer', 'designer', 'plan-reviewer', 'planner', 'security-reviewer', 'spec-reviewer', 'tdd'];
const ROLES: LaunchArg[] = agentRoles(PLUGIN_FOLDER).map((role) => ['-c', `agents.hive:${role.name}={description=${JSON.stringify(role.description)},config_file=${tomlString(roleFile(PLUGIN_FOLDER, role.name))}}`]);
const HIVE_PLUGIN: LaunchArg[] = [PLUGIN, ...ROLES];
const TAIL = ['--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write', '-m', 'gpt-5.6-terra'];
const STAGE_RUN: AgentRun = { ...RUN, protocolText: PROTOCOL, model: 'gpt-5.6-terra', extraArgs: ['--sandbox', 'workspace-write'] };
const FROM = '01a12d45-1dff-7000-8000-000000000002'; // the source session a copy forks (#933)

test('a new stage run: the hooks, the MCP server, the protocol, the startup switches, the trust bypass, the agent\'s args, the model; never the Hive\'s id (#927)', () => {
  const argv = codexRunner.launch({ ...STAGE_RUN, session: { id: ID, resume: false } });
  assert.deepEqual(argv, [...HOOKS, ...MCP, ...HIVE_PLUGIN, PROTOCOL_ARG, ...STARTUP, ...TAIL]);
  assert.equal(JSON.stringify(argv).includes(ID), false, 'Codex picks its own session id (finding §3)');
});

test('a resume is `resume <id>` followed by the same overrides (#927)', () => {
  assert.deepEqual(codexRunner.launch({ ...STAGE_RUN, session: { id: ID, resume: true } }), ['resume', ID, ...HOOKS, ...MCP, ...HIVE_PLUGIN, PROTOCOL_ARG, ...STARTUP, ...TAIL]);
});

test('no model has no -m, no protocol text no developer_instructions, and a run without the Hive\'s server no mcp_servers.hive key (#927)', () => {
  const argv = codexRunner.launch({ ...RUN, withHive: false });
  assert.deepEqual(argv, [...HOOKS, ...HIVE_PLUGIN, ...STARTUP, '--dangerously-bypass-hook-trust']);
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

test('a copy is `fork <from>` followed by the same overrides, the trust bypass and the agent\'s args: no -m, no name, never the Hive\'s placeholder id (#933)', () => {
  const argv = codexRunner.copy({ ...STAGE_RUN, session: { id: ID, resume: false } }, FROM, 'no dois');
  assert.deepEqual(argv, ['fork', FROM, ...HOOKS, ...MCP, ...HIVE_PLUGIN, PROTOCOL_ARG, ...STARTUP, '--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write']);
  assert.equal(JSON.stringify(argv).includes(ID), false, 'Codex picks the fork\'s id (finding §7)');
  assert.equal(JSON.stringify(argv).includes('no dois'), false, 'codex fork has no name flag: the Hive\'s entry carries it');
});

test('a local copy (no Hive server) forks with no mcp_servers.hive key (#933)', () => {
  const argv = codexRunner.copy({ ...RUN, withHive: false }, FROM);
  assert.deepEqual(argv, ['fork', FROM, ...HOOKS, ...HIVE_PLUGIN, ...STARTUP, '--dangerously-bypass-hook-trust']);
  assert.equal(argv?.flat().some((word) => word.startsWith('mcp_servers.hive')), false);
});

test('Codex\'s stray pattern is the pty id; a clear has no argv (it is /clear typed in the session); its rollouts are no per-cwd dir (#927, #929, #933)', async (t) => {
  assert.equal(codexRunner.strayPattern(PTY), PTY);
  assert.equal(codexRunner.clear(RUN), undefined);
  assert.deepEqual([codexRunner.hostEnv, codexRunner.mcpConfig({ port: 4242, ptyId: PTY, secret: SECRET, withHive: true }), codexRunner.lspPlugin({})], [['HIVE_MCP_SECRET'], '', []]);
  assert.equal(codexRunner.transcriptDir('/repo'), undefined, 'no per-cwd dir: removal and copy find nothing there (#929)');
  assert.equal(codexRunner.ownsTranscript(`/codex-home/sessions/2026/10/12/rollout-x-${ID}.jsonl`, '/repo', ID, { CODEX_HOME: '/codex-home' }), true);
  await assert.rejects(codexRunner.readTurn('/x.jsonl'));
  assert.deepEqual([await codexRunner.countMessages('/x.jsonl'), await codexRunner.planLimits({ env: { CODEX_HOME: await tempDir(t, 'codex-') } }), codexRunner.statusLimits({}, 0)], [0, undefined, undefined]);
});

test('prepareHome writes the codex shim and removes the old <home>/codex/agents; it prepares no plugin folder, since every run loads its workspace\'s render (#932, #317)', async (t) => {
  const home = await tempDir(t, 'home-');
  const codex = await tempDir(t, 'codex-');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codex;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  await mkdir(join(home, 'codex', 'agents'), { recursive: true });
  await writeFile(join(home, 'codex', 'agents', 'tdd.toml'), 'old');
  await codexRunner.prepareHome(home, 4242);
  const path = shimPath(home, AGENTS.codex);
  assert.equal((await stat(path)).mode & 0o777, 0o755);
  assert.match(await readFile(path, 'utf8'), /^cli=codex$/m);
  await assert.rejects(stat(join(home, 'codex', 'agents')), { code: 'ENOENT' });
  assert.equal(existsSync(join(home, '.codex')), false, 'no fallback roles');
  assert.deepEqual(await readdir(codex), [], 'nothing in Codex\'s home');
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

test('every run enables the Hive\'s plugin by a dotted key and names one hive:<name> role per agent, word for word; never the whole plugins table (#934)', () => {
  assert.deepEqual(ROLES.map(([, pair]) => pair.slice('agents.hive:'.length, pair.indexOf('='))), AGENT_NAMES);
  assert.deepEqual(ROLES[0], ['-c', `agents.hive:architect={description="System design specialist. Consulted on the architectural path of /hive:new-spec, before the spec is written, for trade-offs between approaches, component boundaries and interface changes. Returns a recommendation; never writes files.",config_file=${tomlString(roleFile(PLUGIN_FOLDER, 'architect'))}}`]);
  for (const run of [STAGE_RUN, { ...RUN, withHive: false }]) {
    const words = codexRunner.launch(run).flat();
    assert.ok(words.includes(PLUGIN[1]), 'a local run too, as Claude\'s --plugin-dir');
    assert.equal(words.some((word) => word.startsWith('plugins=') || word.startsWith('agents=')), false, 'a whole table replaces the user\'s');
  }
});

test('the run\'s plugin folder names its marketplace and its roles: another workspace\'s folder is another marketplace with roles of its own (#934, #316)', async (t) => {
  const other = join(await tempDir(t, 'home-'), 'plugins', 'b');
  await cp(pluginSource(), other, { recursive: true });
  const words = codexRunner.launch({ ...RUN, pluginDir: other }).flat();
  assert.notEqual(marketplaceName(other), MARKETPLACE);
  assert.ok(words.includes(`plugins.hive@${marketplaceName(other)}.enabled=true`));
  assert.ok(words.some((word) => word.startsWith('agents.hive:tdd=') && word.endsWith(`config_file=${tomlString(join(dirname(other), '.codex', 'b', 'tdd.toml'))}}`)));
});

// The text of a launch's developer_instructions override, as Codex reads the TOML string
const developerText = (run: AgentRun): string | undefined =>
  codexRunner.launch(run).flatMap((arg) => (typeof arg !== 'string' && arg[1].startsWith('developer_instructions=') ? [JSON.parse(arg[1].slice('developer_instructions='.length)) as string] : []))[0];

test('a specialized agent\'s instructions follow the protocol after a blank line in developer_instructions; a run with no protocol has them alone (#257)', () => {
  const designer = { name: 'hive:designer', instructions: 'You design.\nWith "care".' };
  assert.equal(developerText({ ...STAGE_RUN, specializedAgent: designer }), `${PROTOCOL}\n\n${designer.instructions}`);
  assert.equal(developerText({ ...RUN, withHive: false, specializedAgent: designer }), designer.instructions);
  assert.equal(developerText(STAGE_RUN), PROTOCOL, 'no agent: the protocol alone, as before');
  assert.equal(developerText(RUN), undefined);
});

const HEADLESS: HeadlessRun = { dir: '/t', schema: '{"type":"object"}', schemaPath: '/t/schema.json', answerPath: '/t/answer.txt' };

test('the headless run is exec in a read-only sandbox, no session kept, none of the user config (so none of its MCP servers), the schema and the -o file; -m only when given; the prompt on stdin (#330)', () => {
  const head = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema', '/t/schema.json', '-o', '/t/answer.txt'];
  assert.deepEqual(codexRunner.headless(HEADLESS), [...head, '-']);
  assert.deepEqual(codexRunner.headless({ ...HEADLESS, model: 'gpt-5' }), [...head, '-m', 'gpt-5', '-']);
});

test("headlessAnswer reads Codex's -o file, never its stdout; a missing or blank file is no answer (#330)", () => {
  assert.equal(codexRunner.headlessAnswer('progress lines', '{"from":1,"to":1,"text":"x"}\n'), '{"from":1,"to":1,"text":"x"}');
  assert.equal(codexRunner.headlessAnswer('{"from":1}', undefined), undefined);
  assert.equal(codexRunner.headlessAnswer('', '  \n'), undefined);
});
