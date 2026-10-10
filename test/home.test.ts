import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { credentialsPath } from '../src/credentials.js';
import { hiveHome } from '../src/home.js';

test('hiveHome is <XDG_CONFIG_HOME>/agent-hive, ~/.config/agent-hive when the variable is unset, empty or relative, and holds credentials.json', () => {
  const fallback = join(homedir(), '.config', 'agent-hive');
  assert.equal(hiveHome({ XDG_CONFIG_HOME: '/x/cfg' }), join('/x/cfg', 'agent-hive'));
  assert.equal(hiveHome({}), fallback);
  assert.equal(hiveHome({ XDG_CONFIG_HOME: '' }), fallback, 'an empty value is unset, not the cwd');
  assert.equal(hiveHome({ XDG_CONFIG_HOME: 'relative/cfg' }), fallback, 'a relative value is unset too');
  assert.equal(hiveHome(), hiveHome(process.env), 'the process environment by default');
  for (const env of [{ XDG_CONFIG_HOME: '/x/cfg' }, {}]) assert.equal(credentialsPath(env), join(hiveHome(env), 'credentials.json'));
});

test('HIVE_HOME relocates the whole home, ahead of XDG_CONFIG_HOME, with no agent-hive suffix', () => {
  assert.equal(hiveHome({ HIVE_HOME: '/test/home', XDG_CONFIG_HOME: '/x/cfg' }), '/test/home', 'wins over XDG_CONFIG_HOME and is returned as-is');
  const fallback = join(homedir(), '.config', 'agent-hive');
  assert.equal(hiveHome({ HIVE_HOME: '' }), fallback, 'an empty value is unset, falls back to the XDG rule');
  assert.throws(() => hiveHome({ HIVE_HOME: 'relative/home' }), /HIVE_HOME must be an absolute path: relative\/home/, 'a relative value throws instead of silently falling back');
  assert.equal(credentialsPath({ HIVE_HOME: '/test/home' }), join('/test/home', 'credentials.json'), 'credentialsPath follows HIVE_HOME');
});
