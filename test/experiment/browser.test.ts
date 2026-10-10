import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dashboardCookie, mcpConfig, smokeDashboard, storageState } from '../../scripts/experiment/browser.js';
import { tempDir } from '../temp-dir.js';
import { fakeBrowser } from './fixtures.js';

const SECRET = 'b'.repeat(64);

test('smokeDashboard opens the dashboard with the secret as the cookie of its port and fails on a page that is not ok (#105)', async (t) => {
  const dir = await tempDir(t, 'smoke-');
  const cookie = dashboardCookie(4321, SECRET);
  const good = fakeBrowser();
  await smokeDashboard(good.launch, 'http://127.0.0.1:4321/', cookie, join(dir, 'dashboard.png'));
  assert.deepEqual(good.seen.cookies, [{ name: 'hive_secret_4321', value: SECRET, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Strict' }]);
  assert.deepEqual(good.seen.shots, [join(dir, 'dashboard.png')]);
  const bad = fakeBrowser(false);
  await assert.rejects(smokeDashboard(bad.launch, 'http://127.0.0.1:4321/', cookie, join(dir, 'x.png')), /no ok status/);
  assert.equal(bad.seen.closed, 1);
});

test('mcpConfig starts the Playwright MCP headless and isolated on the storage state; the secret lives only there (#105)', () => {
  const cookie = dashboardCookie(4321, SECRET);
  const config = mcpConfig('/repo/node_modules/.bin/playwright-mcp', '/review/storage-state.json', '/review/screens', 'http://127.0.0.1:4321', '/pw/chromium/chrome', '/tmp/hive-pw-x1');
  const server = (config.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>).playwright;
  // macOS caps a socket path at 104 bytes: under the long per-user TMPDIR the MCP's own socket folder overflowed and the tester never started
  assert.deepEqual(server.env, { PWTEST_SOCKETS_DIR: '/tmp/hive-pw-x1' });
  assert.equal(server.command, '/repo/node_modules/.bin/playwright-mcp');
  for (const arg of ['--headless', '--isolated', '--storage-state', '/review/storage-state.json', '--output-dir', '/review/screens', '1440,900', '--allowed-origins', 'http://127.0.0.1:4321', '--executable-path', '/pw/chromium/chrome']) assert.ok(server.args.includes(arg), arg);
  assert.ok(!JSON.stringify(config).includes(SECRET));
  assert.deepEqual(storageState(cookie).cookies[0], { ...cookie, expires: -1 });
});
