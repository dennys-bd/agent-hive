import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenableExternal } from '../src/external-url.js';

test('only http, https and mailto links leave the app; file, custom schemes and text that is not a URL stay (#780)', () => {
  for (const url of ['https://example.com/a?b=1', 'http://localhost:3000', 'mailto:a@b.co', 'HTTPS://EXAMPLE.COM']) assert.equal(isOpenableExternal(url), true, url);
  for (const url of ['file:///etc/passwd', 'vscode://x/y', 'javascript:alert(1)', 'smb://host/share', 'not a url', '']) assert.equal(isOpenableExternal(url), false, url);
});
