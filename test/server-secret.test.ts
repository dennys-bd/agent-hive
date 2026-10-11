import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { newSecret, SECRET_HEADER, secretCookie } from '../src/secret.js';
import { createServer } from '../src/server.js';
import { fakeLog } from './fakes.js';
import { directive, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// A daemon in setup mode on a free port: every route below answers before any config exists, so whatever refuses a request is the gate (#467)
async function start(t: TestContext): Promise<{ base: string; port: number; lines: string[] }> {
  const { log, lines } = fakeLog();
  const server = createServer({ home: await tempDir(t, 'home-'), log, secret: SECRET });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${port}`, port, lines };
}

const JSON_TYPE = { 'content-type': 'application/json' };
// One request of each kind the daemon serves: the API, a dashboard POST, a hook, the MCP route and the page itself
const ROUTES: { method: string; path: string; headers: Record<string, string>; body?: string }[] = [
  { method: 'GET', path: '/ptys', headers: {} },
  { method: 'POST', path: '/signal', headers: { ...JSON_TYPE, 'x-hive-ui': '1' }, body: JSON.stringify({ signal: 'green' }) },
  { method: 'POST', path: '/hooks/event', headers: JSON_TYPE, body: '{}' },
  { method: 'POST', path: '/hooks/mcp', headers: JSON_TYPE, body: '{}' },
  { method: 'GET', path: '/', headers: {} },
];

test('without the secret, or with another value, every route answers 403 { error: "segredo inválido" }: the API, a dashboard POST with x-hive-ui, a hook, the MCP route and the page (#467)', async (t) => {
  const { base } = await start(t);
  for (const { method, path, headers, body } of ROUTES) {
    const attempts: Record<string, string>[] = [{}, { [SECRET_HEADER]: newSecret() }]; // none, and a value of another boot
    for (const presented of attempts) {
      const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...presented }, body });
      assert.equal(res.status, 403, `${method} ${path} ${JSON.stringify(Object.keys(presented))}`);
      assert.deepEqual(await res.json(), { error: 'segredo inválido' });
    }
  }
});

test('the secret opens the daemon by the x-hive-secret header or by the cookie of its own port; another port\'s cookie does not (#467)', async (t) => {
  const { base, port } = await start(t);
  const workers = async (headers: Record<string, string>): Promise<number> => (await fetch(`${base}/ptys`, { headers })).status;
  assert.equal(await workers({ [SECRET_HEADER]: SECRET }), 200, 'the CLI, the menu bar, a worker');
  assert.equal(await workers({ cookie: `theme=dark; ${secretCookie(port)}=${SECRET}` }), 200, 'the viewer\'s page');
  assert.equal(await workers({ cookie: `${secretCookie(port + 1)}=${SECRET}` }), 403, 'a test Hive beside this one keeps its own cookie');
  assert.equal((await fetch(`${base}/`, { headers: { [SECRET_HEADER]: SECRET } })).status, 200, 'the page itself');
});

test('the secret does not replace the other checks: a POST with it but without x-hive-ui is still refused as a foreign origin (#467)', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/signal`, { method: 'POST', headers: { ...JSON_TYPE, [SECRET_HEADER]: SECRET }, body: JSON.stringify({ signal: 'green' }) });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'origem não permitida' }, 'a page on another port of 127.0.0.1 gets the cookie too');
});

test('a refusal is logged at debug with its method and path, never with a value (#467)', async (t) => {
  const { base, lines } = await start(t);
  const presented = newSecret();
  await fetch(`${base}/ptys`, { headers: { [SECRET_HEADER]: presented } });
  assert.ok(lines.includes('DEBUG refused without the secret: GET /ptys'), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes(presented) || line.includes(SECRET)), 'no secret in a log line');
});

test('the pages answer with a Content-Security-Policy: images and media never reach an http: listener, connections stay same-origin, no object or base, frames only from the design frame route (#467, #108)', async (t) => {
  const { base, port } = await start(t);
  for (const path of ['/', '/terminal.html']) {
    const res = await fetch(`${base}${path}`, { headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(res.status, 200, path);
    const policy = res.headers.get('content-security-policy') ?? '';
    for (const name of ['img-src', 'media-src']) {
      const sources = directive(policy, name) ?? [];
      assert.ok(sources.includes("'self'") && sources.includes('https:'), `${path} ${name}: ${policy}`);
      assert.ok(!sources.includes('http:') && !sources.includes('*'), `${path} ${name}: another 127.0.0.1 port would get the port's cookie`);
    }
    assert.deepEqual(directive(policy, 'connect-src'), ["'self'"], `${path}: ${policy}`);
    for (const name of ['object-src', 'base-uri']) assert.deepEqual(directive(policy, name), ["'none'"], `${path} ${name}`);
    assert.deepEqual(directive(policy, 'frame-src'), [`http://127.0.0.1:${port}/design-frame/`, `http://localhost:${port}/design-frame/`], `${path}: the design frame route alone (#108)`);
  }
});
