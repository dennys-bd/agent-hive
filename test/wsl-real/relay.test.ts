// The relay (#948 decision 13): a plain HTTP server on the Windows 127.0.0.1 stands for the Hive's port, so nothing but the relay is under
// test. curl inside the distro reaches it through the port the helper's hello named, which the helper keeps in relay-port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RELAY_PORT_FILE } from '../../src/wsl/helper-main.js';
import { hiveFolderOf, realWsl, stdoutOf } from './real-wsl.js';

const BODY = 'the WSL lane ação 🐝';
const PORT_FILE_MAX = 64;

test('curl inside the distro to 127.0.0.1:<relayPort> gets the answer of the server on the Windows 127.0.0.1, its body intact (#948)', async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      res.end(`echo:${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const { machine } = realWsl(t, { hivePort: () => port });
  const portFile = machine.paths.join(await hiveFolderOf(machine), RELAY_PORT_FILE);
  const relayPort = (await machine.fs.readFile(portFile, { maxBytes: PORT_FILE_MAX, encoding: 'utf8' })).trim();
  const answer = await stdoutOf(machine, 'curl', ['-sS', '-f', '-m', '30', '--noproxy', '*', '-X', 'POST', '--data-binary', BODY, `http://127.0.0.1:${relayPort}/relay-948`]);
  assert.equal(answer, `echo:${BODY}`);
  assert.deepEqual(seen, ['POST /relay-948']);
});
