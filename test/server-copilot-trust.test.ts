import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { registerCopilotTrustRoute } from '../src/server-copilot-trust.js';
import { tempDir } from './temp-dir.js';

// GET /settings/copilot-trust (#880): the saved workspace folders Copilot would stop in on its trust screen, against a temp COPILOT_HOME.

async function trustRead(t: TestContext, home: string, paths: readonly string[]): Promise<[number, unknown]> {
  const app = express();
  registerCopilotTrustRoute(app, { workspacePaths: () => paths, info: () => ({ homedir: home, copilotHome: home, platform: process.platform }) });
  // bound to the host the fetch calls: a wildcard bind can share its port number with another test's 127.0.0.1 server
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/settings/copilot-trust`);
  return [res.status, await res.json()];
}

test('GET /settings/copilot-trust answers the saved workspace paths no trustedFolders entry covers, in config order and as saved; a missing config.json answers [] (#880)', async (t) => {
  const root = await tempDir(t, 'copilot-trust-ws-');
  const home = await tempDir(t, 'copilot-trust-home-');
  const [trusted, inside, second, first] = [join(root, 'trusted'), join(root, 'trusted', 'repo'), join(root, 'b'), join(root, 'a')];
  await mkdir(inside, { recursive: true });
  await mkdir(second);
  await mkdir(first);
  const paths = [second, inside, first];
  assert.deepEqual(await trustRead(t, home, paths), [200, { uncovered: [] }], 'no config.json: unknown, so no hint');
  await writeFile(join(home, 'config.json'), JSON.stringify({ trustedFolders: [trusted] }));
  assert.deepEqual(await trustRead(t, home, paths), [200, { uncovered: [second, first] }]);
});
