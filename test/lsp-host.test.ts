import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { localActivityId } from '../src/activities.js';
import { createConsoleStore } from '../src/console.js';
import type { CatalogLoad, SchemaCatalog } from '../src/json-schemas.js';
import { parseConfig } from '../src/config.js';
import { editorDir } from '../src/editor-install.js';
import { createLspHost, type LspHost } from '../src/lsp-host.js';
import { initialState } from '../src/orchestrator.js';
import { EDITOR_DEFAULTS, type EditorConfig, type ServerId } from '../src/types.js';
import { combConfig, LOCAL_STAGES } from './fakes.js';
import { withLocal } from './fixtures/work.js';
import { LSP_STUB, until } from './lsp-helpers.js';
import { type AfterHost, tempDir } from './temp-dir.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed?: { code: number; reason: string };
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code: number, reason: string): void { if (this.closed) return; this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  fromPage(message: object): void { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}

const ACTIVITY = localActivityId('hive');

// A server installed in `home` as the test's stand-in: its launch file and its installed.json
async function installServer(home: string, id: ServerId, file: string, body: string, version: string): Promise<void> {
  const dir = editorDir(home, { kind: 'server', id });
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), body);
  await chmod(join(dir, file), 0o755);
  await writeFile(join(dir, 'installed.json'), JSON.stringify({ version, installedAt: '2026-10-06T00:00:00.000Z' }));
}
// An executable the test writes outside the Hive's home: a project's copy, a tool on PATH
async function script(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
}
const STUB_SCRIPT = `#!/bin/sh\nexec "${process.execPath}" "${LSP_STUB}" "$@"\n`;

// A catalog that answers every load with `loaded` and counts the loads
const catalog = (loaded: CatalogLoad): SchemaCatalog & { loads: number } => {
  const stub = { loads: 0, load: async (): Promise<CatalogLoad> => { stub.loads += 1; return loaded; } };
  return stub;
};

// A home with pyright (an npm server: node runs its .bin) and clangd (a GitHub binary) installed as the stub, a workspace at a temp repo
async function host(t: AfterHost, editor: EditorConfig = EDITOR_DEFAULTS, idleMs = 60_000, env: NodeJS.ProcessEnv = {}, log?: { error(line: string): void }, schemas: SchemaCatalog = catalog({ associations: [] })): Promise<{ lsp: LspHost; store: ReturnType<typeof createConsoleStore>; root: string; home: string }> {
  const home = await tempDir(t, 'lsp-home-');
  const repo = await realpath(await tempDir(t, 'lsp-repo-'));
  await installServer(home, 'pyright', 'node_modules/.bin/pyright-langserver', await readFile(LSP_STUB, 'utf8'), '1.2.3');
  await installServer(home, 'clangd', 'clangd_21.1.0/bin/clangd', `#!/bin/sh\nexec "${process.execPath}" "${LSP_STUB}"\n`, '21.1.0');
  const config = parseConfig(combConfig({ stages: LOCAL_STAGES, path: repo, editor }));
  const state = withLocal(initialState(0), 'hive');
  const store = createConsoleStore(() => 5000);
  const lsp = createLspHost({ home, consoleStore: store, live: () => ({ config, state }), idleMs, log, schemas, env: { PATH: dirname(process.execPath), ...env } });
  t.after(() => lsp.stopAll());
  return { lsp, store, root: repo, home };
}

test('a socket gets { root, log } first; two sockets on one key share one process and one initialize (#780)', async (t) => {
  const { lsp, root } = await host(t);
  const [a, b] = [new FakeSocket(), new FakeSocket()];
  await lsp.attach(a, ACTIVITY, 'pyright', 'pyright-langserver');
  await lsp.attach(b, ACTIVITY, 'pyright', 'pyright-langserver');
  assert.equal(a.sent[0].root, root);
  assert.deepEqual(a.sent[0].log, b.sent[0].log);
  a.fromPage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  b.fromPage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  b.fromPage({ jsonrpc: '2.0', id: 2, method: 'hive/count' });
  await until(() => b.sent.some((m) => m.id === 2));
  assert.deepEqual(b.sent.find((m) => m.id === 2)?.result, { inits: 1 });
});

test('cpp and objective-c files share one clangd for an activity (#780)', async (t) => {
  const { lsp } = await host(t);
  const [cpp, objc] = [new FakeSocket(), new FakeSocket()];
  await lsp.attach(cpp, ACTIVITY, 'clangd', 'clangd');
  await lsp.attach(objc, ACTIVITY, 'clangd', 'clangd');
  assert.deepEqual(cpp.sent[0].log, objc.sent[0].log);
});

test('refused: a server not installed (absent), a binary it does not have (refused), a workspace out of every scope of the server (out of scope) (#780)', async (t) => {
  const { lsp } = await host(t, { ...EDITOR_DEFAULTS, languages: { cpp: { server: { workspaces: [] } }, 'objective-c': { server: { workspaces: [] } } } });
  const cases: [string, string, { code: number; reason: string }][] = [
    ['gopls', 'gopls', { code: 4404, reason: 'not installed' }],
    ['pyright', 'clangd', { code: 4400, reason: 'pyright has no binary clangd' }],
    ['clangd', 'clangd', { code: 4403, reason: 'clangd is off in hive' }],
  ];
  for (const [server, binary, closed] of cases) {
    const socket = new FakeSocket();
    await lsp.attach(socket, ACTIVITY, server, binary);
    assert.deepEqual(socket.closed, closed, server);
  }
});

test('the last client\'s close stops the process after the idle time: its console run ends done (#780)', async (t) => {
  const { lsp, store } = await host(t, EDITOR_DEFAULTS, 30);
  const socket = new FakeSocket();
  await lsp.attach(socket, ACTIVITY, 'pyright', 'pyright-langserver');
  socket.close(1000, '');
  await until(() => store.channels()[0]?.status === 'done');
});

test('a throw while resolving closes the socket as refused and is logged, never an unhandled rejection (#780)', async (t) => {
  const logged: string[] = [];
  const { lsp, root } = await host(t, EDITOR_DEFAULTS, 60_000, {}, { error: (line) => logged.push(line) });
  await rm(root, { recursive: true, force: true }); // realpath of the deleted folder throws
  const socket = new FakeSocket();
  await lsp.attach(socket, ACTIVITY, 'pyright', 'pyright-langserver');
  assert.deepEqual(socket.closed, { code: 4400, reason: 'pyright could not start' });
  assert.equal(logged.length, 1);
});

test('removing a server closes its clients as absent (4404), not as an ordinary stop (#780)', async (t) => {
  const { lsp } = await host(t);
  const socket = new FakeSocket();
  await lsp.attach(socket, ACTIVITY, 'pyright', 'pyright-langserver');
  await lsp.stopServer('pyright');
  assert.deepEqual(socket.closed, { code: 4404, reason: 'removed' });
});

test('the server\'s env drops what a worker\'s drops: the Hive\'s secret and home, NODE_PATH, CLAUDECODE (#780)', async (t) => {
  const { lsp } = await host(t, EDITOR_DEFAULTS, 60_000, { HIVE_SECRET: 's', HIVE_HOME: '/h', NODE_PATH: '/n', CLAUDECODE: '1', KEPT: 'yes' });
  const socket = new FakeSocket();
  await lsp.attach(socket, ACTIVITY, 'pyright', 'pyright-langserver');
  socket.fromPage({ jsonrpc: '2.0', id: 1, method: 'hive/env' });
  await until(() => socket.sent.some((m) => m.id === 1));
  assert.deepEqual(socket.sent.find((m) => m.id === 1)?.result, ['KEPT']);
});

const OFF = { enabled: false, args: [], workspaces: 'all' as const };
const argvOf = async (socket: FakeSocket): Promise<unknown> => {
  socket.fromPage({ jsonrpc: '2.0', id: 1, method: 'hive/argv' });
  await until(() => socket.sent.some((m) => m.id === 1));
  return socket.sent.find((m) => m.id === 1)?.result;
};

test('a checker\'s server follows its switch and scope: off in the workspace closes as out of scope; installed nowhere as absent (#782)', async (t) => {
  const { lsp } = await host(t, { ...EDITOR_DEFAULTS, languages: { python: { checkers: { ruff: OFF } } } });
  const cases: [string, string, { code: number; reason: string }][] = [
    ['ruff', 'ruff', { code: 4403, reason: 'ruff is off in hive' }],
    ['biome', 'biome', { code: 4404, reason: 'not installed' }],
  ];
  for (const [server, binary, closed] of cases) {
    const socket = new FakeSocket();
    await lsp.attach(socket, ACTIVITY, server, binary);
    assert.deepEqual(socket.closed, closed, server);
  }
});

test('the project\'s copy of a checker wins over the Hive\'s, launched with the catalog\'s args and the extra ones (#782)', async (t) => {
  const { lsp, store, root, home } = await host(t, { ...EDITOR_DEFAULTS, languages: { typescript: { checkers: { biome: { enabled: true, args: ['--colors=off'], workspaces: 'all' } } } } });
  await installServer(home, 'biome', 'node_modules/.bin/biome', 'process.exit(7)\n', '2.2.0');
  await script(join(root, 'node_modules', '.bin', 'biome'), STUB_SCRIPT);
  const socket = new FakeSocket();
  await lsp.attach(socket, ACTIVITY, 'biome', 'biome');
  assert.deepEqual(await argvOf(socket), ['lsp-proxy', '--colors=off']);
  assert.ok(store.channels().length > 0 && store.channels().every((c) => !(store.history(c.id)?.history ?? '').includes('--colors=off')), 'the user\'s extra args stay out of the console header');
});

test('dart\'s server is the dart on PATH, launched as language-server; without one it requires dart (#782)', async (t) => {
  const bin = await tempDir(t, 'lsp-dart-');
  const { lsp } = await host(t, EDITOR_DEFAULTS, 60_000, { PATH: bin });
  const refused = new FakeSocket();
  await lsp.attach(refused, ACTIVITY, 'dart', 'dart');
  assert.deepEqual(refused.closed, { code: 4404, reason: 'requires dart' });
  await script(join(bin, 'dart'), STUB_SCRIPT);
  const socket = new FakeSocket();
  await lsp.attach(socket, ACTIVITY, 'dart', 'dart');
  assert.deepEqual(await argvOf(socket), ['language-server', '--protocol=lsp']);
});

test('eslint\'s server gets its settings from the host: validate on, run on type, the root as its working directory (#782)', async (t) => {
  const { lsp, root, home } = await host(t);
  await installServer(home, 'eslint', 'node_modules/.bin/vscode-eslint-language-server', await readFile(LSP_STUB, 'utf8'), '4.10.0');
  await script(join(root, 'node_modules', '.bin', 'eslint'), '#!/bin/sh\nexit 0\n'); // the project's eslint: its server is still the Hive's
  const socket = new FakeSocket();
  await lsp.attach(socket, ACTIVITY, 'eslint', 'vscode-eslint-language-server');
  socket.fromPage({ jsonrpc: '2.0', id: 2, method: 'hive/ask' });
  await until(() => socket.sent.some((m) => m.id === 2));
  const answers = socket.sent.find((m) => m.id === 2)?.result as Record<string, { validate: string; run: string; workingDirectory: { directory: string } }[]>;
  const [first, second] = answers['workspace/configuration'];
  assert.deepEqual([first.validate, first.run, first.workingDirectory.directory], ['on', 'onType', root]);
  assert.deepEqual(second, first);
});

const ASSOCIATIONS = [{ uri: 'https://json.schemastore.org/package.json', fileMatch: ['package.json'] }];
const JSON_SERVER = ['vscode-langservers-extracted', 'vscode-json-language-server'] as const;

// web's servers installed as the stub: one install, a binary per language
async function installWeb(home: string): Promise<void> {
  const stub = await readFile(LSP_STUB, 'utf8');
  for (const binary of ['vscode-json-language-server', 'vscode-css-language-server']) await installServer(home, 'vscode-langservers-extracted', `node_modules/.bin/${binary}`, stub, '4.10.0');
}
const notifiedOf = async (socket: FakeSocket): Promise<unknown> => {
  socket.fromPage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  socket.fromPage({ jsonrpc: '2.0', method: 'initialized', params: {} });
  socket.fromPage({ jsonrpc: '2.0', id: 2, method: 'hive/notified' });
  await until(() => socket.sent.some((m) => m.id === 2));
  return socket.sent.find((m) => m.id === 2)?.result;
};

test('the JSON server gets the catalog\'s associations after initialized; the CSS server and another server get none (#794)', async (t) => {
  const schemas = catalog({ associations: ASSOCIATIONS });
  const { lsp, home } = await host(t, EDITOR_DEFAULTS, 60_000, {}, undefined, schemas);
  await installWeb(home);
  const [json, css, python] = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  await lsp.attach(json, ACTIVITY, ...JSON_SERVER);
  await lsp.attach(css, ACTIVITY, 'vscode-langservers-extracted', 'vscode-css-language-server');
  await lsp.attach(python, ACTIVITY, 'pyright', 'pyright-langserver');
  assert.deepEqual(await notifiedOf(json), [{ method: 'initialized', params: {} }, { method: 'json/schemaAssociations', params: ASSOCIATIONS }]);
  for (const socket of [css, python]) assert.deepEqual(await notifiedOf(socket), [{ method: 'initialized', params: {} }]);
  assert.equal(schemas.loads, 1);
});

test('a failed catalog starts the JSON server with no associations and the reason after its command; a second client does not load again (#794)', async (t) => {
  const schemas = catalog({ failure: 'HTTP 503' });
  const { lsp, store, home } = await host(t, EDITOR_DEFAULTS, 60_000, {}, undefined, schemas);
  await installWeb(home);
  const [a, b] = [new FakeSocket(), new FakeSocket()];
  await lsp.attach(a, ACTIVITY, ...JSON_SERVER);
  await lsp.attach(b, ACTIVITY, ...JSON_SERVER);
  assert.deepEqual(a.sent[0].log, b.sent[0].log);
  assert.deepEqual(await notifiedOf(a), [{ method: 'initialized', params: {} }]);
  assert.equal(schemas.loads, 1);
  await lsp.stopAll(); // a run joins its channel's history only once it ended
  const history = store.channels().map((c) => store.history(c.id)?.history ?? '').join('');
  assert.match(history, /> vscode-json-language-server --stdio[^\r\n]*\r\nJSON schemas unavailable: HTTP 503\r\n/);
});
