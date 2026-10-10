import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandIn, commandsIn, parseCommands, parseStageCommands, resolveCommand } from '../src/run-commands.js';
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
  assert.throws(() => parseCommands([{ name: 'x\u001b[2Jy', impls, menu: true, env: {} }], 'comb.commands', ['hive']), /comb\.commands\[0\]\.name/);
  const stage = { action: 'commands', commands: ['lint\r'], stopOnFailure: true, onMissing: 'fail' };
  assert.throws(() => parseStageCommands({ ...stage, commands: ['li\u001bnt'] }, 'comb.stages[0]'), /comb\.stages\[0\]\.commands/);
  assert.deepEqual(parseStageCommands({ ...stage, commands: ['lint'] }, 'comb.stages[0]'), { commands: ['lint'], stopOnFailure: true, onMissing: 'fail' });
});
