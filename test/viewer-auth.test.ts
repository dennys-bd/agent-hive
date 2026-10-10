import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSecret } from '../src/secret.js';
import { type CookieDetails, type CookieJar, createViewerAuth } from '../src/viewer-auth.js';

const cookie = (port: number, value: string): CookieDetails =>
  ({ url: `http://127.0.0.1:${port}`, name: `hive_secret_${port}`, value, httpOnly: true, sameSite: 'strict', path: '/' });

// A session's host-only cookies of 127.0.0.1, whatever port set them (a cookie ignores the port), plus one of another host, and every call in
// order. Like Electron, get({ url }) answers the cookies that URL would be sent; a { domain } filter (which may miss host-only ones) answers none.
function fakeJar(log: string[] = []): { jar: CookieJar; names: () => string[]; set: CookieDetails[] } {
  const jarred = new Map<string, string>();
  const set: CookieDetails[] = [];
  const jar: CookieJar = {
    get: async (filter) => {
      if (!('url' in filter) || filter.url !== 'http://127.0.0.1') return [];
      return [...[...jarred.keys()].map((name) => ({ name, domain: '127.0.0.1' })), { name: 'hive_secret_1', domain: 'example.com' }];
    },
    remove: async (url, name) => {
      log.push(`remove ${name} ${url}`);
      jarred.delete(name);
    },
    set: async (details) => {
      log.push(`set ${details.name}`);
      set.push(details);
      jarred.set(details.name, details.value);
    },
  };
  return { jar, names: () => [...jarred.keys()], set };
}

test('authorize sets the probed secret as its port\'s HttpOnly SameSite=Strict session cookie, and says true only for a value new to that port (#467)', async () => {
  const { jar, set } = fakeJar();
  const { authorize } = createViewerAuth(() => jar, () => {});
  const first = newSecret();
  assert.equal(await authorize({ port: 4242, secret: first }), true);
  assert.equal(await authorize({ port: 4242, secret: first }), false, 'the same secret: a page already open still holds it');
  const second = newSecret(); // a new boot on the same port
  assert.equal(await authorize({ port: 4242, secret: second }), true, 'a page open on this port holds a stale cookie now');
  assert.deepEqual(set, [cookie(4242, first), cookie(4242, second)], 'no expirationDate: a session cookie');
});

test('authorize closes the windows of every other port, then removes every other port\'s cookie, then sets its own: a cookie ignores the port, so a stale window would send the new secret to whoever holds the old port (#467)', async () => {
  const log: string[] = [];
  const { jar, names } = fakeJar(log);
  const { authorize } = createViewerAuth(() => jar, (port) => log.push(`close all but ${port}`));
  await authorize({ port: 4242, secret: newSecret() });
  await jar.set({ ...cookie(9999, 'x'), name: 'unrelated' }); // someone else's cookie on the host stays
  log.length = 0;
  await authorize({ port: 5151, secret: newSecret() });
  assert.deepEqual(log, ['close all but 5151', 'remove hive_secret_4242 http://127.0.0.1:4242', 'set hive_secret_5151']);
  assert.deepEqual(names().sort(), ['hive_secret_5151', 'unrelated']);
});

test('secretOf is what authorize set, and only for the port it last authorized: the old port\'s windows are gone and nothing may reach it (#467)', async () => {
  const { jar } = fakeJar();
  const { authorize, secretOf } = createViewerAuth(() => jar, () => {});
  assert.equal(secretOf(4242), undefined, 'nothing set yet');
  const first = newSecret();
  await authorize({ port: 4242, secret: first });
  assert.equal(secretOf(4242), first);
  const second = newSecret();
  await authorize({ port: 5151, secret: second });
  assert.equal(secretOf(4242), undefined, 'the old port lost its cookie');
  assert.equal(secretOf(5151), second);
  assert.equal(await authorize({ port: 4242, secret: first }), true, 'back to the old port: its cookie is set again');
});

test('overlapping authorize calls run one after the other, and a rejected one does not block the next (#467)', async () => {
  const log: string[] = [];
  const { jar } = fakeJar(log);
  let failSet = true;
  const slowJar: CookieJar = {
    ...jar,
    remove: async (url, name) => { await new Promise((resolve) => setImmediate(resolve)); await jar.remove(url, name); },
    set: async (details) => {
      if (failSet) { failSet = false; throw new Error('set failed'); }
      await jar.set(details);
    },
  };
  await jar.set(cookie(1111, 'x'));
  await jar.set(cookie(2222, 'y'));
  log.length = 0;
  const { authorize, secretOf } = createViewerAuth(() => slowJar, (port) => log.push(`close all but ${port}`));
  const secret = newSecret();
  const [first, second] = await Promise.allSettled([authorize({ port: 4242, secret: newSecret() }), authorize({ port: 5151, secret })]);
  assert.equal(first.status, 'rejected');
  assert.deepEqual(second, { status: 'fulfilled', value: true });
  assert.deepEqual(log, [
    'close all but 4242', 'remove hive_secret_1111 http://127.0.0.1:1111', 'remove hive_secret_2222 http://127.0.0.1:2222',
    'close all but 5151', 'set hive_secret_5151',
  ]);
  assert.equal(secretOf(5151), secret);
});
