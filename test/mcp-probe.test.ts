import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { RunMcpServer } from '../src/agents/runner.js';
import { cachedProbe, PROBE_CACHE_MS, type ProbeAnswer, probeCommand, probeServer } from '../src/mcp-probe.js';
import { fakeLog } from './fakes.js';
import { tempDir } from './temp-dir.js';

// A server's state (#333): initialize over stdio or Streamable HTTP within the timeout, anything else no_answer; a cache of 30 s per name
const STUB = fileURLToPath(new URL('../../test/fixtures/mcp-stub.mjs', import.meta.url));
const node = (name: string, ...args: string[]): RunMcpServer => ({ name, command: process.execPath, args });

test('a command server that completes initialize is connected (#333)', async (t) => {
  const { log } = fakeLog();
  assert.equal(await probeServer(node('stub', STUB), { timeoutMs: 20_000, cwd: await tempDir(t, 'probe-'), log }), 'connected');
});

test('a command that exits, or that is not there, is no_answer, and the reason goes to the log at debug (#333)', async (t) => {
  const { log, lines } = fakeLog();
  const cwd = await tempDir(t, 'probe-');
  assert.equal(await probeServer(node('exits', '-e', 'process.exit(1)'), { timeoutMs: 20_000, cwd, log }), 'no_answer');
  assert.equal(await probeServer({ name: 'missing', command: '/nonexistent/mcp-server', args: [] }, { timeoutMs: 20_000, cwd, log }), 'no_answer');
  assert.ok(lines.some((line) => line.startsWith('DEBUG mcp probe exits: no answer')), lines.join('\n'));
  assert.equal(lines.some((line) => line.includes('/nonexistent/mcp-server')), false, 'no error message in the log');
  assert.ok(lines.some((line) => line.startsWith('DEBUG mcp probe missing: no answer')), lines.join('\n'));
});

test('a server that never answers is no_answer at the timeout (#333)', async (t) => {
  const { log } = fakeLog();
  const began = Date.now();
  assert.equal(await probeServer(node('stall', STUB, 'stall'), { timeoutMs: 300, cwd: await tempDir(t, 'probe-'), log }), 'no_answer');
  assert.ok(Date.now() - began < 15_000, 'the given timeout, not a default');
});

test('a URL server is asked with its header; a refusal is no_answer and the log never holds the value (#333)', async (t) => {
  const seen: (string | undefined)[] = [];
  const http = createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(500).end(); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => http.close());
  const { port } = http.address() as AddressInfo;
  const { log, lines } = fakeLog();
  const server: RunMcpServer = { name: 'docs', url: `http://127.0.0.1:${port}/mcp`, header: { name: 'Authorization', value: 'Bearer t0k' } };
  assert.equal(await probeServer(server, { timeoutMs: 20_000, cwd: await tempDir(t, 'probe-'), log }), 'no_answer');
  assert.equal(seen[0], 'Bearer t0k');
  assert.equal(lines.join('\n').includes('t0k'), false);
  assert.ok(lines.some((line) => /^DEBUG mcp probe docs: no answer \(\w+\)$/.test(line)), `the name and the error's class only: ${lines.join('\n')}`);
});

test('the cache answers a second ask within 30 s without probing; a changed definition or header value, or 30 s, probes again (#333)', async () => {
  let clock = 0;
  const asked: string[] = [];
  const probe = cachedProbe(async (s) => { asked.push(s.name); return 'connected' as ProbeAnswer; }, () => clock);
  const docs: RunMcpServer = { name: 'docs', url: 'https://a.example/mcp' };
  const withValue: RunMcpServer = { ...docs, header: { name: 'Authorization', value: 'new' } };
  assert.equal(await probe(docs), 'connected');
  await probe(docs);
  assert.equal(asked.length, 1, 'from the cache');
  await probe(withValue);
  assert.equal(asked.length, 2, 'a new header value drops the entry');
  clock = PROBE_CACHE_MS;
  await probe(withValue);
  assert.equal(asked.length, 3, 'expired');
});

test('on win32 a command server is spawned by its full path, an .exe\'s or a .cmd\'s; a name found nowhere, and every name on darwin, as written (#633)', () => {
  const env = { Path: 'C:\\tools;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const files = new Set(['c:\\tools\\uvx.exe', 'c:\\npm\\npx.cmd']);
  const isFile = (file: string): boolean => files.has(file.toLowerCase());
  assert.equal(probeCommand('uvx', { platform: 'win32', env, isFile }), 'C:\\tools\\uvx.exe');
  assert.equal(probeCommand('npx', { platform: 'win32', env, isFile }), 'C:\\npm\\npx.cmd', 'cross-spawn wraps a .cmd in cmd.exe itself');
  assert.equal(probeCommand('missing-server', { platform: 'win32', env, isFile }), 'missing-server', 'fails in the probe as it does today');
  assert.equal(probeCommand('npx', { platform: 'darwin', env, isFile: () => assert.fail('no lookup off win32') }), 'npx');
});

test('with platform win32 a command server named by its full path still connects (#633)', async (t) => {
  const { log } = fakeLog();
  // on win32 node.exe resolves to itself; elsewhere the win32 lookup finds no .exe and keeps the path as written
  assert.equal(await probeServer(node('stub', STUB), { timeoutMs: 20_000, cwd: await tempDir(t, 'probe-'), log, platform: 'win32', env: process.env }), 'connected');
});
