import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandIn, commandsIn, parseCommandSemaphores, parseCommands, parseStageCommands, resolveCommand } from '../src/run-commands.js';
import type { Command } from '../src/types.js';

// How a Comb command resolves in a workspace (#755): the workspace's own line, else the other workspaces' one, else none.

const TESTS: Command = { name: 'tests', impls: [{ workspace: 'core-api', command: 'pytest' }, { workspace: null, command: 'pnpm run tests' }], menu: true, env: { CI: '1' }, timeout: '5m' };
const E2E: Command = { name: 'e2e', impls: [{ workspace: 'agent-hive', command: 'pnpm e2e' }], menu: true, env: {} };
const BUILD: Command = { name: 'build', impls: [{ workspace: null, command: 'pnpm build' }], menu: false, env: {} };

test('resolveCommand takes the workspace\'s own line, else the other workspaces\' one, else none (#755)', () => {
  assert.equal(resolveCommand(TESTS, 'core-api'), 'pytest');
  assert.equal(resolveCommand(TESTS, 'agent-hive'), 'pnpm run tests');
  assert.equal(resolveCommand(E2E, 'agent-hive'), 'pnpm e2e');
  assert.equal(resolveCommand(E2E, 'core-api'), undefined);
});

test('commandIn gives a command as it runs in a workspace, its line in place of its lines, menu or not; commandsIn lists what the task menu offers there (#755)', () => {
  const all = [TESTS, E2E, BUILD];
  assert.deepEqual(commandIn(all, 'core-api', 'tests'), { name: 'tests', command: 'pytest', env: { CI: '1' }, timeout: '5m' });
  assert.deepEqual(commandIn(all, 'core-api', 'build'), { name: 'build', command: 'pnpm build', env: {} }, 'a stages-only command still runs in a stage');
  assert.equal(commandIn(all, 'core-api', 'e2e'), undefined);
  assert.equal(commandIn(all, 'core-api', 'gone'), undefined);
  assert.deepEqual(commandsIn(all, 'agent-hive').map((c) => c.name), ['tests', 'e2e']);
  assert.deepEqual(commandsIn(all, 'core-api').map((c) => c.name), ['tests'], 'no line there, or not in the menu: not offered');
});

test('a command name, and a name a commands stage lists, carrying a control character is refused, so it never reaches a log line raw (#755)', () => {
  const impls = [{ workspace: null, command: 'pnpm test' }];
  assert.throws(() => parseCommands([{ name: 'x\u001b[2Jy', impls, menu: true, env: {} }], 'comb.commands', ['hive'], []), /comb\.commands\[0\]\.name/);
  const stage = { action: 'commands', commands: ['lint\r'], stopOnFailure: true, onMissing: 'fail' };
  assert.throws(() => parseStageCommands({ ...stage, commands: ['li\u001bnt'] }, 'comb.stages[0]'), /comb\.stages\[0\]\.commands/);
  assert.deepEqual(parseStageCommands({ ...stage, commands: ['lint'] }, 'comb.stages[0]'), { commands: ['lint'], stopOnFailure: true, onMissing: 'fail' });
});

// #796: a Command Semaphore as the file holds it
const MEMORY = { name: 'memory', limit: 2, reservation: '2m' };

test('commandSemaphores parses each semaphore as given, its name trimmed; [] is none (#796)', () => {
  assert.deepEqual(parseCommandSemaphores([MEMORY, { name: ' disk_2-a ', limit: 1, reservation: '24h' }]), [MEMORY, { name: 'disk_2-a', limit: 1, reservation: '24h' }]);
  assert.deepEqual(parseCommandSemaphores([]), []);
});

test('commandSemaphores refuses a missing list, an entry that is no object, a name that is not one word or repeats, a limit that is not an integer of 1 or more and a reservation that is no timeout up to 24h, naming the field (#796)', () => {
  const refused = (raw: unknown, field: string, what: string): void =>
    assert.throws(() => parseCommandSemaphores(raw), { message: `hive.config.json: "commandSemaphores${field}" ${what}` }, JSON.stringify(raw));
  refused(undefined, '', 'must be an array');
  refused({}, '', 'must be an array');
  refused(['memory'], '[0]', 'must be an object');
  for (const name of ['two words', '  ', 'mem.ory', 7]) refused([{ ...MEMORY, name }], '[0].name', 'must be one word of letters, digits, - and _');
  refused([MEMORY, { ...MEMORY, name: ' memory ' }], '[1].name', 'must be unique');
  for (const limit of [0, -1, 1.5, '2', undefined]) refused([{ ...MEMORY, limit }], '[0].limit', 'must be an integer of 1 or more');
  for (const reservation of ['2 min', '25h', '', 120, undefined]) {
    refused([{ ...MEMORY, reservation }], '[0].reservation', 'must be a timeout like "30s", "10m" or "1h", up to 24h');
  }
});

test('a command line names a semaphore of commandSemaphores or none: kept when named, no key when absent, refused at its own field otherwise (#796)', () => {
  const dev = (impl: Record<string, unknown>) => [{ name: 'dev', impls: [{ workspace: null, command: 'pnpm dev', ...impl }], menu: true, env: {} }];
  const [held] = parseCommands(dev({ semaphore: 'memory' }), 'comb.commands', ['hive'], ['memory']);
  assert.deepEqual(held.impls, [{ workspace: null, command: 'pnpm dev', semaphore: 'memory' }]);
  const [free] = parseCommands(dev({}), 'comb.commands', ['hive'], ['memory']);
  assert.deepEqual(free.impls, [{ workspace: null, command: 'pnpm dev' }], 'absent stays absent: the line runs at once');
  const message = 'hive.config.json: "comb.commands[0].impls[0].semaphore" must name a semaphore of commandSemaphores';
  for (const semaphore of ['disk', ' memory ', 1, null]) {
    assert.throws(() => parseCommands(dev({ semaphore }), 'comb.commands', ['hive'], ['memory']), { message }, JSON.stringify(semaphore));
  }
});
