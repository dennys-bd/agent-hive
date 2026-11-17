import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENTS } from '../../src/agents.js';
import { copilotRunner, instructionsDir } from '../../src/agents/copilot.js';
import { copilotHome } from '../../src/agents/copilot-home.js';
import { copilotHooksPlugin } from '../../src/agents/copilot-hooks.js';
import type { AgentRun, McpServer, RunMcpServer } from '../../src/agents/runner.js';
import { runTmpDir } from '../../src/run-tmp.js';
import { shimPath } from '../../src/shim.js';
import { ptyCommand } from '../../src/spawn.js';
import type { LaunchArg } from '../../src/types.js';
import { SECRET } from '../secret-client.js';
import { tempDir } from '../temp-dir.js';

// Copilot's argv, word for word (#873, spike §1, §3, §5): the Hive's flags first (both plugins, the MCP file, its tools allowed), the session
// words, the agent's own args, the specialized agent and the model last; the prompt is ptyCommand's, behind -i.
const PTY = 'c0b11075-0000-4000-8000-000000000001';
const ID = '01a12d45-1dff-7000-8000-000000000001';
const PLUGIN = '/h/plugins/agent-hive';
const MCP = `/h/prompts/${PTY}.mcp.json`;
const PROMPT = '/h/prompts/hive-1-task.md';
const PROTOCOL = 'Call hive_done when "done".\nA second line.';
const TOKEN = 'not-a-real-token-0123456789abcdef'; // an external server's header value, as credentials.json would resolve it
const HOOKS_PLUGIN = copilotHooksPlugin('/h'); // the home of hooksPath '/h/hooks.json'
const EXTERNAL: RunMcpServer[] = [
  { name: 'docs', url: 'https://mcp.example.com/mcp', header: { name: 'Authorization', value: `Bearer ${TOKEN}` } },
  { name: 'plain', url: 'https://plain.example.com/mcp' },
  { name: 'fs', command: 'npx', args: ['-y', 'fs-server'] },
];
const RUN: AgentRun = { ptyId: PTY, cwd: '/repo/.hive/worktrees/hive-1-task', port: 4242, withHive: true, external: EXTERNAL, hooksPath: '/h/hooks.json', pluginDir: PLUGIN, mcpPath: MCP, extraArgs: [] };
const SERVER: McpServer = { port: 4242, ptyId: PTY, secret: SECRET, withHive: true, external: EXTERNAL };
const HIVE: LaunchArg[] = [['--plugin-dir', PLUGIN], ['--plugin-dir', HOOKS_PLUGIN], ['--additional-mcp-config', `@${MCP}`], '--allow-tool=hive'];
const NEW = { id: ID, resume: false };

// No argv word may carry the MCP secret or an external server's header value: every account reads the argv through ps (#467)
function assertNoSecret(argv: LaunchArg[]): void {
  for (const word of argv.flat()) assert.equal(word.includes(SECRET) || word.includes(TOKEN), false, word);
}

test('a new session: both plugins, the MCP file as one @value, the Hive\'s tools allowed, then --session-id with the Hive\'s id (#873)', () => {
  const argv = copilotRunner.launch({ ...RUN, session: NEW });
  assert.deepEqual(argv, [...HIVE, '--session-id', ID]);
  assertNoSecret(argv);
});

test('a resume is --resume <id> after the Hive\'s flags, never with --session-id (#873, spike §3)', () => {
  const argv = copilotRunner.launch({ ...RUN, session: { id: ID, resume: true } });
  assert.deepEqual(argv, [...HIVE, '--resume', ID]);
  assertNoSecret(argv);
});

test('the agent\'s own args follow the session words, the model is last behind --model (#873)', () => {
  const argv = copilotRunner.launch({ ...RUN, session: NEW, extraArgs: ['--reasoning-effort', 'low'], model: 'claude-sonnet-5.5' });
  assert.deepEqual(argv, [...HIVE, '--session-id', ID, '--reasoning-effort', 'low', '--model', 'claude-sonnet-5.5']);
  assertNoSecret(argv);
});

test('a specialized agent is --agent hive:<name> as is, before the model, even with a tools line: no copy of it (#873, #758)', () => {
  const specializedAgent = { name: 'hive:planner', description: 'plans', instructions: 'You plan.', tools: ['Read', 'Grep'] };
  const argv = copilotRunner.launch({ ...RUN, session: NEW, specializedAgent, model: 'auto' });
  assert.deepEqual(argv, [...HIVE, '--session-id', ID, '--agent', 'hive:planner', '--model', 'auto']);
  assertNoSecret(argv);
});

test('a run without the Hive\'s server allows no hive tool; no session, no session words (#873)', () => {
  const argv = copilotRunner.launch({ ...RUN, withHive: false });
  assert.deepEqual(argv, [['--plugin-dir', PLUGIN], ['--plugin-dir', HOOKS_PLUGIN], ['--additional-mcp-config', `@${MCP}`]]);
  assertNoSecret(argv);
});

test('the MCP file: the Hive\'s server with its literal headers, a URL server as http with its header when it has one, a command as stdio, every one all tools (#873, spike §1)', () => {
  const tools = ['*'];
  assert.deepEqual(JSON.parse(copilotRunner.mcpConfig(SERVER)), {
    mcpServers: {
      hive: { type: 'http', url: 'http://127.0.0.1:4242/hooks/mcp', headers: { 'x-hive-pty': PTY, 'x-hive-secret': SECRET }, tools },
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` }, tools },
      plain: { type: 'http', url: 'https://plain.example.com/mcp', tools },
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs-server'], tools },
    },
  });
  assert.deepEqual(Object.keys(JSON.parse(copilotRunner.mcpConfig({ ...SERVER, withHive: false })).mcpServers), ['docs', 'plain', 'fs']);
});

test('the run\'s env: no update check, no resume cd, the instructions folder in its own tmp dir; the protocol file there with applyTo "**" (#873)', () => {
  const run = { ...RUN, protocolText: PROTOCOL };
  const dir = join(runTmpDir(PTY), 'copilot-instructions');
  assert.equal(instructionsDir(PTY), dir);
  assert.deepEqual(copilotRunner.runEnv(SERVER, run), { COPILOT_AUTO_UPDATE: 'false', COPILOT_DISABLE_RESUME_AUTO_CD: '1', COPILOT_CUSTOM_INSTRUCTIONS_DIRS: dir });
  assert.deepEqual(copilotRunner.runFiles(run), [{ path: join(dir, 'hive.instructions.md'), content: `---\napplyTo: "**"\n---\n\n${PROTOCOL}` }]);
  assert.equal(JSON.stringify(copilotRunner.runEnv(SERVER, run)).includes(SECRET), false, 'the secret is in the 0600 MCP file');
});

test('no protocol text: no file and no instructions variable (#873)', () => {
  assert.deepEqual(copilotRunner.runFiles(RUN), []);
  assert.deepEqual(copilotRunner.runEnv(SERVER, RUN), { COPILOT_AUTO_UPDATE: 'false', COPILOT_DISABLE_RESUME_AUTO_CD: '1' });
});

test('the stray pattern matches the argv\'s MCP path; the command line runs copilot with the prompt behind -i, last (#873)', () => {
  const argv = copilotRunner.launch({ ...RUN, session: NEW });
  assert.match(`@${MCP}`, new RegExp(copilotRunner.strayPattern(PTY)));
  assert.equal(copilotRunner.promptFlag, '-i');
  const line = ptyCommand({ ptyId: PTY, slug: 'hive-1-task', cwd: RUN.cwd, port: 4242, promptPath: PROMPT, agent: { command: 'copilot', argv, promptFlag: copilotRunner.promptFlag } });
  assert.ok(line.includes(`'copilot' --plugin-dir '${PLUGIN}' --plugin-dir '${HOOKS_PLUGIN}' --additional-mcp-config '@${MCP}' '--allow-tool=hive' '--session-id' '${ID}' -i "$(cat '${PROMPT}')"; curl `), line);
  assert.equal(line.includes(SECRET), false);
});

test('copy, clear, headless, hooks, transcripts and limits answer their placeholders until nodes 2 to 7 (#873)', async () => {
  assert.deepEqual([copilotRunner.copy(RUN, ID), copilotRunner.clear(RUN), copilotRunner.hostEnv, copilotRunner.lspPlugin({}), copilotRunner.headlessMcp], [undefined, undefined, [], [], false]);
  assert.throws(() => copilotRunner.headless({ dir: '/t', schema: '{}', schemaPath: '/t/s', answerPath: '/t/a' }), { message: 'copilot: headless runs are not supported yet' });
  assert.equal(copilotRunner.headlessAnswer('{}', undefined), undefined);
  assert.equal(copilotRunner.hookPayload({ hook_event_name: 'Stop', session_id: ID }), undefined);
  assert.deepEqual([copilotRunner.transcriptDir('/repo'), copilotRunner.ownsTranscript('/x', '/repo', ID)], [undefined, false]);
  assert.deepEqual(await copilotRunner.sessionFiles('/repo', ID), []);
  assert.deepEqual(await copilotRunner.readTurn('/x.jsonl'), { tokens: 0 });
  assert.deepEqual([await copilotRunner.countMessages('/x.jsonl'), await copilotRunner.planLimits(), copilotRunner.statusLimits({}, 0)], [0, undefined, undefined]);
});

test('prepareHome writes the empty hooks plugin under the Hive\'s home: a manifest Copilot loads and no hook yet (#873)', async (t) => {
  const home = await tempDir(t, 'copilot-home-');
  await copilotRunner.prepareHome(home, 4242);
  assert.equal(copilotHooksPlugin(home), join(home, 'copilot', 'hooks-plugin'));
  assert.equal(JSON.parse(await readFile(join(copilotHooksPlugin(home), '.claude-plugin', 'plugin.json'), 'utf8')).name, 'hive-hooks');
  assert.deepEqual(JSON.parse(await readFile(join(copilotHooksPlugin(home), 'hooks', 'hooks.json'), 'utf8')), { hooks: {} });
  assert.ok(existsSync(shimPath(home, AGENTS.copilot)), 'its shim, as every agent boot found');
});

test('copilotHome is $COPILOT_HOME when set and not empty, else ~/.copilot (#873, spike §6)', () => {
  assert.equal(copilotHome({ COPILOT_HOME: join('/c', 'home') }), join('/c', 'home'));
  assert.equal(copilotHome({}), join(homedir(), '.copilot'));
  assert.equal(copilotHome({ COPILOT_HOME: '' }), join(homedir(), '.copilot'));
});
