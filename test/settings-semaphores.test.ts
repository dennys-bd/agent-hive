import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { emptySemaphore, type SemaphoreDraft, semaphoreDrafts, semaphoreFaults, semaphoreLines, semaphoreNow, semaphoresFrom, semaphoresProblem, withoutSemaphore } from '../src/ui/lib/settings-semaphores.js';
import { commandDraft, commandFrom } from '../src/ui/lib/settings-commands.js';
import { emptyWorkspace, type WorkspaceDraft } from '../src/ui/lib/settings-form.js';
import type { Command, CommandSemaphore } from '../src/types.js';

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

const API: WorkspaceDraft = { ...emptyWorkspace(), name: 'api', path: '/api' };
const WEB: WorkspaceDraft = { ...emptyWorkspace(), name: 'web', path: '/web' };
const TESTS: Command = { name: 'tests', impls: [{ workspace: 'api', command: 'pnpm test', semaphore: 'memory' }, { workspace: null, command: 'make test', semaphore: 'memory' }], menu: true, env: {} };

test('a line points at its semaphore by the row id: loaded from the saved name, saved under the row\'s trimmed name, so a rename carries it (#803 decisions 2, 3)', () => {
  const semaphores = semaphoreDrafts(SAVED);
  const draft = commandDraft(TESTS, [API, WEB], semaphores);
  assert.deepEqual(draft.impls.map((i) => i.semaphore), [semaphores[0].id, semaphores[0].id]);
  assert.deepEqual(commandFrom(draft, [API, WEB], semaphores), TESTS, 'nothing edited: unchanged');
  const renamed = semaphores.map((s) => (s.id === semaphores[0].id ? { ...s, name: ' heavy ' } : s));
  assert.deepEqual(commandFrom(draft, [API, WEB], renamed).impls.map((i) => i.semaphore), ['heavy', 'heavy']);
});

test('a line pointing at a semaphore added but not saved saves its name; an id no row has, or a saved name no row has, gives no semaphore key (#803)', () => {
  const added = row({ name: 'ports' });
  const draft = commandDraft({ ...TESTS, impls: [{ workspace: 'api', command: 'pnpm e2e' }] }, [API], []);
  const picked = { ...draft, impls: draft.impls.map((i) => ({ ...i, semaphore: added.id })) };
  assert.deepEqual(commandFrom(picked, [API], [added]).impls, [{ workspace: 'api', command: 'pnpm e2e', semaphore: 'ports' }]);
  assert.equal('semaphore' in commandFrom(picked, [API], []).impls[0], false, 'strict: no semaphore: undefined key');
  assert.equal('semaphore' in commandDraft({ ...TESTS, impls: [{ workspace: 'api', command: 'x', semaphore: 'gone' }] }, [API], []).impls[0], false);
});

test('withoutSemaphore clears the row from every line pointing at it, leaves every other line as it was and mutates nothing (#803 decision 4)', () => {
  const semaphores = semaphoreDrafts(SAVED);
  const lint: Command = { name: 'lint', impls: [{ workspace: 'web', command: 'pnpm lint', semaphore: 'disk' }], menu: false, env: {} };
  const commands = [TESTS, lint].map((c) => commandDraft(c, [API, WEB], semaphores));
  const cleared = withoutSemaphore(commands, semaphores[0].id);
  assert.deepEqual(cleared.map((c) => commandFrom(c, [API, WEB], semaphores.slice(1))), [{ ...TESTS, impls: TESTS.impls.map(({ semaphore: _s, ...line }) => line) }, lint]);
  assert.equal(commands[0].impls[0].semaphore, semaphores[0].id, 'the old drafts are untouched');
});

test('semaphoreLines lists each command\'s lines in the row, in Comb order, with the commands editor\'s labels; none reads — (#803 decision 7)', () => {
  const semaphores = semaphoreDrafts(SAVED);
  const lint: Command = { name: 'lint', impls: [{ workspace: null, command: 'pnpm lint', semaphore: 'memory' }], menu: true, env: {} };
  const e2e: Command = { name: 'e2e', impls: [{ workspace: 'web', command: 'y', semaphore: 'memory' }, { workspace: 'api', command: 'x', semaphore: 'memory' }], menu: true, env: {} };
  const commands = [TESTS, lint, e2e].map((c) => commandDraft(c, [API, WEB], semaphores));
  setLanguage('pt');
  assert.equal(semaphoreLines(commands, [API, WEB], semaphores[0].id), 'tests em api e os demais workspaces · lint em todos os workspaces · e2e em api e web');
  assert.equal(semaphoreLines(commands, [API, WEB], semaphores[1].id), '—');
  setLanguage('en');
  assert.equal(semaphoreLines(commands, [API, WEB], semaphores[0].id), 'tests in api and the other workspaces · lint in all workspaces · e2e in api and web');
  const picked = withoutSemaphore(commands, semaphores[0].id);
  assert.equal(semaphoreLines(picked, [API, WEB], semaphores[0].id), '—', 'it reads the draft');
});

test('semaphoreNow reads State by the saved name: free with nothing held or no entry, else the runs and the line (#803 decision 8)', () => {
  const [memory] = semaphoreDrafts(SAVED);
  const live = { memory: { runs: ['A'], line: [{ ptyId: 'B', place: 1 }, { ptyId: 'C', place: 2 }] } };
  setLanguage('pt');
  assert.deepEqual(semaphoreNow(live, memory), ['1 executando', '2 na vez']);
  assert.deepEqual(semaphoreNow({ memory: { runs: ['A'], line: [] } }, memory), ['1 executando']);
  assert.deepEqual(semaphoreNow({ memory: { runs: [], line: [] } }, memory), ['livre']);
  assert.deepEqual(semaphoreNow({}, memory), ['livre']);
  assert.deepEqual(semaphoreNow(undefined, memory), ['livre']);
  assert.deepEqual(semaphoreNow(live, emptySemaphore()), ['livre'], 'a new row has no saved name');
  assert.deepEqual(semaphoreNow(live, { ...memory, name: 'heavy' }), ['1 executando', '2 na vez'], 'a renamed row keeps its saved state until the save');
  setLanguage('en');
  assert.deepEqual(semaphoreNow(live, memory), ['1 running', '2 waiting']);
  assert.deepEqual(semaphoreNow({}, memory), ['free']);
});
