import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountRows, accountsDraft, accountsFrom, hasRemove, isRemovable, listOf, machineLogin, shownValue } from '../src/ui/lib/settings-accounts.js';

const READ = { claude: ['personal', 'work'], github: ['alice', 'gh-user'], machine: 'gh-user' };

test('accountsDraft fills every provider, a missing one as the machine\'s login; accountsFrom drops those (#964)', () => {
  assert.deepEqual(accountsDraft({ github: 'alice' }), { claude: '', copilot: '', github: 'alice' });
  assert.deepEqual(accountsDraft(undefined), { claude: '', copilot: '', github: '' }, 'a first setup');
  assert.deepEqual(accountsFrom({ claude: 'work', copilot: '', github: '' }), { claude: 'work' });
  assert.deepEqual(accountsFrom({ claude: '', copilot: '', github: '' }), {}, 'every group on the machine\'s login');
});

test('each group lists the machine\'s row first, then its stored accounts; Copilot lists GitHub\'s logins, and gh\'s own login is one row, the machine\'s (#964)', () => {
  assert.deepEqual(accountRows('claude', READ, undefined), [{ value: '' }, { value: 'personal' }, { value: 'work' }]);
  assert.deepEqual(accountRows('github', READ, undefined), [{ value: '', login: 'gh-user' }, { value: 'alice' }]);
  assert.deepEqual(accountRows('copilot', READ, ''), accountRows('github', READ, ''));
  assert.deepEqual(accountRows('github', { github: ['alice'] }, undefined), [{ value: '' }, { value: 'alice' }], 'gh has no login: the generic label');
  assert.deepEqual([listOf('claude'), listOf('copilot'), listOf('github')], ['claude', 'github', 'github']);
});

test('a saved name the read list lacks stays, last and marked gone; while the list loads or after it failed it stays unmarked (#964)', () => {
  assert.deepEqual(accountRows('claude', READ, 'old'), [{ value: '' }, { value: 'personal' }, { value: 'work' }, { value: 'old', isGone: true }]);
  assert.deepEqual(accountRows('claude', {}, 'work'), [{ value: '' }, { value: 'work', isGone: false }], 'loading or failed: the machine\'s row and the saved one');
  assert.deepEqual(accountRows('github', {}, undefined), [{ value: '' }]);
  assert.deepEqual(accountRows('github', READ, 'gh-user'), [{ value: '', login: 'gh-user' }, { value: 'alice' }], 'gh\'s own login saved: no second row');
});

test('a group shows gh\'s own login selected on the machine\'s row; Claude has no machine login (#964)', () => {
  assert.equal(shownValue('github', READ, 'gh-user'), '');
  assert.equal(shownValue('copilot', READ, 'gh-user'), '');
  assert.equal(shownValue('copilot', READ, 'alice'), 'alice');
  assert.equal(shownValue('github', {}, 'gh-user'), 'gh-user', 'before the list answers, the saved row holds it');
  assert.equal(shownValue('claude', READ, ''), '');
  assert.equal(machineLogin('claude', READ), undefined);
  assert.equal(machineLogin('copilot', READ), 'gh-user');
});

test('a stored row of claude\'s or github\'s group has a remove; the machine\'s row, a name no longer stored and copilot\'s rows have none (#965)', () => {
  assert.equal(hasRemove('claude', { value: 'work' }), true);
  assert.equal(hasRemove('github', { value: 'alice' }), true);
  assert.equal(hasRemove('github', { value: '', login: 'gh-user' }), false);
  assert.equal(hasRemove('claude', { value: 'old', isGone: true }), false);
  assert.equal(hasRemove('copilot', { value: 'alice' }), false);
});

test('remove is locked on the saved choice and on the drafted one; a github login also when copilot uses it, saved or drafted (#965)', () => {
  const saved = { claude: 'work', copilot: 'alice' };
  const draft = { claude: 'personal', copilot: 'carol', github: 'bob' };
  assert.deepEqual(['work', 'personal', 'home'].map((name) => isRemovable('claude', name, saved, draft)), [false, false, true]);
  assert.deepEqual(['alice', 'bob', 'carol', 'dave'].map((name) => isRemovable('github', name, saved, draft)), [false, false, false, true]);
  assert.equal(isRemovable('github', 'work', saved, draft), true, 'a claude name locks no github login');
});
