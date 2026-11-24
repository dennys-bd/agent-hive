import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeDaemonPort, writeDaemonSecret } from '../src/daemon-files.js';
import { stopDaemon } from '../src/daemon.js';
import { newSecret } from '../src/secret.js';
import { tempDir } from './temp-dir.js';

// Five of stopDaemon's 200 ms polls: long enough for the old poll to have ended
const LINGER_MS = 1000;

// A daemon whose port outlives its /stop (#970): GET /settings answers as `home` until POST /stop, then as nobody's Hive (a 200 with no
// home, so the probe reads foreign), until close() is called
async function lingering(t: TestContext, home: string): Promise<{ port: number; close: () => void }> {
  let stopped = false;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/stop') stopped = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stopped ? { ok: true } : { home, configured: true }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

test('stopDaemon resolves true only once the port it stopped refuses: one that still answers after /stop, as anything, is not stopped yet (#970)', async (t) => {
  const home = await tempDir(t, 'daemon-stop-');
  const daemon = await lingering(t, home);
  writeDaemonPort(home, daemon.port);
  writeDaemonSecret(home, newSecret());
  let settled = false;
  const stopping = stopDaemon(home).finally(() => { settled = true; });
  await sleep(LINGER_MS);
  assert.equal(settled, false, 'the port still answers: not stopped');
  daemon.close();
  assert.equal(await stopping, true);
});
