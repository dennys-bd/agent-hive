import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, constants, readdir, readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { editorDir, type InstallerDeps } from '../src/editor-install.js';
import { serverDef } from '../src/languages.js';
import type { ServerId } from '../src/types.js';
import { assetBody, json, type Rig, rig, settled, zipOf } from './editor-stubs.js';

const serve = (body: string | Buffer, halves = false) => (res: ServerResponse): void => {
  const bytes = Buffer.from(body);
  res.writeHead(200, { 'content-length': String(bytes.length) });
  if (!halves) return void res.end(bytes);
  const half = Math.floor(bytes.length / 2);
  res.write(bytes.subarray(0, half));
  setTimeout(() => res.end(bytes.subarray(half)), 50);
};
const isExecutable = (path: string): Promise<boolean> => access(path, constants.X_OK).then(() => true, () => false);
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

const BINARY = '#!/bin/sh\necho server\n';
const server = (id: ServerId) => ({ kind: 'server', id }) as const;
// The host's own tar and unzip (#635): PATH's, and Git's usr\bin on win32; no stub stands in for them
const host = (t: TestContext, extra: Partial<InstallerDeps> = {}): Promise<Rig> => rig(t, [], { env: () => process.env, ...extra });
const assetOf = (id: ServerId, version: string): string => serverDef(id).asset?.(version, 'arm64', process.platform) ?? '';
// Where the host's launch looks for the binary: what the archive must leave there
const launchPath = (r: Rig, id: ServerId, version: string): string =>
  serverDef(id).launch({ dir: editorDir(r.home, server(id)), arch: 'arm64', platform: process.platform, version }, id).command;

// `id`'s latest release with the host's asset at /dl/<id>: by default an archive holding the binary at its launch path
function release(r: Rig, id: ServerId, version: string, body?: (res: ServerResponse) => void): void {
  const name = assetOf(id, version);
  const entry = relative(editorDir(r.home, server(id)), launchPath(r, id, version)).split(sep).join('/');
  r.routes.set(`/gh/repos/${serverDef(id).source}/releases/latest`, json({ tag_name: version, assets: [{ name, browser_download_url: `${r.base}/dl/${id}` }] }));
  r.routes.set(`/dl/${id}`, body ?? serve(assetBody(name, entry, BINARY)));
}
const raRelease = (r: Rig, url: string, version = '2025-10-06'): void => {
  r.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', json({ tag_name: version, assets: [{ name: assetOf('rust-analyzer', version), browser_download_url: url }] }));
};

test('a lone .gz asset is gunzipped by node:zlib into bin/<binary>, executable at its launch path; progress comes from content-length (#780, #635)', async (t) => {
  const r = await host(t);
  release(r, 'taplo', '0.10.0', serve(gzipSync(BINARY), true));
  await r.installer.act(server('taplo'), 'install');
  assert.deepEqual((await settled(r, 'taplo')).state, { state: 'installed', version: '0.10.0' });
  assert.ok(await isExecutable(launchPath(r, 'taplo', '0.10.0')));
  assert.equal(await readFile(launchPath(r, 'taplo', '0.10.0'), 'utf8'), BINARY);
  const percents = r.events.flatMap((e) => (e.state.state === 'installing' ? [e.state.percent ?? 0] : []));
  assert.ok(percents.includes(100) && percents.some((p) => p > 0 && p < 100), JSON.stringify(percents));
});

test('a download with no content-length reports no percent, so the page shows an indeterminate bar (#780)', async (t) => {
  const r = await host(t);
  const gz = gzipSync(BINARY);
  release(r, 'taplo', '0.10.0', (res) => { res.writeHead(200); res.write(gz.subarray(0, 4)); setTimeout(() => res.end(gz.subarray(4)), 30); });
  const started = await r.installer.act(server('taplo'), 'install');
  assert.deepEqual(started, { status: 202, state: { state: 'installing' } });
  assert.deepEqual((await settled(r, 'taplo')).state, { state: 'installed', version: '0.10.0' });
  assert.deepEqual(r.events.filter((e) => e.state.state === 'installing' && 'percent' in e.state), []);
});

test('a .zip and a .tar.gz asset unpack whole, the binary at its launch path; a release without the host\'s asset fails at the lookup (#780, #635)', async (t) => {
  const r = await host(t);
  release(r, 'clangd', '21.1.0');
  release(r, 'lua-language-server', '3.15.0'); // .tar.gz on darwin, .zip on win32
  r.routes.set('/gh/repos/tamasfe/taplo/releases/latest', json({ tag_name: '0.10.0', assets: [] }));
  for (const id of ['clangd', 'lua-language-server', 'taplo'] as const) await r.installer.act(server(id), 'install');
  for (const [id, version] of [['clangd', '21.1.0'], ['lua-language-server', '3.15.0']] as const) {
    assert.equal((await settled(r, id)).state.state, 'installed', id);
    assert.ok(await isExecutable(launchPath(r, id, version)), id);
  }
  const taplo = (await settled(r, 'taplo')).state;
  assert.ok(taplo.state === 'failed' && taplo.step === 'lookup' && taplo.log.includes(`has no asset ${assetOf('taplo', '0.10.0')}`), JSON.stringify(taplo));
});

const MANIFEST = { contributes: { grammars: [{ language: 'python', scopeName: 'source.python', path: './syntaxes/MagicPython.tmLanguage.json' }], languages: [{ id: 'python', extensions: ['.py'], configuration: './language-configuration.json' }] } };
const vsix = (manifest: unknown): Buffer => zipOf({
  'extension/package.json': JSON.stringify(manifest), 'extension/syntaxes/MagicPython.tmLanguage.json': '{"scopeName":"source.python","patterns":[]}',
  'extension/language-configuration.json': '{"comments":{"lineComment":"#"}}', 'extension/extension.js': 'console.log(1)',
});

test('a syntax package extracts only package.json and the files it names; no code of the extension lands (#780)', async (t) => {
  const r = await host(t);
  r.routes.set('/ovsx/vscode/python/latest', json({ version: '1.95.0', files: { download: `${r.base}/dl/python.vsix` } }));
  r.routes.set('/dl/python.vsix', serve(vsix(MANIFEST)));
  await r.installer.act({ kind: 'syntax', id: 'vscode.python' }, 'install');
  assert.deepEqual((await settled(r, 'vscode.python')).state, { state: 'installed', version: '1.95.0' });
  const extension = join(editorDir(r.home, { kind: 'syntax', id: 'vscode.python' }), 'extension');
  assert.deepEqual((await readdir(extension)).sort(), ['language-configuration.json', 'package.json', 'syntaxes']);
  assert.equal(await exists(join(extension, 'extension.js')), false);
});

test('a package naming a path that leaves extension/, or no grammar, fails and installs nothing (#780)', async (t) => {
  const r = await host(t);
  const evil = { contributes: { grammars: [{ language: 'go', scopeName: 'source.go', path: '../../evil.json' }] } };
  r.routes.set('/ovsx/vscode/go/latest', json({ version: '1.0.0', files: { download: `${r.base}/dl/go.vsix` } }));
  r.routes.set('/dl/go.vsix', serve(vsix(evil)));
  r.routes.set('/ovsx/vscode/rust/latest', json({ version: '1.0.0', files: { download: `${r.base}/dl/rust.vsix` } }));
  r.routes.set('/dl/rust.vsix', serve(vsix({ contributes: { languages: [{ id: 'rust', extensions: ['.rs'] }] } })));
  await r.installer.act({ kind: 'syntax', id: 'vscode.go' }, 'install');
  await r.installer.act({ kind: 'syntax', id: 'vscode.rust' }, 'install');
  const go = (await settled(r, 'vscode.go')).state;
  const rust = (await settled(r, 'vscode.rust')).state;
  assert.ok(go.state === 'failed' && go.log.endsWith('../../evil.json: leaves extension/'));
  assert.ok(rust.state === 'failed' && rust.log.endsWith('the package names no grammar'));
  assert.equal(await exists(editorDir(r.home, { kind: 'syntax', id: 'vscode.go' })), false);
});

test('cancel during a download leaves the prior state and no temp folder (#780)', async (t) => {
  const r = await host(t);
  raRelease(r, `${r.base}/dl/slow`);
  r.routes.set('/dl/slow', (res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('x'.repeat(100)); });
  await r.installer.act({ kind: 'server', id: 'rust-analyzer' }, 'install');
  for (let i = 0; i < 200 && !r.events.some((e) => e.state.state === 'installing' && e.state.percent === 10); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await r.installer.act({ kind: 'server', id: 'rust-analyzer' }, 'cancel');
  assert.deepEqual((await settled(r, 'rust-analyzer')).state, { state: 'absent' });
  const parent = dirname(editorDir(r.home, { kind: 'server', id: 'rust-analyzer' }));
  assert.deepEqual((await readdir(parent).catch(() => [])).filter((name) => name.includes('.tmp-')), []);
});

const failureOf = async (r: Awaited<ReturnType<typeof rig>>, id: string): Promise<string> => {
  const { state } = await settled(r, id);
  assert.ok(state.state === 'failed', JSON.stringify(state));
  return state.log.split('\n').at(-1) ?? '';
};
const RA = server('rust-analyzer');

test('a manifest path with a character unzip reads as a wildcard is refused (#780)', async (t) => {
  const r = await host(t);
  const globby = { contributes: { grammars: [{ language: 'go', scopeName: 'source.go', path: './syntaxes/*.json' }] } };
  r.routes.set('/ovsx/vscode/go/latest', json({ version: '1.0.0', files: { download: `${r.base}/dl/go.vsix` } }));
  r.routes.set('/dl/go.vsix', serve(vsix(globby)));
  await r.installer.act({ kind: 'syntax', id: 'vscode.go' }, 'install');
  assert.match(await failureOf(r, 'vscode.go'), /wildcard/);
});

test('a download over http, one over the size cap and a version that is a path are refused with a clear error (#780)', async (t) => {
  const plain = await host(t, { downloads: {} }); // https only
  raRelease(plain, `${plain.base}/dl/ra`);
  await plain.installer.act(RA, 'install');
  assert.match(await failureOf(plain, 'rust-analyzer'), /not an https URL/);

  const small = await host(t, { downloads: { allowHttp: true, maxBytes: 10 } });
  raRelease(small, `${small.base}/dl/ra`);
  small.routes.set('/dl/ra', serve('x'.repeat(100)));
  await small.installer.act(RA, 'install');
  assert.match(await failureOf(small, 'rust-analyzer'), /over the 10 cap/);

  const evil = await host(t);
  raRelease(evil, `${evil.base}/dl/ra`, '../../x');
  await evil.installer.act(RA, 'install');
  assert.match(await failureOf(evil, 'rust-analyzer'), /not a plain version/);
});

test('a download that stalls ends with a stall error and installs nothing (#780)', async (t) => {
  const r = await host(t, { downloads: { allowHttp: true, idleMs: 100 } });
  raRelease(r, `${r.base}/dl/slow`);
  r.routes.set('/dl/slow', (res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('x'.repeat(100)); });
  await r.installer.act(RA, 'install');
  assert.match(await failureOf(r, 'rust-analyzer'), /stalled/);
  assert.equal(await exists(editorDir(r.home, RA)), false);
});
