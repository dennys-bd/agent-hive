import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSecret, newSecret, pagePolicy, presentedSecret, SECRET_HEADER, secretCookie } from '../src/secret.js';
import { directive } from './secret-client.js';

test('newSecret: 64 lowercase hex characters, a new one each call (#467)', () => {
  const a = newSecret();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(newSecret(), a, 'a new boot voids every old copy');
});

test('matchesSecret accepts the secret and refuses another value, a prefix, a longer value, an empty string and none, without throwing (#467)', () => {
  const secret = newSecret();
  assert.equal(matchesSecret(secret, secret), true);
  for (const presented of [newSecret(), secret.slice(0, 63), `${secret}0`, '', undefined]) {
    assert.equal(matchesSecret(secret, presented), false, JSON.stringify(presented));
  }
});

test('presentedSecret reads the x-hive-secret header, else the cookie of this port among others; another port\'s cookie or none reads undefined (#467)', () => {
  const secret = newSecret();
  assert.equal(secretCookie(4242), 'hive_secret_4242');
  assert.equal(presentedSecret({ headers: { [SECRET_HEADER]: secret } }, 4242), secret);
  assert.equal(presentedSecret({ headers: { cookie: `theme=dark; hive_secret_4242=${secret}; x=1` } }, 4242), secret);
  assert.equal(presentedSecret({ headers: { cookie: `hive_secret_5151=${secret}` } }, 4242), undefined, 'a test Hive beside this one keeps its own cookie');
  assert.equal(presentedSecret({ headers: {} }, 4242), undefined);
});

test('pagePolicy lets the pages frame the design frame route of this port, on both hosts, and nothing else; every other directive is #467\'s (#108)', () => {
  const policy = pagePolicy(4242);
  assert.deepEqual(directive(policy, 'frame-src'), ['http://127.0.0.1:4242/design-frame/', 'http://localhost:4242/design-frame/']);
  const before = "img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'";
  assert.equal(policy.replace(/frame-src [^;]+/, "frame-src 'none'"), before);
});
