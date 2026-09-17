import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HIVE_BIN = fileURLToPath(new URL('../../bin/hive.js', import.meta.url));

// this machine may export a global NODE_PATH pointing at the real project's node_modules; strip it so a
// tree that deliberately has no node_modules/electron is not silently rescued by that legacy fallback
const envWithoutNodePath: NodeJS.ProcessEnv = { ...process.env };
delete envWithoutNodePath.NODE_PATH;

/** Reserves a free localhost port, releases it immediately (a caller binds it right after). */
async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => (port === undefined ? reject(new Error('no free port')) : resolvePromise(port)));
    });
  });
}

// ESM fake main.js: logs, waits ~300ms, then records the repo path and PATH it saw.
const FAKE_MAIN_JS = `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const repo = process.argv[2];
console.log('fake main up');
setTimeout(() => {
  writeFile(join(repo, 'marker'), process.env.PATH ?? '');
}, 300);
`;

/** Builds a fake package tree ready to launch: package.json, a fake electron package, dist/src/main.js. */
async function setupLaunchableRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-'));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'electron'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  // require('electron') resolves to the node binary; the "Electron" child is node running fake main.js
  await writeFile(join(root, 'node_modules', 'electron', 'package.json'), '{ "type": "commonjs", "main": "index.js" }\n');
  await writeFile(join(root, 'node_modules', 'electron', 'index.js'), 'module.exports = process.execPath;\n');
  await writeFile(join(root, 'dist', 'src', 'main.js'), FAKE_MAIN_JS);
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  return root;
}

test('hive exits 2 with a build hint when dist/src/main.js is missing', async () => {
  // copy the script into a tree without dist/ (and without node_modules, so electron is never resolved)
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  await assert.rejects(
    execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), root]),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? '', /pnpm build/);
      return true;
    },
  );
});

test('hive exits 2 with a not-found hint when the repo argument does not exist', async () => {
  // fake dist/src/main.js so the build check passes; the missing-repo check must fire first anyway
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-'));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, 'dist', 'src', 'main.js'), '');
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  const missing = join(root, 'does-not-exist');
  await assert.rejects(
    execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), missing]),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? '', /diretório não encontrado/);
      return true;
    },
  );
});

test('hive exits 1 with an install hint when electron is not installed', async () => {
  // fake dist/src/main.js so the build check passes, but no node_modules/electron, so require('electron') throws
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-'));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, 'dist', 'src', 'main.js'), '');
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  await assert.rejects(
    execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), root], { env: envWithoutNodePath }),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr ?? '', /pnpm install/);
      return true;
    },
  );
});

test('hive returns before the child finishes and leaves it running detached', async () => {
  const root = await setupLaunchableRoot();
  const repo = await mkdtemp(join(tmpdir(), 'hive-repo-'));
  // pin an explicit, freshly-reserved port so this does not depend on nothing else listening on the default port
  const port = await getFreePort();
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ port }));
  const marker = join(repo, 'marker');
  const { stdout } = await execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), repo], {
    env: { ...envWithoutNodePath, PATH: `${process.env.PATH}:/hive-test-marker` },
  });

  assert.match(stdout, /Agent Hive iniciado \(pid \d+/);
  // the parent returned well before the 300ms fake main.js takes to write the marker
  assert.equal(existsSync(marker), false);

  const deadline = Date.now() + 3000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await delay(50);
  }
  assert.equal(existsSync(marker), true);
  const markerContent = await readFile(marker, 'utf8');
  assert.match(markerContent, /\/hive-test-marker/); // inherited PATH reached the detached child

  const log = await readFile(join(repo, '.hive', 'hive.log'), 'utf8');
  assert.match(log, /fake main up/); // child's stdout went to the log file
});

test('hive reports the running instance instead of starting a second one', async () => {
  const root = await setupLaunchableRoot();
  const repo = await mkdtemp(join(tmpdir(), 'hive-repo-'));
  const server: Server = createHttpServer((req, res) => {
    if (req.url === '/setup') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: true, repo: '/some/repo' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
    const { port } = server.address() as AddressInfo;
    await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ port }));

    const { stdout } = await execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), repo], {
      env: envWithoutNodePath,
    });
    assert.match(stdout, /já está rodando/);
    assert.match(stdout, /\/some\/repo/);

    await delay(600);
    assert.equal(existsSync(join(repo, 'marker')), false); // nothing was spawned
  } finally {
    server.close();
  }
});

test('hive exits 1 when the port is taken by something that is not a Hive', async () => {
  const root = await setupLaunchableRoot();
  const repo = await mkdtemp(join(tmpdir(), 'hive-repo-'));
  const server: Server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('nope');
  });
  try {
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
    const { port } = server.address() as AddressInfo;
    await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ port }));

    await assert.rejects(
      execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), repo], { env: envWithoutNodePath }),
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr ?? '', /em uso por outro processo/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('hive exits 1 when the port is held by a listener that never answers', async () => {
  // a Hive still booting, or a hung process: occupied is the safe reading, never "free"
  const root = await setupLaunchableRoot();
  const repo = await mkdtemp(join(tmpdir(), 'hive-repo-'));
  const server = createNetServer(() => { /* accept and stay silent */ });
  try {
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
    const { port } = server.address() as AddressInfo;
    await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ port }));
    await assert.rejects(
      execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), repo], { env: envWithoutNodePath }),
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr ?? '', /em uso e sem resposta/);
        return true;
      },
    );
    assert.equal(existsSync(join(repo, 'marker')), false); // nothing was spawned
  } finally {
    server.close();
  }
});

test('hive exits 2 when hive.config.json has a port that is not an integer', async () => {
  const root = await setupLaunchableRoot();
  const repo = await mkdtemp(join(tmpdir(), 'hive-repo-'));
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ port: '47821' }));
  await assert.rejects(
    execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), repo], { env: envWithoutNodePath }),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? '', /"port" must be a non-negative integer/);
      return true;
    },
  );
});
