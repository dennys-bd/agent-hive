import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentArgsDraft, agentArgsFrom } from '../src/ui/lib/settings-agent-args.js';

test('agentArgsDraft joins each agent\'s saved list with spaces, and an empty text for none (#482)', () => {
  assert.deepEqual(agentArgsDraft({ claude: ['--a', 'b'] }), { claude: '--a b', codex: '', copilot: '' });
  assert.deepEqual(agentArgsDraft(undefined), { claude: '', codex: '', copilot: '' });
});

test('agentArgsFrom splits each text on whitespace, as the run fields do (#482)', () => {
  assert.deepEqual(agentArgsFrom({ claude: '--verbose  --x 1', codex: '', copilot: '' }), { claude: ['--verbose', '--x', '1'], codex: [], copilot: [] });
  assert.deepEqual(agentArgsFrom({ claude: '', codex: ' --sandbox\tworkspace-write ', copilot: '' }), { claude: [], codex: ['--sandbox', 'workspace-write'], copilot: [] });
});
