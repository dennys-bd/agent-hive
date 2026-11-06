import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { drawioPolicy } from '../src/server-drawio.js';
import { fakeLog, tempHive } from './fakes.js';
import { directive, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

const PAGE = '<!doctype html><html><head><title>draw.io</title></head><body></body></html>';
const SCRIPT = 'window.drawio = true;\n';

// The webapp's folder: a page, a script in a subfolder, the stamp; secret.txt sits beside the folder, outside what the route serves
async function fixture(t: TestContext): Promise<string> {
  const dir = await tempDir(t, 'drawio-');
  const root = join(dir, 'drawio');
  await mkdir(join(root, 'js'), { recursive: true });
  await writeFile(join(root, 'index.html'), PAGE);
  await writeFile(join(root, 'js', 'a.js'), SCRIPT);
  await writeFile(join(root, '.hive-drawio'), '32.6.10 abc');
  await writeFile(join(dir, 'secret.txt'), 'outside the webapp\n');
  return root;
}

async function start(t: TestContext, drawioRoot: string): Promise<{ base: string; port: number }> {
  const { home } = await tempHive(t);
  const server = createServer({ secret: SECRET, home, exec: async () => ({ stdout: '' }), log: fakeLog().log, drawioRoot });
  const port = await server.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${port}`, port };
}

// fetch always sets Host from the URL, so another Host needs node:http directly
function getWithHost(port: number, path: string, host: string): Promise<{ status: number; policy: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      res.resume();
      const policy = res.headers['content-security-policy'];
      resolve({ status: res.statusCode ?? 0, policy: typeof policy === 'string' ? policy : undefined });
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /drawio/index.html answers the page without the secret, sandboxed to scripts with no same-origin, connections only to the route, open to any origin, nosniff and no referrer; a script answers the same way (#955)', async (t) => {
  const { base, port } = await start(t, await fixture(t));
  const page = await fetch(`${base}/drawio/index.html`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), PAGE);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  const policy = page.headers.get('content-security-policy') ?? '';
  assert.equal(policy, drawioPolicy(`127.0.0.1:${port}`));
  assert.deepEqual(directive(policy, 'sandbox'), ['allow-scripts']);
  assert.ok(!policy.includes('allow-same-origin'), policy);
  assert.deepEqual(directive(policy, 'connect-src'), [`http://127.0.0.1:${port}/drawio/`]);
  assert.deepEqual(directive(policy, 'frame-ancestors'), ["'self'"]);
  assert.equal(page.headers.get('access-control-allow-origin'), '*');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const script = await fetch(`${base}/drawio/js/a.js`);
  assert.equal(script.status, 200);
  assert.equal(await script.text(), SCRIPT);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.equal(script.headers.get('content-security-policy'), policy);
  assert.equal(script.headers.get('access-control-allow-origin'), '*');
});

test('a folder, with or without its slash, a missing file, the stamp and an encoded traversal answer a bare 404 with the route\'s headers, never a redirect or a listing (#955)', async (t) => {
  const { base, port } = await start(t, await fixture(t));
  // %2F keeps ../ inside one segment: fetch's URL parser resolves a bare ../ (and %2e%2e) before the request leaves; send answers it 403
  for (const path of ['/drawio/js/', '/drawio/js', '/drawio/', '/drawio', '/drawio/nope.js', '/drawio/.hive-drawio', '/drawio/..%2Fsecret.txt', '/drawio/js/..%2F..%2Fsecret.txt']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), '', path);
    assert.equal(res.headers.get('location'), null, path);
    assert.equal(res.headers.get('content-security-policy'), drawioPolicy(`127.0.0.1:${port}`), path);
  }
});

test('a missing root, the webapp skipped, answers 404 under the prefix (#955)', async (t) => {
  const { base } = await start(t, join(await tempDir(t, 'drawio-'), 'missing'));
  for (const path of ['/drawio/index.html', '/drawio/js/a.js']) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
});

test('the route sits after the Host check and before the secret: another Host is refused, localhost gets its own connect-src, and a path outside the prefix still needs the secret (#955)', async (t) => {
  const { base, port } = await start(t, await fixture(t));
  assert.equal((await getWithHost(port, '/drawio/index.html', 'evil.example')).status, 403);
  const local = await getWithHost(port, '/drawio/index.html', `localhost:${port}`);
  assert.equal(local.status, 200);
  assert.deepEqual(directive(local.policy ?? '', 'connect-src'), [`http://localhost:${port}/drawio/`]);
  assert.equal((await fetch(`${base}/settings`)).status, 403, 'the secret gate still holds outside /drawio/');
});
