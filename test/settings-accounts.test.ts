import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsDraft, accountsFrom } from '../src/ui/lib/settings-accounts.js';

test('accountsDraft fills every provider, a missing one as the machine\'s login; accountsFrom drops those (#964)', () => {
  assert.deepEqual(accountsDraft({ github: 'alice' }), { claude: '', copilot: '', github: 'alice' });
  assert.deepEqual(accountsDraft(undefined), { claude: '', copilot: '', github: '' }, 'a first setup');
  assert.deepEqual(accountsFrom({ claude: 'work', copilot: '', github: '' }), { claude: 'work' });
  assert.deepEqual(accountsFrom({ claude: '', copilot: '', github: '' }), {}, 'every group on the machine\'s login');
});
