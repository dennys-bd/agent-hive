import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKERS } from '../src/checkers.js';
import { FORMATTERS } from '../src/formatters.js';
import { type Arch, extensionOf, inScope, LANGUAGES, type Launch, languageOf, languagesOfServer, lspLanguageId, requiredTools, runtimeTools, type ServerDef, serverDef, SERVERS, serverFor, SYNTAXES } from '../src/languages.js';
import type { ServerId } from '../src/types.js';
import { LANGUAGE_IDS, SERVER_IDS, SYNTAX_IDS } from '../src/types.js';

const AT = { dir: '/h/editor/servers/x', arch: 'arm64' as const, platform: 'darwin' as const, version: '21.1.0' };

test('the catalog lists every language, server and syntax id once, in their ids\' order; every syntax package and every server belongs to a language (#780)', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), [...LANGUAGE_IDS]);
  assert.deepEqual(SERVERS.map((s) => s.id), [...SERVER_IDS]);
  assert.deepEqual(SYNTAXES.map((s) => s.id), [...SYNTAX_IDS]);
  for (const id of SERVER_IDS) assert.ok(LANGUAGES.some((l) => l.server === id) || CHECKERS.some((c) => c.kind === 'lsp' && c.server === id), id);
  for (const id of SYNTAX_IDS) assert.ok(LANGUAGES.some((l) => l.syntax === id), id);
  assert.ok(LANGUAGES.every((l) => l.extensions.every((e) => /^\.[a-z0-9]+$/.test(e))));
});

test('every supported formatter\'s extension maps to exactly one language; .vue and .graphql to other (#780)', () => {
  for (const ext of FORMATTERS.flatMap((def) => def.extensions)) {
    assert.equal(LANGUAGES.filter((l) => l.extensions.includes(ext)).length, 1, ext);
  }
  assert.deepEqual([languageOf('/w/App.vue'), languageOf('/w/q.graphql')], ['other', 'other']);
});

test('languageOf lowercases the extension, answers undefined for one no language has, and takes other for an extension its custom formatters list (#780)', () => {
  assert.deepEqual([languageOf('/w/a.PY'), languageOf('/w/b.mm'), languageOf('/w/c.h'), languageOf('/w/Makefile')], ['python', 'objective-c', 'cpp', undefined]);
  assert.equal(languageOf('/w/a.proto'), undefined);
  assert.equal(languageOf('/w/a.proto', ['.proto']), 'other');
  assert.equal(extensionOf('/w/a.d.TS'), '.ts');
});

test('inScope: all takes any workspace, a list its own names, an empty list none (#780)', () => {
  assert.deepEqual([inScope('all', 'web'), inScope(['hive'], 'hive'), inScope(['hive'], 'web'), inScope([], 'hive')], [true, true, false, false]);
});

test('serverFor picks web\'s binary by extension; cpp and objective-c share clangd; markdown has none (#780)', () => {
  assert.equal(serverFor('web', '.css')?.binary, 'vscode-css-language-server');
  assert.equal(serverFor('web', '.SCSS')?.binary, 'vscode-css-language-server');
  assert.equal(serverFor('web', '.jsonc')?.binary, 'vscode-json-language-server');
  assert.deepEqual([serverFor('cpp', '.c')?.server.id, serverFor('objective-c', '.m')?.server.id], ['clangd', 'clangd']);
  assert.deepEqual(languagesOfServer('clangd'), ['cpp', 'objective-c']);
  assert.equal(serverFor('markdown', '.md'), undefined);
});

test('a server launches from its folder: npm through node and its .bin, GitHub binaries by their archive\'s path, gopls from GOBIN (#780)', () => {
  assert.deepEqual(serverDef('pyright').launch(AT, 'pyright-langserver'), { command: 'node', args: ['/h/editor/servers/x/node_modules/.bin/pyright-langserver', '--stdio'] });
  assert.deepEqual(serverDef('clangd').launch(AT, 'clangd'), { command: '/h/editor/servers/x/clangd_21.1.0/bin/clangd', args: [] });
  assert.deepEqual(serverDef('taplo').launch(AT, 'taplo'), { command: '/h/editor/servers/x/bin/taplo', args: ['lsp', 'stdio'] });
  assert.deepEqual(serverDef('gopls').launch(AT, 'gopls'), { command: '/h/editor/servers/x/bin/gopls', args: [] });
  assert.equal(serverDef('rust-analyzer').asset?.('2025-10-06', 'x64', 'darwin'), 'rust-analyzer-x86_64-apple-darwin.gz');
  assert.equal(serverDef('lua-language-server').asset?.('3.15.0', 'arm64', 'darwin'), 'lua-language-server-3.15.0-darwin-arm64.tar.gz');
  assert.equal(serverDef('clangd').asset?.('21.1.0', 'arm64', 'darwin'), 'clangd-mac-21.1.0.zip');
});

test('typescript-language-server installs typescript 6: typescript 7 ships no tsserver and the server refuses to start on it (#780 catalog check)', () => {
  assert.deepEqual(serverDef('typescript-language-server').packages, ['typescript-language-server', 'typescript@6']);
});

test('requiredTools and runtimeTools: npm needs node and npm to install, node to run; gopls needs go; a GitHub binary nothing (#780)', () => {
  assert.deepEqual([requiredTools(serverDef('pyright')), requiredTools(serverDef('gopls')), requiredTools(serverDef('clangd'))], [['node', 'npm'], ['go'], []]);
  assert.deepEqual([runtimeTools(serverDef('pyright')), runtimeTools(serverDef('gopls'))], [['node'], []]);
});

test('lspLanguageId names a file as LSP servers expect it (#780)', () => {
  assert.deepEqual(['a.tsx', 'b.mjs', 'c.h', 'd.mm', 'e.sh', 'f.yml', 'g.py', 'h.txt'].map(lspLanguageId),
    ['typescriptreact', 'javascript', 'c', 'objective-cpp', 'shellscript', 'yaml', 'python', 'plaintext']);
});

test('the checkers\' servers (#782): biome, eslint and oxlint through node, ruff and tflint from their archives, dart from PATH', () => {
  assert.deepEqual(serverDef('biome').launch(AT, 'biome'), { command: 'node', args: ['/h/editor/servers/x/node_modules/.bin/biome', 'lsp-proxy'] });
  assert.deepEqual(serverDef('eslint').binaries, ['vscode-eslint-language-server']);
  assert.deepEqual(serverDef('oxlint').args, ['--lsp']);
  assert.deepEqual(serverDef('ruff').launch(AT, 'ruff'), { command: '/h/editor/servers/x/ruff-aarch64-apple-darwin/ruff', args: ['server'] });
  assert.equal(serverDef('ruff').asset?.('0.13.2', 'x64', 'darwin'), 'ruff-x86_64-apple-darwin.tar.gz');
  assert.equal(serverDef('tflint').asset?.('0.59.1', 'x64', 'darwin'), 'tflint_darwin_amd64.zip');
  assert.deepEqual(serverDef('tflint').launch(AT, 'tflint'), { command: '/h/editor/servers/x/tflint', args: ['--langserver'] });
  assert.deepEqual(serverDef('dart').launch(AT, 'dart'), { command: 'dart', args: ['language-server', '--protocol=lsp'] });
  assert.deepEqual([requiredTools(serverDef('dart')), runtimeTools(serverDef('dart'))], [['dart'], ['dart']]);
});

const D = '/h/editor/servers/x';
const V = '21.1.0';
const ARCHES = ['arm64', 'x64'] as const;
const same = (launch: Launch): Record<Arch, Launch> => ({ arm64: launch, x64: launch });
const node = (binary: string, ...args: string[]): Record<Arch, Launch> => same({ command: 'node', args: [`${D}/node_modules/.bin/${binary}`, ...args] });
const exe = (command: string, ...args: string[]): Record<Arch, Launch> => same({ command, args });
const both = (asset: string): Record<Arch, string> => ({ arm64: asset, x64: asset });
interface Pin { asset?: Record<Arch, string>; launch: Record<Arch, Launch> }

// What darwin answers on 2026-11-06, for both Macs (#635): the Windows recipes must leave every line of it as it is
const DARWIN: Record<string, Pin> = {
  'typescript-language-server/typescript-language-server': { launch: node('typescript-language-server', '--stdio') },
  'pyright/pyright-langserver': { launch: node('pyright-langserver', '--stdio') },
  'gopls/gopls': { launch: exe(`${D}/bin/gopls`) },
  'rust-analyzer/rust-analyzer': { asset: { arm64: 'rust-analyzer-aarch64-apple-darwin.gz', x64: 'rust-analyzer-x86_64-apple-darwin.gz' }, launch: exe(`${D}/bin/rust-analyzer`) },
  'clangd/clangd': { asset: both('clangd-mac-21.1.0.zip'), launch: exe(`${D}/clangd_21.1.0/bin/clangd`) },
  'lua-language-server/lua-language-server': { asset: { arm64: 'lua-language-server-21.1.0-darwin-arm64.tar.gz', x64: 'lua-language-server-21.1.0-darwin-x64.tar.gz' }, launch: exe(`${D}/bin/lua-language-server`) },
  'taplo/taplo': { asset: { arm64: 'taplo-darwin-aarch64.gz', x64: 'taplo-darwin-x86_64.gz' }, launch: exe(`${D}/bin/taplo`, 'lsp', 'stdio') },
  'yaml-language-server/yaml-language-server': { launch: node('yaml-language-server', '--stdio') },
  'bash-language-server/bash-language-server': { launch: node('bash-language-server', 'start') },
  'vscode-langservers-extracted/vscode-html-language-server': { launch: node('vscode-html-language-server', '--stdio') },
  'vscode-langservers-extracted/vscode-css-language-server': { launch: node('vscode-css-language-server', '--stdio') },
  'vscode-langservers-extracted/vscode-json-language-server': { launch: node('vscode-json-language-server', '--stdio') },
  'biome/biome': { launch: node('biome', 'lsp-proxy') },
  'eslint/vscode-eslint-language-server': { launch: node('vscode-eslint-language-server', '--stdio') },
  'oxlint/oxlint': { launch: node('oxlint', '--lsp') },
  'ruff/ruff': {
    asset: { arm64: 'ruff-aarch64-apple-darwin.tar.gz', x64: 'ruff-x86_64-apple-darwin.tar.gz' },
    launch: { arm64: { command: `${D}/ruff-aarch64-apple-darwin/ruff`, args: ['server'] }, x64: { command: `${D}/ruff-x86_64-apple-darwin/ruff`, args: ['server'] } },
  },
  'tflint/tflint': { asset: { arm64: 'tflint_darwin_arm64.zip', x64: 'tflint_darwin_amd64.zip' }, launch: exe(`${D}/tflint`, '--langserver') },
  'dart/dart': { launch: exe('dart', 'language-server', '--protocol=lsp') },
};

const ROWS = SERVERS.flatMap((server) => server.binaries.flatMap((binary) => ARCHES.map((arch) => ({ server, binary, arch }))));
// The one place the platform argument is added later (#635)
const darwin = (server: ServerDef, binary: string, arch: Arch): { asset?: string; launch: Launch } =>
  ({ asset: server.asset?.(V, arch, 'darwin'), launch: server.launch({ dir: D, arch, platform: 'darwin', version: V }, binary) });

test('darwin\'s asset and launch of every server binary, pinned for both Macs (#635)', () => {
  assert.deepEqual(SERVERS.flatMap((s) => s.binaries.map((b) => `${s.id}/${b}`)), Object.keys(DARWIN));
  for (const { server, binary, arch } of ROWS) {
    const pin = DARWIN[`${server.id}/${binary}`];
    assert.deepEqual(darwin(server, binary, arch), { asset: pin.asset?.[arch], launch: pin.launch[arch] }, `${server.id}/${binary} ${arch}`);
  }
});

const W = 'C:\\h\\editor\\servers\\x';
// Checked against each repository's latest release on 2026-11-06 (spec decision 2)
const WIN32_ASSET: Partial<Record<ServerId, string>> = {
  'rust-analyzer': 'rust-analyzer-x86_64-pc-windows-msvc.zip', clangd: 'clangd-windows-21.1.0.zip', 'lua-language-server': 'lua-language-server-21.1.0-win32-x64.zip',
  taplo: 'taplo-windows-x86_64.gz', ruff: 'ruff-x86_64-pc-windows-msvc.zip', tflint: 'tflint_windows_amd64.zip',
};

test('on win32 each GitHub server answers its Windows x64 asset whatever the arch; every launch is an .exe, node on the package\'s entry or the system server\'s tool (#635)', () => {
  for (const { server, binary, arch } of ROWS) {
    assert.equal(server.asset?.(V, arch, 'win32'), WIN32_ASSET[server.id], `${server.id} ${arch}`);
    const { command, args } = server.launch({ dir: W, arch, platform: 'win32', version: V, entry: 'lib/fake-entry.js' }, binary);
    const isNode = command === 'node' && args[0].endsWith('\\lib\\fake-entry.js');
    const isTool = server.install === 'system' && command === server.source;
    assert.ok(command.endsWith('.exe') || isNode || isTool, `${server.id}/${binary}: ${command} ${args.join(' ')}`);
  }
});

test('win32 launch paths join the folder with backslashes: the archive\'s .exe, GOBIN\'s gopls.exe, node on the npm package\'s own entry (#635)', () => {
  const at = { dir: W, arch: 'arm64' as const, platform: 'win32' as const, version: V, entry: './dist/cli.js' };
  const ids: ServerId[] = ['rust-analyzer', 'clangd', 'lua-language-server', 'taplo', 'ruff', 'tflint', 'gopls'];
  assert.deepEqual(ids.map((id) => serverDef(id).launch(at, serverDef(id).binaries[0]).command), [
    `${W}\\rust-analyzer.exe`, `${W}\\clangd_21.1.0\\bin\\clangd.exe`, `${W}\\bin\\lua-language-server.exe`, `${W}\\bin\\taplo.exe`, `${W}\\ruff.exe`, `${W}\\tflint.exe`, `${W}\\bin\\gopls.exe`,
  ]);
  assert.deepEqual(serverDef('biome').launch(at, 'biome'), { command: 'node', args: [`${W}\\node_modules\\@biomejs\\biome\\dist\\cli.js`, 'lsp-proxy'] });
  assert.deepEqual(serverDef('dart').launch(at, 'dart'), { command: 'dart', args: ['language-server', '--protocol=lsp'] });
});
