import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createConsoleStore, lspChannel } from '../src/console.js';
import { createLspProcess, type LspProcess, type ProcessSpec } from '../src/lsp-process.js';
import { type FakePeer, fakePeer, LSP_STUB, until } from './lsp-helpers.js';
import { tempDir } from './temp-dir.js';

const answer = async (peer: FakePeer, id: number): Promise<Record<string, unknown>> => {
  await until(() => peer.sent.some((m) => m.id === id));
  return peer.sent.find((m) => m.id === id) as Record<string, unknown>;
};

function start(command = process.execPath, extra: Partial<ProcessSpec> = {}): { proc: LspProcess; store: ReturnType<typeof createConsoleStore>; gone: () => boolean } {
  const store = createConsoleStore(() => 5000);
  let isGone = false;
  const proc = createLspProcess({
    command, args: [LSP_STUB], cwd: dirname(LSP_STUB), env: process.env, root: '/w/root', shown: 'stub --stdio',
    channel: lspChannel('hive', 'pyright'), label: '#HIVE-1', consoleStore: store, onGone: () => { isGone = true; }, ...extra,
  });
  return { proc, store, gone: () => isGone };
}

test('initialize goes to the server once, with the root injected; a later client gets the stored answer (#780)', async (t) => {
  const { proc } = start();
  t.after(() => proc.stop());
  const [a, b] = [fakePeer(), fakePeer()];
  proc.join(a);
  proc.join(b);
  proc.fromPeer(a, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, capabilities: {} } });
  const first = (await answer(a, 1)).result as { rootUri: string; folders: { uri: string; name: string }[] };
  assert.deepEqual([first.rootUri, first.folders], ['file:///w/root', [{ uri: 'file:///w/root', name: 'root' }]]);
  proc.fromPeer(b, { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
  assert.deepEqual((await answer(b, 7)).result, first);
  proc.fromPeer(b, { jsonrpc: '2.0', id: 8, method: 'hive/count' });
  assert.deepEqual((await answer(b, 8)).result, { inits: 1 });
});

test('two clients\' requests with the same id each get their own answer; the server saw two ids (#780)', async (t) => {
  const { proc } = start();
  t.after(() => proc.stop());
  const [a, b] = [fakePeer(), fakePeer()];
  proc.join(a);
  proc.join(b);
  proc.fromPeer(a, { jsonrpc: '2.0', id: 1, method: 'hive/echo', params: 'a' });
  proc.fromPeer(b, { jsonrpc: '2.0', id: 1, method: 'hive/echo', params: 'b' });
  const [ra, rb] = [(await answer(a, 1)).result as { seen: string; params: string }, (await answer(b, 1)).result as { seen: string; params: string }];
  assert.deepEqual([ra.params, rb.params], ['a', 'b']);
  assert.notEqual(ra.seen, rb.seen);
});

test('the host answers the server\'s own requests; publishDiagnostics reaches every client, logMessage the console, nothing else (#780)', async () => {
  const { proc, store } = start();
  const [a, b] = [fakePeer(), fakePeer()];
  proc.join(a);
  proc.join(b);
  proc.fromPeer(a, { jsonrpc: '2.0', id: 2, method: 'hive/ask' });
  assert.deepEqual((await answer(a, 2)).result, {
    'workspace/configuration': [null, null], 'client/registerCapability': null, 'workspace/workspaceFolders': [{ uri: 'file:///w/root', name: 'root' }],
    'workspace/applyEdit': { applied: false }, 'window/workDoneProgress/create': null, 'window/showMessageRequest': null,
    'hive/unknown': { code: -32601, message: 'hive/unknown is not handled by the Hive' },
  });
  for (const peer of [a, b]) assert.equal(peer.sent.filter((m) => m.method === 'textDocument/publishDiagnostics').length, 1);
  assert.equal([...a.sent, ...b.sent].some((m) => m.method === '$/progress' || m.method === 'window/logMessage'), false);
  await proc.stop();
  assert.match(store.history(lspChannel('hive', 'pyright').id)?.history ?? '', /── #HIVE-1 · \d\d:\d\d:\d\d ──[\s\S]*> stub --stdio[\s\S]*hello log/);
  assert.equal(store.channels()[0].status, 'done');
  assert.deepEqual(a.closed, { code: 1000, reason: 'stopped' });
});

test('a server that dies closes its clients with 1011 and its reason, and fails its console run (#780)', async () => {
  const { proc, store, gone } = start();
  const a = fakePeer();
  proc.join(a);
  proc.fromPeer(a, { jsonrpc: '2.0', method: 'hive/crash' });
  await until(() => a.closed !== undefined);
  assert.deepEqual(a.closed, { code: 1011, reason: 'exit code 3' });
  assert.ok(gone());
  assert.equal(store.channels()[0].status, 'failed');
  assert.match(store.history(lspChannel('hive', 'pyright').id)?.history ?? '', /dying/);
});

test('a binary that is not there closes its clients with 1011 and spawn ENOENT (#780)', async () => {
  const { proc } = start('/nonexistent/stub');
  const a = fakePeer();
  proc.join(a);
  await until(() => a.closed !== undefined);
  assert.deepEqual(a.closed, { code: 1011, reason: 'spawn stub ENOENT' });
});

test('a server that ignores shutdown and SIGTERM is killed, so stop always ends; a stop can name how the clients close (#780)', async () => {
  const store = createConsoleStore(() => 5000);
  const proc = createLspProcess({
    command: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], cwd: dirname(LSP_STUB), env: process.env, root: '/w/root', shown: 'stub',
    channel: lspChannel('hive', 'pyright'), label: '#HIVE-1', consoleStore: store, onGone: () => undefined, graceMs: 150,
  });
  const a = fakePeer();
  proc.join(a);
  await new Promise((resolve) => setTimeout(resolve, 300)); // node has installed its SIGTERM handler
  await proc.stop({ code: 4404, reason: 'removed' });
  assert.deepEqual(a.closed, { code: 4404, reason: 'removed' });
});

const SCHEMAS = { method: 'json/schemaAssociations', params: [{ uri: 'https://json.schemastore.org/package.json', fileMatch: ['package.json'] }] };

test('afterInitialized reaches the server right after the first initialized, once, even when a second client sends initialized (#794)', async (t) => {
  const { proc } = start(process.execPath, { afterInitialized: [SCHEMAS] });
  t.after(() => proc.stop());
  const [a, b] = [fakePeer(), fakePeer()];
  proc.join(a);
  proc.join(b);
  proc.fromPeer(a, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await answer(a, 1);
  proc.fromPeer(a, { jsonrpc: '2.0', method: 'initialized', params: {} });
  proc.fromPeer(b, { jsonrpc: '2.0', method: 'initialized', params: {} });
  proc.fromPeer(b, { jsonrpc: '2.0', id: 2, method: 'hive/notified' });
  assert.deepEqual((await answer(b, 2)).result, [{ method: 'initialized', params: {} }, SCHEMAS]);
});

test('a notice is the run\'s line right after the command (#794)', async () => {
  const { proc, store } = start(process.execPath, { notice: 'JSON schemas unavailable: timeout' });
  await proc.stop();
  assert.match(store.history(lspChannel('hive', 'pyright').id)?.history ?? '', /> stub --stdio[^\r\n]*\r\nJSON schemas unavailable: timeout\r\n/);
});

const WIN32_ONLY = { skip: process.platform !== 'win32' && 'win32 only: a real .cmd server through cmd.exe (#635)' };

test('on win32 a .cmd server starts through the resolver and answers initialize; an argument cmd.exe cannot carry closes with the resolver\'s line (#635)', WIN32_ONLY, async (t) => {
  const dir = await tempDir(t, 'lsp-cmd-');
  const stub = join(dir, 'lsp-stub.cmd');
  await writeFile(stub, `@"${process.execPath}" "${LSP_STUB}" %*\r\n`);
  const { proc } = start(stub, { args: [] });
  t.after(() => proc.stop());
  const a = fakePeer();
  proc.join(a);
  proc.fromPeer(a, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(((await answer(a, 1)).result as { rootUri: string }).rootUri, 'file:///w/root');
  const refused = start(stub, { args: ['100%'] }).proc;
  const b = fakePeer();
  refused.join(b);
  await until(() => b.closed !== undefined);
  assert.equal(b.closed?.code, 1011);
  assert.match(b.closed?.reason ?? '', /cmd\.exe cannot pass argument 1/);
});

test('a bare name found nowhere closes its clients with spawn ENOENT, after the constructor returns (#635)', async () => {
  const { proc, gone } = start('hive-no-such-server');
  const a = fakePeer();
  proc.join(a); // joined after the constructor: the close still reaches it
  await until(() => a.closed !== undefined);
  assert.deepEqual(a.closed, { code: 1011, reason: 'spawn stub ENOENT' });
  assert.ok(gone());
});
