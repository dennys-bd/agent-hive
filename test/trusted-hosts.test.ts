import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostIsTrusted, isTrustedHost } from '../src/trusted-hosts.js';

test('isTrustedHost takes a bare host name and refuses a scheme, a port, a path, a wildcard, an empty label and a label starting or ending with "-" (#404)', () => {
  for (const host of ['github.com', 'api.github.com', 'localhost', 'my-site.example', 'xn--bcher-kva.de', '127.0.0.1']) assert.equal(isTrustedHost(host), true, host);
  const refused = [
    '', 'https://github.com', 'github.com:443', 'github.com/issues', '*.github.com', '-github.com', 'github-.com', 'github..com', '.github.com',
    'github.com.', 'git hub.com', 'GitHub.com', 'a'.repeat(254),
  ];
  for (const host of refused) assert.equal(isTrustedHost(host), false, host);
});

test('hostIsTrusted matches an entry itself or a subdomain of it, in any case, never a look-alike (#404)', () => {
  const list = ['github.com'];
  assert.equal(hostIsTrusted('github.com', list), true);
  assert.equal(hostIsTrusted('api.github.com', list), true);
  assert.equal(hostIsTrusted('API.GitHub.com', list), true, 'a host in any case');
  assert.equal(hostIsTrusted('evilgithub.com', list), false, 'the leading dot keeps a look-alike out');
  assert.equal(hostIsTrusted('github.com.evil.io', list), false);
  assert.equal(hostIsTrusted('github.com', []), false, 'an empty list trusts nothing');
});
