import { expect, test } from 'vitest';
import { runsLine } from '@/lib/new-session';

test('a copilot session\'s runs line shows the agent behind --agent and the model behind --model, after the global and the session\'s args, as the runner passes them (#876)', () => {
  expect(runsLine({ agent: 'copilot', model: 'gpt-6-sol', specializedAgent: 'hive:designer', args: '--verbose' }, ['--allow-all-paths']))
    .toBe('copilot --allow-all-paths --verbose --agent hive:designer --model gpt-6-sol');
  expect(runsLine({ agent: 'codex', model: 'gpt-6-sol', specializedAgent: 'hive:designer', args: '' }, [])).toBe('codex -m gpt-6-sol'); // Codex has no --agent
});
