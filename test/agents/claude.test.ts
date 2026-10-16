import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS } from '../../src/agents.js';
import { runners } from '../../src/agents/registry.js';
import type { AgentRun, HeadlessRun } from '../../src/agents/runner.js';
import { ptyCommand } from '../../src/spawn.js';
import { shellQuote } from '../../src/shell-init.js';
import type { HookPayload, LaunchArg } from '../../src/types.js';
import { mcpConfigPattern } from '../../src/hooks-settings.js';

// Claude's argv, byte for byte (#924). The literals below are what the Hive handed claude before its runner existed (Task 1 checked them
// against that code); the runner must keep them. The Hive's own flags are [flag, value] pairs, which the command line renders bare with the
// value quoted; every other word is quoted whole.
interface Expected { flags: [string, string][]; words: string[] }

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const FROM = 'b1b2c3d4-0000-4000-8000-000000000002';
const MCP = '/h/prompts/W1.mcp.json';
const HOOKS = '/h/hooks.json';
const PLUGIN = '/h/plugin';
const LSP = "/h/lsp/it's hive";
const STAGE_MD = '/h/protocol/workspaces/hive/stage.md';
const SESSION_MD = '/h/protocol/workspaces/hive/session.md';
const PROMPT = '/h/prompts/hive-1-task.md';
const EXTRA = ['--permission-mode', 'auto'];
const NAME = "-x it's mine";

const NEW_STAGE_RUN: Expected = {
  flags: [['--mcp-config', MCP], ['--settings', HOOKS], ['--plugin-dir', PLUGIN], ['--plugin-dir', LSP], ['--append-system-prompt-file', STAGE_MD]],
  words: [...EXTRA, '--model', 'sonnet', '--session-id', ID],
};
const BARE_RUN: Expected = { flags: [['--settings', HOOKS], ['--plugin-dir', PLUGIN]], words: ['--session-id', ID] };
const RESUME: Expected = { flags: [['--mcp-config', MCP], ['--settings', HOOKS], ['--plugin-dir', PLUGIN]], words: [...EXTRA, '--resume', ID] };
const CAPTURE: Expected = {
  flags: [['--mcp-config', MCP], ['--settings', HOOKS], ['--plugin-dir', PLUGIN], ['--plugin-dir', LSP], ['--append-system-prompt-file', SESSION_MD]],
  words: [...EXTRA, '--session-id', ID],
};
const COPY: Expected = {
  flags: [['--mcp-config', MCP], ['--settings', HOOKS], ['--plugin-dir', PLUGIN]],
  words: [...EXTRA, '--resume', FROM, '--fork-session', '--session-id', ID],
};
const NAMED_COPY: Expected = { flags: COPY.flags, words: [...COPY.words, `--name=${NAME}`] };

const flat = ({ flags, words }: Expected): string[] => [...flags.flat(), ...words];
const argvOf = ({ flags, words }: Expected): LaunchArg[] => [...flags, ...words];
const TRAILER = `curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`;
// The command line a run renders to: the flags bare with their values quoted, the quoted words, the prompt last
const commandOf = ({ flags, words }: Expected, prompt?: string): string => {
  const parts = [...flags.map(([flag, value]) => `${flag} ${shellQuote(value)}`), ...words.map(shellQuote), ...(prompt === undefined ? [] : [`"$(cat ${shellQuote(prompt)})"`])];
  return `cd '/wt' && HIVE_PTY_ID=W1 HIVE_PORT=4242 claude ${parts.join(' ')}; ${TRAILER}`;
};

const RUN: AgentRun = { ptyId: 'W1', cwd: '/wt', port: 4242, withHive: true, hooksPath: HOOKS, pluginDir: PLUGIN, extraArgs: [] };
// ptyCommand over the runner's argv, as the spawner builds the launch
const commandFor = (argv: LaunchArg[], prompt?: string): string =>
  ptyCommand({ ptyId: 'W1', slug: 'hive-1-task', cwd: '/wt', port: 4242, ...(prompt === undefined ? {} : { promptPath: prompt }), agent: { command: AGENTS.claude.command, argv } });

test('a new stage run with the MCP, the protocol, the language-server plugin and a model: the pinned argv and command line (#924)', () => {
  const argv = runners.claude.launch({ ...RUN, mcpPath: MCP, lspPluginDir: LSP, protocolPath: STAGE_MD, model: 'sonnet', session: { id: ID, resume: false }, extraArgs: EXTRA });
  assert.deepEqual(argv, argvOf(NEW_STAGE_RUN));
  assert.deepEqual(argv.flat(), flat(NEW_STAGE_RUN));
  assert.equal(commandFor(argv, PROMPT), commandOf(NEW_STAGE_RUN, PROMPT));
});

test('a new run without the MCP, the protocol, the plugin, a model or extra args: the pinned argv and command line (#924)', () => {
  const argv = runners.claude.launch({ ...RUN, session: { id: ID, resume: false } });
  assert.deepEqual(argv.flat(), flat(BARE_RUN));
  assert.equal(commandFor(argv), commandOf(BARE_RUN));
});

test('a resume: the pinned argv and command line (#924)', () => {
  const argv = runners.claude.launch({ ...RUN, mcpPath: MCP, session: { id: ID, resume: true }, extraArgs: EXTRA });
  assert.deepEqual(argv.flat(), flat(RESUME));
  assert.equal(commandFor(argv), commandOf(RESUME));
});

test("the shim's capture: the pinned argv, which the register sends flat (#924)", () => {
  const argv = runners.claude.launch({ ...RUN, mcpPath: MCP, lspPluginDir: LSP, protocolPath: SESSION_MD, session: { id: ID, resume: false }, extraArgs: EXTRA });
  assert.deepEqual(argv.flat(), flat(CAPTURE));
});

test('a copy, with and without a name: the pinned argv and command line; no session, no copy; clear has no argv (#924)', () => {
  const run: AgentRun = { ...RUN, mcpPath: MCP, session: { id: ID, resume: true }, extraArgs: EXTRA };
  const copy = runners.claude.copy(run, FROM);
  assert.deepEqual(copy, argvOf(COPY), 'resume is ignored: the copy always starts under the new id');
  assert.equal(commandFor(copy ?? []), commandOf(COPY));
  const named = runners.claude.copy(run, FROM, NAME);
  assert.deepEqual(named?.flat(), flat(NAMED_COPY));
  assert.equal(commandFor(named ?? []), commandOf(NAMED_COPY));
  assert.equal(runners.claude.copy({ ...run, session: undefined }, FROM), undefined);
  assert.equal(runners.claude.clear(run), undefined);
});

test('Claude\'s stray pattern is its MCP config path, its run needs no env of its own, and it keeps the protocol as a path (#927)', () => {
  assert.equal(runners.claude.strayPattern('W1'), mcpConfigPattern('W1'));
  assert.deepEqual(runners.claude.runEnv({ port: 4242, ptyId: 'W1', secret: 'not-in-argv', withHive: true }), {});
  const argv = runners.claude.launch({ ...RUN, protocolPath: STAGE_MD, protocolText: 'PROTOCOL-TEXT', session: { id: ID, resume: false } });
  assert.equal(JSON.stringify(argv).includes('PROTOCOL-TEXT'), false, 'the text is for an agent that takes it so');
  assert.deepEqual(argv.flat(), [...flat({ flags: [['--settings', HOOKS], ['--plugin-dir', PLUGIN], ['--append-system-prompt-file', STAGE_MD]], words: [] }), '--session-id', ID]);
});

test('Claude\'s hooks reach the reducer as Claude Code sends them: the same payload back (#928)', () => {
  const payloads: HookPayload[] = [
    { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' },
    { hook_event_name: 'SessionEnd', reason: 'other' },
    { hook_event_name: 'PermissionRequest' }, // Claude does not subscribe to it: whatever posts it, nothing of Claude's moves
  ];
  for (const payload of payloads) assert.equal(runners.claude.hookPayload(payload), payload, payload.hook_event_name);
});

test('Claude owns a .jsonl directly in its transcript dir and, with a session id, only that session\'s; deleting a session lists <id>.jsonl and <id>/ (#929)', async () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg' };
  const own = `/cfg/projects/-repo/${ID}.jsonl`;
  assert.equal(runners.claude.ownsTranscript(own, '/repo', undefined, env), true, 'no session id: the folder check alone, as before');
  assert.equal(runners.claude.ownsTranscript(own, '/repo', ID, env), true);
  assert.equal(runners.claude.ownsTranscript(`/cfg/projects/-repo/${FROM}.jsonl`, '/repo', ID, env), false, 'another session in the same folder');
  assert.equal(runners.claude.ownsTranscript(`/cfg/projects/-repo-x/${ID}.jsonl`, '/repo', ID, env), false);
  assert.deepEqual(await runners.claude.sessionFiles('/repo', ID, env), [own, `/cfg/projects/-repo/${ID}`]);
});

test('a specialized agent goes behind --agent, after the agent\'s args and before --model; none adds nothing (#257)', () => {
  const run: AgentRun = { ...RUN, model: 'opus', session: { id: ID, resume: false }, extraArgs: EXTRA, specializedAgent: { name: 'hive:designer', instructions: 'Design.' } };
  assert.deepEqual(runners.claude.launch(run).slice(-8), [...EXTRA, '--agent', 'hive:designer', '--model', 'opus', '--session-id', ID]);
  const { specializedAgent: _gone, ...plain } = run;
  assert.deepEqual(runners.claude.launch(plain).slice(-6), [...EXTRA, '--model', 'opus', '--session-id', ID]);
  assert.equal(runners.claude.launch(plain).includes('--agent'), false);
});

const HEADLESS: HeadlessRun = { dir: '/t', schema: '{"type":"object"}', schemaPath: '/t/schema.json', answerPath: '/t/answer.txt' };

test('the headless run asks for JSON under the schema, with no tool, MCP server, saved session or slash command; --model only when given (#330)', () => {
  const base = ['-p', '--output-format', 'json', '--json-schema', '{"type":"object"}', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'];
  assert.deepEqual(runners.claude.headless(HEADLESS), base);
  assert.deepEqual(runners.claude.headless({ ...HEADLESS, model: 'opus' }), [...base, '--model', 'opus']);
});

test("headlessAnswer reads Claude's structured_output, else its result; an error result or a stdout that is not JSON is no answer (#330)", () => {
  const answer = (stdout: string): string | undefined => runners.claude.headlessAnswer(stdout, undefined);
  assert.equal(answer('{"type":"result","is_error":false,"result":"","structured_output":{"from":1,"to":2,"text":"x"}}'), '{"from":1,"to":2,"text":"x"}');
  assert.equal(answer('{"type":"result","is_error":false,"structured_output":"{\\"from\\":1}"}'), '{"from":1}');
  assert.equal(answer('{"type":"result","is_error":false,"result":"{\\"from\\":1}"}'), '{"from":1}');
  assert.equal(answer('{"type":"result","is_error":true,"result":"rate limited"}'), undefined);
  assert.equal(answer('{"type":"result","is_error":false,"result":""}'), undefined);
  assert.equal(answer('not json'), undefined);
});
