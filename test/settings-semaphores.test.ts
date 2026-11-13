import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { emptySemaphore, type SemaphoreDraft, semaphoreDrafts, semaphoreFaults, semaphoresFrom, semaphoresProblem } from '../src/ui/lib/settings-semaphores.js';
import type { CommandSemaphore } from '../src/types.js';

const SAVED: CommandSemaphore[] = [{ name: 'memory', limit: 2, reservation: '2m' }, { name: 'disk', limit: 1, reservation: '5m' }];
const row = (patch: Partial<SemaphoreDraft>): SemaphoreDraft => ({ ...emptySemaphore(), name: 'memory', ...patch });

test('semaphoreDrafts / semaphoresFrom round-trip a saved list unchanged: texts as typed, each row its own id and its saved name (#803)', () => {
  const drafts = semaphoreDrafts(SAVED);
  assert.deepEqual(drafts.map(({ id: _id, ...d }) => d), [
    { savedName: 'memory', name: 'memory', limit: '2', reservation: '2m' },
    { savedName: 'disk', name: 'disk', limit: '1', reservation: '5m' },
  ]);
  assert.notEqual(drafts[0].id, drafts[1].id, 'each row gets its own id');
  assert.deepEqual(semaphoresFrom(drafts), SAVED);
  assert.deepEqual(semaphoresFrom([row({ name: ' heavy ', limit: ' 3 ', reservation: ' 1h ' })]), [{ name: 'heavy', limit: 3, reservation: '1h' }], 'trimmed');
});

test('emptySemaphore is a row with no name, limit 1 and reservation 1m, and no saved name (#803 decision 6)', () => {
  const { id, ...fresh } = emptySemaphore();
  assert.deepEqual(fresh, { name: '', limit: '1', reservation: '1m' });
  assert.notEqual(id, emptySemaphore().id);
  assert.equal('savedName' in fresh, false);
});

test('semaphoresProblem names the first refused row, on rules: a name not one word, a duplicate, a limit under 1 or not whole, a reservation not a TIMEOUT text (#803 decision 5)', () => {
  setLanguage('en');
  assert.equal(semaphoresProblem(semaphoreDrafts(SAVED)), undefined);
  assert.equal(semaphoresProblem([]), undefined);
  for (const name of ['', '  ', 'two words', 'mem.ory', 'memória']) {
    assert.deepEqual(semaphoresProblem([row({ name: 'disk' }), row({ name })]), { section: 'rules', message: t('settings.error.semaphoreName', { n: 2 }) }, JSON.stringify(name));
  }
  assert.deepEqual(semaphoresProblem([row({}), row({ name: ' memory ' })]), { section: 'rules', message: t('settings.error.semaphoreDuplicate', { name: 'memory' }) }, 'compared trimmed');
  assert.equal(semaphoresProblem([row({}), row({ name: 'Memory' })]), undefined, 'case-sensitive');
  for (const limit of ['', '0', '-1', '1.5', 'two']) {
    assert.deepEqual(semaphoresProblem([row({ limit })]), { section: 'rules', message: t('settings.error.semaphoreLimit', { name: 'memory' }) }, JSON.stringify(limit));
  }
  for (const reservation of ['', '2', '2 m', '0m', '25h']) {
    assert.deepEqual(semaphoresProblem([row({ reservation })]), { section: 'rules', message: t('settings.error.semaphoreReservation', { name: 'memory' }) }, JSON.stringify(reservation));
  }
  assert.equal(semaphoresProblem([row({ limit: ' 2 ', reservation: ' 30s ' })]), undefined, 'trimmed');
  setLanguage('pt');
  assert.equal(semaphoresProblem([row({ name: '' })])?.message, 'revezamento 1: o nome precisa ser uma palavra de letras, dígitos, - e _');
  setLanguage('en');
  assert.equal(semaphoresProblem([row({ name: '' })])?.message, 'semaphore 1: the name must be one word of letters, digits, - and _');
});

test('semaphoreFaults marks each field the problem would name, a duplicate name on both rows (#803 decision 5)', () => {
  const a = row({});
  const b = row({ limit: '0', reservation: 'soon' });
  assert.deepEqual(semaphoreFaults([a, b], a), { name: true, limit: false, reservation: false });
  assert.deepEqual(semaphoreFaults([a, b], b), { name: true, limit: true, reservation: true });
  assert.deepEqual(semaphoreFaults([a], a), { name: false, limit: false, reservation: false });
  assert.deepEqual(semaphoreFaults([row({ name: 'a b' })], row({ name: 'a b' })).name, true);
});
