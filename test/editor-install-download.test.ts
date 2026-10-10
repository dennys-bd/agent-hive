import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, constants, readdir, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { editorDir } from '../src/editor-install.js';
import { archive, json, rig, settled } from './editor-stubs.js';

const serve = (body: string, halves = false) => (res: ServerResponse): void => {
  res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)) });
  if (!halves) return void res.end(body);
  const half = Math.floor(body.length / 2);
  res.write(body.slice(0, half));
  setTimeout(() => res.end(body.slice(half)), 50);
};
const isExecutable = (path: string): Promise<boolean> => access(path, constants.X_OK).then(() => true, () => false);
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

test('a GitHub .gz asset becomes bin/<binary>, executable; progress comes from content-length (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', json({ tag_name: '2025-10-06', assets: [{ name: 'rust-analyzer-aarch64-apple-darwin.gz', browser_download_url: `${r.base}/dl/ra` }] }));
  r.routes.set('/dl/ra', serve('#!/bin/sh\necho ra\n', true));
  await r.installer.act({ kind: 'server', id: 'rust-analyzer' }, 'install');
  assert.deepEqual((await settled(r, 'rust-analyzer')).state, { state: 'installed', version: '2025-10-06' });
  assert.ok(await isExecutable(join(editorDir(r.home, { kind: 'server', id: 'rust-analyzer' }), 'bin', 'rust-analyzer')));
  const percents = r.events.flatMap((e) => (e.state.state === 'installing' ? [e.state.percent ?? 0] : []));
  assert.ok(percents.includes(100) && percents.some((p) => p > 0 && p < 100), JSON.stringify(percents));
});

test('a download with no content-length reports no percent, so the page shows an indeterminate bar (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', json({ tag_name: '2025-10-06', assets: [{ name: 'rust-analyzer-aarch64-apple-darwin.gz', browser_download_url: `${r.base}/dl/ra` }] }));
  r.routes.set('/dl/ra', (res) => { res.writeHead(200); res.write('#!/bin/sh\n'); setTimeout(() => res.end('echo ra\n'), 30); });
  const started = await r.installer.act({ kind: 'server', id: 'rust-analyzer' }, 'install');
  assert.deepEqual(started, { status: 202, state: { state: 'installing' } });
  await settled(r, 'rust-analyzer');
  assert.deepEqual(r.events.filter((e) => e.state.state === 'installing' && 'percent' in e.state), []);
});

test('a .zip and a .tar.gz asset unpack whole; a release without this Mac\'s asset fails at the lookup (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/gh/repos/clangd/clangd/releases/latest', json({ tag_name: '21.1.0', assets: [{ name: 'clangd-mac-21.1.0.zip', browser_download_url: `${r.base}/dl/clangd` }] }));
  r.routes.set('/dl/clangd', serve(archive({ 'clangd_21.1.0/bin/clangd': '#!/bin/sh' })));
  r.routes.set('/gh/repos/LuaLS/lua-language-server/releases/latest', json({ tag_name: '3.15.0', assets: [{ name: 'lua-language-server-3.15.0-darwin-arm64.tar.gz', browser_download_url: `${r.base}/dl/lua` }] }));
  r.routes.set('/dl/lua', serve(archive({ 'bin/lua-language-server': '#!/bin/sh' })));
  r.routes.set('/gh/repos/tamasfe/taplo/releases/latest', json({ tag_name: 'release-even-better-toml-0.21.0', assets: [] }));
  await r.installer.act({ kind: 'server', id: 'clangd' }, 'install');
  await r.installer.act({ kind: 'server', id: 'lua-language-server' }, 'install');
  await r.installer.act({ kind: 'server', id: 'taplo' }, 'install');
  assert.equal((await settled(r, 'clangd')).state.state, 'installed');
  assert.equal((await settled(r, 'lua-language-server')).state.state, 'installed');
  assert.ok(await isExecutable(join(editorDir(r.home, { kind: 'server', id: 'clangd' }), 'clangd_21.1.0', 'bin', 'clangd')));
  assert.ok(await isExecutable(join(editorDir(r.home, { kind: 'server', id: 'lua-language-server' }), 'bin', 'lua-language-server')));
  const taplo = (await settled(r, 'taplo')).state;
  assert.ok(taplo.state === 'failed' && taplo.step === 'lookup' && /has no asset taplo-darwin-aarch64\.gz/.test(taplo.log));
});

const MANIFEST = { contributes: { grammars: [{ language: 'python', scopeName: 'source.python', path: './syntaxes/MagicPython.tmLanguage.json' }], languages: [{ id: 'python', extensions: ['.py'], configuration: './language-configuration.json' }] } };
const vsix = (manifest: unknown): string => archive({
  'extension/package.json': JSON.stringify(manifest), 'extension/syntaxes/MagicPython.tmLanguage.json': '{"scopeName":"source.python","patterns":[]}',
  'extension/language-configuration.json': '{"comments":{"lineComment":"#"}}', 'extension/extension.js': 'console.log(1)',
});

test('a syntax package extracts only package.json and the files it names; no code of the extension lands (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/ovsx/vscode/python/latest', json({ version: '1.95.0', files: { download: `${r.base}/dl/python.vsix` } }));
  r.routes.set('/dl/python.vsix', serve(vsix(MANIFEST)));
  await r.installer.act({ kind: 'syntax', id: 'vscode.python' }, 'install');
  assert.deepEqual((await settled(r, 'vscode.python')).state, { state: 'installed', version: '1.95.0' });
  const extension = join(editorDir(r.home, { kind: 'syntax', id: 'vscode.python' }), 'extension');
  assert.deepEqual((await readdir(extension)).sort(), ['language-configuration.json', 'package.json', 'syntaxes']);
  assert.equal(await exists(join(extension, 'extension.js')), false);
});

test('a package naming a path that leaves extension/, or no grammar, fails and installs nothing (#780)', async (t) => {
  const r = await rig(t);
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
  const r = await rig(t);
  r.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', json({ tag_name: '2025-10-06', assets: [{ name: 'rust-analyzer-aarch64-apple-darwin.gz', browser_download_url: `${r.base}/dl/slow` }] }));
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
const RA = { kind: 'server', id: 'rust-analyzer' } as const;
const RA_ASSET = (url: string) => json({ tag_name: '2025-10-06', assets: [{ name: 'rust-analyzer-aarch64-apple-darwin.gz', browser_download_url: url }] });

test('a manifest path with a character unzip reads as a wildcard is refused (#780)', async (t) => {
  const r = await rig(t);
  const globby = { contributes: { grammars: [{ language: 'go', scopeName: 'source.go', path: './syntaxes/*.json' }] } };
  r.routes.set('/ovsx/vscode/go/latest', json({ version: '1.0.0', files: { download: `${r.base}/dl/go.vsix` } }));
  r.routes.set('/dl/go.vsix', serve(vsix(globby)));
  await r.installer.act({ kind: 'syntax', id: 'vscode.go' }, 'install');
  assert.match(await failureOf(r, 'vscode.go'), /wildcard/);
});

test('a download over http, one over the size cap and a version that is a path are refused with a clear error (#780)', async (t) => {
  const plain = await rig(t, undefined, { downloads: {} }); // https only
  plain.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', RA_ASSET(`${plain.base}/dl/ra`));
  await plain.installer.act(RA, 'install');
  assert.match(await failureOf(plain, 'rust-analyzer'), /not an https URL/);

  const small = await rig(t, undefined, { downloads: { allowHttp: true, maxBytes: 10 } });
  small.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', RA_ASSET(`${small.base}/dl/ra`));
  small.routes.set('/dl/ra', serve('x'.repeat(100)));
  await small.installer.act(RA, 'install');
  assert.match(await failureOf(small, 'rust-analyzer'), /over the 10 cap/);

  const evil = await rig(t);
  evil.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', json({ tag_name: '../../x', assets: [{ name: 'rust-analyzer-aarch64-apple-darwin.gz', browser_download_url: `${evil.base}/dl/ra` }] }));
  await evil.installer.act(RA, 'install');
  assert.match(await failureOf(evil, 'rust-analyzer'), /not a plain version/);
});

test('a download that stalls ends with a stall error and installs nothing (#780)', async (t) => {
  const r = await rig(t, undefined, { downloads: { allowHttp: true, idleMs: 100 } });
  r.routes.set('/gh/repos/rust-lang/rust-analyzer/releases/latest', RA_ASSET(`${r.base}/dl/slow`));
  r.routes.set('/dl/slow', (res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('x'.repeat(100)); });
  await r.installer.act(RA, 'install');
  assert.match(await failureOf(r, 'rust-analyzer'), /stalled/);
  assert.equal(await exists(editorDir(r.home, RA)), false);
});
