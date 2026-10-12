import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturedArgs } from '../../src/claude-shim.js';
import { copyArgs, ptyCommand, runArgs, shellQuote } from '../../src/spawn.js';

// Claude's argv, byte for byte (#924). The literals below are what the Hive handed claude before its runner existed, checked here against
// the code that built them then; the runner must keep them. The Hive's own flags are [flag, value] pairs, which the command line renders
// bare with the value quoted; every other word is quoted whole.
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
const TRAILER = `curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-pty: W1' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`;
// The command line a run renders to: the flags bare with their values quoted, the quoted words, the prompt last
const commandOf = ({ flags, words }: Expected, prompt?: string): string => {
  const parts = [...flags.map(([flag, value]) => `${flag} ${shellQuote(value)}`), ...words.map(shellQuote), ...(prompt === undefined ? [] : [`"$(cat ${shellQuote(prompt)})"`])];
  return `cd '/wt' && HIVE_PTY_ID=W1 HIVE_PORT=4242 claude ${parts.join(' ')}; ${TRAILER}`;
};

const BASE = { ptyId: 'W1', slug: 'hive-1-task', cwd: '/wt', port: 4242, hooksPath: HOOKS, pluginDir: PLUGIN };

test('today: a new stage run with the MCP, the protocol, the language-server plugin and a model renders the pinned argv (#924)', () => {
  const args = runArgs({ sessionId: ID }, { model: 'sonnet' }, 'new', EXTRA, 'claude');
  assert.deepEqual(args, NEW_STAGE_RUN.words);
  assert.equal(ptyCommand({ ...BASE, mcpPath: MCP, lspPluginDir: LSP, protocolPath: STAGE_MD, promptPath: PROMPT, args }), commandOf(NEW_STAGE_RUN, PROMPT));
});

test('today: a new run without the MCP, the protocol, the plugin, a model or extra args renders the pinned argv (#924)', () => {
  const args = runArgs({ sessionId: ID }, {}, 'new', [], 'claude');
  assert.deepEqual(args, BARE_RUN.words);
  assert.equal(ptyCommand({ ...BASE, args }), commandOf(BARE_RUN));
});

test('today: a resume renders the pinned argv (#924)', () => {
  const args = runArgs({ sessionId: ID }, {}, 'continue', EXTRA, 'claude');
  assert.deepEqual(args, RESUME.words);
  assert.equal(ptyCommand({ ...BASE, mcpPath: MCP, args }), commandOf(RESUME));
});

test("today: the shim's captured launch is the pinned argv (#924)", () => {
  const captured = capturedArgs({ sessionId: ID, mcpPath: MCP, hooksPath: HOOKS, pluginDir: PLUGIN, lspPluginDir: LSP, protocolPath: SESSION_MD, claudeArgs: EXTRA });
  assert.deepEqual(captured, flat(CAPTURE));
});

test('today: a copy, with and without a name, renders the pinned argv (#924)', () => {
  const args = copyArgs({ from: FROM, notice: 'ignored here' }, ID, EXTRA);
  assert.deepEqual(args, COPY.words);
  assert.equal(ptyCommand({ ...BASE, mcpPath: MCP, args }), commandOf(COPY));
  const named = copyArgs({ from: FROM, name: NAME }, ID, EXTRA);
  assert.deepEqual(named, NAMED_COPY.words);
  assert.equal(ptyCommand({ ...BASE, mcpPath: MCP, args: named }), commandOf(NAMED_COPY));
});
