import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedName, addRoute, addStatusFrom, claudeAddStatus, failedKey, failedStatus, githubAddStatus, REFUSAL_KEY, shownStatus, startFailure,
} from '../src/ui/lib/account-add.js';

const LINK = 'https://example.com/sign-in';
// What parseJson throws for a refusal: the route's error as the message, the status beside it
const refused = (status: number, message: string): Error => Object.assign(new Error(message), { status });

test('claudeAddStatus keeps each state the route answers, the link only when it is https, and refuses any other answer (#965)', () => {
  assert.deepEqual(claudeAddStatus({ state: 'idle' }), { state: 'idle' });
  assert.deepEqual(claudeAddStatus({ state: 'pending', name: 'work' }), { state: 'pending', name: 'work' });
  assert.deepEqual(claudeAddStatus({ state: 'pending', name: 'work', url: LINK }), { state: 'pending', name: 'work', url: LINK });
  assert.deepEqual(claudeAddStatus({ state: 'pending', name: 'work', url: 'javascript:alert(1)' }), { state: 'pending', name: 'work' }, 'no other scheme reaches an href');
  assert.deepEqual(claudeAddStatus({ state: 'connected', name: 'work' }), { state: 'connected', name: 'work' });
  assert.deepEqual(claudeAddStatus({ state: 'failed', name: 'work', reason: 'timeout' }), { state: 'failed', name: 'work', reason: 'timeout' });
  assert.deepEqual(claudeAddStatus({ state: 'cancelled', name: 'work' }), { state: 'cancelled', name: 'work' });
  for (const answer of [undefined, null, 'pending', {}, { state: 'pending' }, { state: 'failed', name: 'work', reason: 'token' }, { state: 'done', name: 'work' }]) {
    assert.equal(claudeAddStatus(answer), undefined, JSON.stringify(answer));
  }
});

test('githubAddStatus keeps the code and the link once gh printed them, the login on connected, and refuses any other answer (#965)', () => {
  assert.deepEqual(githubAddStatus({ state: 'idle' }), { state: 'idle' });
  assert.deepEqual(githubAddStatus({ state: 'pending' }), { state: 'pending' });
  assert.deepEqual(githubAddStatus({ state: 'pending', code: 'ABCD-1234', url: LINK }), { state: 'pending', code: 'ABCD-1234', url: LINK });
  assert.deepEqual(githubAddStatus({ state: 'pending', code: '', url: 'http://example.com' }), { state: 'pending' });
  assert.deepEqual(githubAddStatus({ state: 'connected', login: 'bob' }), { state: 'connected', login: 'bob' });
  assert.deepEqual(githubAddStatus({ state: 'failed', reason: 'token' }), { state: 'failed', reason: 'token' });
  assert.deepEqual(githubAddStatus({ state: 'cancelled' }), { state: 'cancelled' });
  for (const answer of [null, { state: 'connected' }, { state: 'failed', reason: 'nope' }, { error: 'raw route error' }]) assert.equal(githubAddStatus(answer), undefined);
  assert.deepEqual([addStatusFrom('claude', { state: 'pending', name: 'work' }), addStatusFrom('github', { state: 'pending', name: 'work' })], [{ state: 'pending', name: 'work' }, { state: 'pending' }]);
});

test('a connected or cancelled add puts the group at rest; connected names what it stored; each provider has its own route (#965)', () => {
  assert.deepEqual(shownStatus({ state: 'connected', name: 'work' }), { state: 'idle' });
  assert.deepEqual(shownStatus({ state: 'cancelled' }), { state: 'idle' });
  assert.deepEqual(shownStatus({ state: 'pending', name: 'work' }), { state: 'pending', name: 'work' });
  assert.deepEqual([addedName({ state: 'connected', name: 'work' }), addedName({ state: 'connected', login: 'bob' }), addedName({ state: 'pending' })], ['work', 'bob', undefined]);
  assert.deepEqual([addRoute('claude'), addRoute('github')], ['/settings/accounts/claude/add', '/settings/github/add']);
});

test('a refused start: a 400 name code is worded at the field, a 409 add-pending resumes the wait, anything else is a failure in our words (#965)', () => {
  assert.deepEqual(startFailure(refused(400, 'name-taken')), { kind: 'refused', refusal: 'name-taken' });
  assert.deepEqual(startFailure(refused(409, 'add-pending')), { kind: 'pending' });
  assert.deepEqual(startFailure(refused(400, 'unknown')), { kind: 'failed' });
  assert.deepEqual(startFailure(refused(500, 'raw route error')), { kind: 'failed' });
  assert.deepEqual(startFailure(new TypeError('fetch failed')), { kind: 'failed' });
  assert.deepEqual(Object.keys(REFUSAL_KEY), ['name-empty', 'name-too-long', 'name-taken']);
  assert.deepEqual([failedStatus('claude', 'work'), failedStatus('github', '')], [{ state: 'failed', name: 'work', reason: 'exited' }, { state: 'failed', reason: 'exited' }]);
  assert.deepEqual(
    [failedKey({ state: 'failed', name: 'work', reason: 'exited' }), failedKey({ state: 'failed', reason: 'exited' }), failedKey({ state: 'failed', reason: 'token' })],
    ['settings.accounts.add.failed.exited', 'settings.accounts.add.failed.ghExited', 'settings.accounts.add.failed.token'],
  );
});
