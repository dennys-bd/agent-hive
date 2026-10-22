import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dashboardCookie, smokeDashboard, storageState } from '../../scripts/experiment/browser.js';
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

test('storageState holds the dashboard cookie as a session cookie (#105)', () => {
  const cookie = dashboardCookie(4321, SECRET);
  assert.deepEqual(storageState(cookie).cookies[0], { ...cookie, expires: -1 });
});
