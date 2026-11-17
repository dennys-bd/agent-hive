import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COPILOT_HOOK_EVENTS, copilotHooksPlugin, writeCopilotHooksPlugin } from '../../src/agents/copilot-hooks.js';
import { hookCommand, STOP_HOOK_TIMEOUT_S } from '../../src/hooks-settings.js';
import { tempDir } from '../temp-dir.js';

const hooksOf = async (home: string) => JSON.parse(await readFile(join(copilotHooksPlugin(home), 'hooks', 'hooks.json'), 'utf8')).hooks;

test('the hooks plugin registers six events in Claude\'s format, every one the port\'s command, no matcher; Stop held as long as an approval under both timeout keys (#874)', async (t) => {
  const home = join(await tempDir(t, 'copilot-hooks-'), 'home');
  await writeCopilotHooksPlugin(home, 4242);
  const hooks = await hooksOf(home);
  assert.deepEqual(COPILOT_HOOK_EVENTS, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']);
  assert.deepEqual(Object.keys(hooks), [...COPILOT_HOOK_EVENTS], 'no PermissionRequest, no SessionEnd');
  for (const event of COPILOT_HOOK_EVENTS.filter((e) => e !== 'Stop')) {
    assert.deepEqual(hooks[event], [{ hooks: [{ type: 'command', command: hookCommand(4242) }] }], event);
  }
  assert.deepEqual(hooks.Stop, [{ hooks: [{ type: 'command', command: hookCommand(4242, STOP_HOOK_TIMEOUT_S), timeout: STOP_HOOK_TIMEOUT_S, timeoutSec: STOP_HOOK_TIMEOUT_S }] }]);
});

test('the plugin keeps its manifest, is rewritten for each boot\'s port, and writes nothing outside the home (#874)', async (t) => {
  const root = await tempDir(t, 'copilot-hooks-');
  const home = join(root, 'home');
  await writeCopilotHooksPlugin(home, 4242);
  await writeCopilotHooksPlugin(home, 5151);
  assert.equal(JSON.parse(await readFile(join(copilotHooksPlugin(home), '.claude-plugin', 'plugin.json'), 'utf8')).name, 'hive-hooks');
  assert.equal((await hooksOf(home)).PostToolUse[0].hooks[0].command, hookCommand(5151));
  assert.deepEqual([await readdir(root), await readdir(home)], [['home'], ['copilot']]);
});
