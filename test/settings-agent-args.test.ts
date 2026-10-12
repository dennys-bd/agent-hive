import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentArgsDraft, agentArgsFrom } from '../src/ui/lib/settings-agent-args.js';

test('agentArgsDraft writes each agent\'s saved list one argument per line, and an empty text for none (#924, #927)', () => {
  assert.deepEqual(agentArgsDraft({ claude: ['--permission-mode', 'auto', 'a b'] }), { claude: '--permission-mode\nauto\na b', codex: '' });
  assert.deepEqual(agentArgsDraft(undefined), { claude: '', codex: '' });
});

test('agentArgsFrom sends one argument per non-blank line, each kept as typed, so a value with spaces stays one argument (#924, #927)', () => {
  assert.deepEqual(agentArgsFrom({ claude: '--model\n\n  \nopus 4\n --verbose ', codex: '' }), { claude: ['--model', 'opus 4', ' --verbose '], codex: [] });
  assert.deepEqual(agentArgsFrom({ claude: '', codex: '--sandbox\nworkspace-write' }), { claude: [], codex: ['--sandbox', 'workspace-write'] });
});

test('agentArgsFrom splits a pasted CRLF text on its line breaks, leaving no carriage return in an argument (#924)', () => {
  assert.deepEqual(agentArgsFrom({ claude: '--verbose\r\n--model\r\nopus', codex: '' }), { claude: ['--verbose', '--model', 'opus'], codex: [] });
});
