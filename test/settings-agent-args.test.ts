import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentArgsDraft, agentArgsFrom } from '../src/ui/lib/settings-agent-args.js';

test('agentArgsDraft writes each agent\'s saved list one argument per line, and an empty text for none (#924)', () => {
  assert.deepEqual(agentArgsDraft({ claude: ['--permission-mode', 'auto', 'a b'] }), { claude: '--permission-mode\nauto\na b' });
  assert.deepEqual(agentArgsDraft(undefined), { claude: '' });
});

test('agentArgsFrom sends one argument per non-blank line, each kept as typed, so a value with spaces stays one argument (#924)', () => {
  assert.deepEqual(agentArgsFrom({ claude: '--model\n\n  \nopus 4\n --verbose ' }), { claude: ['--model', 'opus 4', ' --verbose '] });
  assert.deepEqual(agentArgsFrom({ claude: '' }), { claude: [] });
});
